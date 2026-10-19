#!/usr/bin/env python3
"""Offline regression tests. Only disposable repositories on local-ollama-only/other."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("scout_installer", ROOT / "apply_v14_6.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="scout-installer-test-")
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.repo, self.bundle = base / "repo", base / "bundle"
        self.repo.mkdir()
        self.bundle.mkdir()
        self.git("init", "-b", "local-ollama-only")
        for parent in ["src/agent", "src/__tests__", "scripts"]:
            (self.repo / parent).mkdir(parents=True, exist_ok=True)
        (self.repo / "src/index.ts").write_text("// initial index\n" + installer.INDEX_ANCHOR + "\n")
        (self.repo / "src/agent/local-tools.ts").write_text("// initial tools\n" + installer.LOCAL_ANCHOR + "\n")
        (self.repo / "scripts/keep.txt").write_text("preserve this unrelated file\n")
        os.chmod(self.repo / "src/index.ts", 0o755)
        self.git("add", ".")
        self.git("-c", "user.name=Regression", "-c", "user.email=regression@example.invalid", "commit", "-m", "Disposable fixture")
        self.head = self.git("rev-parse", "HEAD")
        self.expected_patch = patch.object(installer, "EXPECTED", self.head)
        self.expected_patch.start()
        self.addCleanup(self.expected_patch.stop)
        for rel in installer.FILES:
            dst = self.bundle / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / rel, dst)
        self.original = self.tree()

    def git(self, *args):
        result = subprocess.run(["git", "-C", str(self.repo), *args], capture_output=True, text=True, check=True)
        return result.stdout.strip()

    def tree(self):
        return {str(p.relative_to(self.repo)): installer.snapshot(p)
                for p in self.repo.rglob("*") if p.is_file() and ".git" not in p.relative_to(self.repo).parts}

    def assert_restored(self):
        self.assertEqual(self.tree(), self.original)
        self.assertEqual(self.git("status", "--porcelain", "--untracked-files=all"), "")
        self.assertEqual(self.git("rev-parse", "HEAD"), self.head)
        self.assertFalse(installer.journal_path(self.repo).exists())

    def test_check_is_read_only(self):
        installer.apply(self.repo, self.bundle, check=True)
        self.assert_restored()

    def test_success_then_verified_recovery(self):
        installer.apply(self.repo, self.bundle)
        for rel in installer.FILES:
            self.assertEqual((self.repo / rel).read_bytes(), (self.bundle / rel).read_bytes())
        self.assertIn(installer.INDEX_ADDED, (self.repo / "src/index.ts").read_text())
        self.assertIn(installer.LOCAL_ADDED, (self.repo / "src/agent/local-tools.ts").read_text())
        with self.assertRaisesRegex(RuntimeError, "journal exists"):
            installer.apply(self.repo, self.bundle)
        installer.restore(self.repo, installer.journal_path(self.repo))
        self.assert_restored()

    def test_payload_write_failure_changes_no_repository_files(self):
        real_write = installer.write_durable
        count = 0
        def fail_stage(*args, **kwargs):
            nonlocal count
            count += 1
            if count == 4:
                raise OSError("injected full disk during staging")
            return real_write(*args, **kwargs)
        with patch.object(installer, "write_durable", side_effect=fail_stage):
            with self.assertRaises(OSError):
                installer.apply(self.repo, self.bundle)
        self.assert_restored()

    def test_user_edits_prevent_any_recovery_writes(self):
        installer.apply(self.repo, self.bundle)
        (self.repo / "src/index.ts").write_text("new operator work\n")
        before = self.tree()
        with self.assertRaisesRegex(RuntimeError, "changed since installation"):
            installer.restore(self.repo, installer.journal_path(self.repo))
        self.assertEqual(self.tree(), before)
        self.assertTrue(installer.journal_path(self.repo).exists())

    def test_corrupt_backup_prevents_any_recovery_writes(self):
        installer.apply(self.repo, self.bundle)
        journal = installer.journal_path(self.repo)
        (journal / "old-6").write_text("corrupted original")
        before = self.tree()
        with self.assertRaisesRegex(RuntimeError, "backup integrity"):
            installer.restore(self.repo, journal)
        self.assertEqual(self.tree(), before)

    def test_interrupted_recovery_can_be_retried(self):
        installer.apply(self.repo, self.bundle)
        journal = installer.journal_path(self.repo)
        real_replace = installer.os.replace
        count = 0
        def fail_once(*args):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError("injected restoration failure")
            return real_replace(*args)
        with patch.object(installer.os, "replace", side_effect=fail_once):
            with self.assertRaises(OSError):
                installer.restore(self.repo, journal)
        self.assertTrue(journal.exists())
        installer.restore(self.repo, journal)
        self.assert_restored()

    def test_hard_process_exit_leaves_recoverable_journal(self):
        code = '''
import importlib.util, os, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("child_installer", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.EXPECTED = sys.argv[4]
real_replace = m.os.replace
counter = 0
def crash_after_three(*args):
 global counter
 counter += 1
 if counter == 4: os._exit(73)
 return real_replace(*args)
m.os.replace = crash_after_three
m.apply(Path(sys.argv[2]), Path(sys.argv[3]))
'''
        result = subprocess.run([sys.executable, "-c", code, str(ROOT / "apply_v14_6.py"),
                                 str(self.repo), str(self.bundle), self.head], capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 73, result.stderr.decode())
        self.assertNotEqual(self.tree(), self.original)
        installer.restore(self.repo, installer.journal_path(self.repo))
        self.assert_restored()

    def test_refuses_wrong_branch(self):
        self.git("checkout", "-b", "other")
        with self.assertRaisesRegex(RuntimeError, "branch"):
            installer.apply(self.repo, self.bundle)
        self.assertEqual(self.tree(), self.original)

    def test_refuses_wrong_commit(self):
        with patch.object(installer, "EXPECTED", "0" * 40):
            with self.assertRaisesRegex(RuntimeError, "unexpected HEAD"):
                installer.apply(self.repo, self.bundle)
        self.assert_restored()

    def test_refuses_dirty_or_untracked_work(self):
        for rel in ["src/index.ts", "unrelated-new.txt"]:
            with self.subTest(path=rel):
                target = self.repo / rel
                old = target.read_bytes() if target.exists() else None
                target.write_text("operator changes")
                before = self.tree()
                with self.assertRaisesRegex(RuntimeError, "must be clean"):
                    installer.apply(self.repo, self.bundle)
                self.assertEqual(self.tree(), before)
                if old is None: target.unlink()
                else: target.write_bytes(old)
        self.assert_restored()

    def test_missing_payload_changes_nothing(self):
        (self.bundle / installer.FILES[-1]).unlink()
        with self.assertRaisesRegex(RuntimeError, "missing payload"):
            installer.apply(self.repo, self.bundle)
        self.assert_restored()

    def test_symlink_parent_changes_nothing(self):
        parent = self.repo / "src/__tests__"
        parent.rmdir()
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        parent.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "unsafe parent"):
            installer.regular(self.repo, "src/__tests__/scout-coordination-preview.test.ts")
        with self.assertRaisesRegex(RuntimeError, "must be clean|unsafe parent"):
            installer.apply(self.repo, self.bundle)
        self.assertEqual(list(outside.iterdir()), [])
        parent.unlink(); parent.mkdir()
        self.assert_restored()

    def test_hardlink_existing_target_changes_nothing(self):
        outside = Path(self.temp.name) / "index-hardlink"
        os.link(self.repo / "src/index.ts", outside)
        with self.assertRaisesRegex(RuntimeError, "hardlink"):
            installer.apply(self.repo, self.bundle)
        outside.unlink()
        self.assert_restored()


def replacement_failure_test(failure_index):
    def regression(self):
        real_replace = installer.os.replace
        count = 0
        def fail_once(*args):
            nonlocal count
            count += 1
            if count == failure_index:
                raise OSError("injected replacement failure")
            return real_replace(*args)
        with patch.object(installer.os, "replace", side_effect=fail_once):
            with self.assertRaises(OSError):
                installer.apply(self.repo, self.bundle)
        self.assert_restored()
    return regression


for index in range(1, len(installer.TARGETS) + 1):
    setattr(InstallerTests, f"test_rollback_after_replace_failure_{index}", replacement_failure_test(index))

if __name__ == "__main__":
    unittest.main(verbosity=2)
