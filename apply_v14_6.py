#!/usr/bin/env python3
"""Install Scout V14.6 on the exact V14.5 base, with verified rollback.
No commit/push. Recovery journal survives process interruption in the Git directory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys

EXPECTED = "02f3194fd417c6363d1f903a2ba89985b7832ec7"
FILES = [
    "src/agent/coordination-model.ts",
    "src/agent/coordination-preview.ts",
    "src/__tests__/scout-coordination-preview.test.ts",
    "apply_v14_6.py",
    "scripts/test_apply_v14_6.py",
    "README_SCOUT_V14_6.md",
]
TARGETS = FILES + ["src/index.ts", "src/agent/local-tools.ts"]
INDEX_ANCHOR = '''  if (!["--help", "-h", "--version", "-v"].includes(args[0]) && process.env.SCOUT_MODE === "pilot-dry-run") {'''
INDEX_ADDED = '''  if (!["--help", "-h", "--version", "-v"].includes(args[0]) && process.env.SCOUT_MODE === "coordination-preview") {
    const { runCoordinationPreview } = await import("./agent/coordination-preview.js");
    const result = await runCoordinationPreview(args);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "PASS") process.exitCode = 2;
    return;
  }
'''
LOCAL_ANCHOR = '''        if (/^\\.?approval(?:[.-]|$)/i.test(path.basename(path.resolve(root, args.path)))) {'''
LOCAL_ADDED = '''        if (/^\\.?coordination-preview(?:[.-]|$)/i.test(path.basename(path.resolve(root, args.path)))) {
          return "ERROR: coordination preview files are runtime-controlled";
        }
'''


def git(repo, *args):
    cp = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=30)
    if cp.returncode:
        raise RuntimeError("Git refused " + " ".join(args) + ": " + cp.stderr.strip()[:300])
    return cp.stdout.strip()


def check_base(repo):
    if git(repo, "rev-parse", "--show-toplevel") != str(repo):
        raise RuntimeError("REFUSED: --repo must be the repository root")
    if git(repo, "branch", "--show-current") != "local-ollama-only":
        raise RuntimeError("REFUSED: current branch is not local-ollama-only")
    if git(repo, "rev-parse", "HEAD") != EXPECTED:
        raise RuntimeError("REFUSED: unexpected HEAD; never reset or overwrite user work")


def regular(repo, rel):
    target = repo / rel
    for parent in target.parents:
        if parent == repo.parent:
            break
        if parent.is_symlink() or not parent.is_dir():
            raise RuntimeError("REFUSED: unsafe parent for " + rel)
    if target.is_symlink():
        raise RuntimeError("REFUSED: symlink " + rel)
    if target.exists():
        info = target.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError("REFUSED: nonregular/hardlink " + rel)
    return target


def snapshot(target):
    if not target.exists():
        return None
    return {"sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            "mode": stat.S_IMODE(target.stat().st_mode)}


def sync_dir(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_durable(target, data, mode=0o600):
    with target.open("xb") as handle:
        handle.write(data)
        os.fchmod(handle.fileno(), mode)
        handle.flush()
        os.fsync(handle.fileno())


def journal_path(repo):
    directory = Path(git(repo, "rev-parse", "--absolute-git-dir"))
    return directory / "scout-v14-6-transaction"


def restore(repo, journal):
    """Preflight EVERY file before restoring any; unknown edits are never overwritten."""
    if journal.is_symlink() or not journal.is_dir():
        raise RuntimeError("REFUSED: no regular recovery journal")
    manifest = json.loads(regular(journal, "manifest.json").read_text())
    if manifest["base"] != EXPECTED or manifest["repo"] != str(repo):
        raise RuntimeError("REFUSED: recovery journal belongs to another base/repository")
    entries = manifest["entries"]
    if [entry["path"] for entry in entries] != TARGETS:
        raise RuntimeError("REFUSED: unexpected recovery targets")
    for i, entry in enumerate(entries):
        current = snapshot(regular(repo, entry["path"]))
        if current != entry["old"] and current != entry["new"]:
            raise RuntimeError("REFUSED: changed since installation: " + entry["path"])
        if entry["old"] is not None:
            if snapshot(regular(journal, f"old-{i}")) != entry["old"]:
                raise RuntimeError("REFUSED: backup integrity failure: " + entry["path"])
    for i, entry in reversed(list(enumerate(entries))):
        target = regular(repo, entry["path"])
        if snapshot(target) == entry["old"]:
            continue
        if entry["old"] is None:
            target.unlink()
        else:
            stage = journal / f"restore-{i}"
            # A previous interrupted recovery may have left this known staging file.
            if stage.exists():
                if snapshot(regular(journal, stage.name)) != entry["old"]:
                    raise RuntimeError("REFUSED: recovery staging integrity failure")
                stage.unlink()
            write_durable(stage, (journal / f"old-{i}").read_bytes(), entry["old"]["mode"])
            os.replace(stage, target)
        sync_dir(target.parent)
    for entry in entries:
        if snapshot(regular(repo, entry["path"])) != entry["old"]:
            raise RuntimeError("RESTORATION VERIFICATION FAILED; retain journal " + str(journal))
    shutil.rmtree(journal)
    sync_dir(journal.parent)


def apply(repo, bundle, check=False):
    check_base(repo)
    journal = journal_path(repo)
    if journal.exists() or journal.is_symlink():
        raise RuntimeError("REFUSED: recovery journal exists; use --recover before retrying: " + str(journal))
    if git(repo, "status", "--porcelain", "--untracked-files=all"):
        raise RuntimeError("REFUSED: repository must be clean, including untracked files; keep bundle outside it")
    planned = {}
    for rel in FILES:
        if regular(repo, rel).exists():
            raise RuntimeError("REFUSED: target exists " + rel)
        source = regular(bundle, rel)
        if not source.is_file():
            raise RuntimeError("REFUSED: missing payload " + rel)
        planned[rel] = source.read_bytes()
    for rel, anchor, added in [("src/index.ts", INDEX_ANCHOR, INDEX_ADDED),
                                ("src/agent/local-tools.ts", LOCAL_ANCHOR, LOCAL_ADDED)]:
        source = regular(repo, rel).read_bytes()
        text = source.decode("utf-8")
        if text.count(anchor) != 1:
            raise RuntimeError("REFUSED: anchor not unique " + rel)
        planned[rel] = text.replace(anchor, added + anchor).encode("utf-8")
    if check:
        print("CHECK OK: exact base, clean repository, all payloads, regular parents and unique anchors. No changes.")
        return
    journal.mkdir(mode=0o700)  # Exclusive lock for cooperating installer invocations.
    prepared = False
    try:
        entries = []
        for i, rel in enumerate(TARGETS):
            target = regular(repo, rel)
            old = snapshot(target)
            if old is not None:
                write_durable(journal / f"old-{i}", target.read_bytes(), old["mode"])
            mode = old["mode"] if old is not None else 0o644
            stage = journal / f"new-{i}"
            write_durable(stage, planned[rel], mode)
            entries.append({"path": rel, "old": old, "new": snapshot(stage)})
        manifest = {"base": EXPECTED, "repo": str(repo), "entries": entries}
        write_durable(journal / "manifest.json", (json.dumps(manifest) + "\n").encode())
        sync_dir(journal)
        sync_dir(journal.parent)
        prepared = True
        # All backups and the journal are durable BEFORE the first repository write.
        for i, entry in enumerate(entries):
            target = regular(repo, entry["path"])
            if snapshot(target) != entry["old"]:
                raise RuntimeError("REFUSED: target changed before installation")
            os.replace(journal / f"new-{i}", target)
            sync_dir(target.parent)
        for entry in entries:
            if snapshot(regular(repo, entry["path"])) != entry["new"]:
                raise RuntimeError("Installed bytes/mode verification failed")
    except BaseException:
        if prepared:
            try:
                restore(repo, journal)
            except BaseException as recovery_error:
                raise RuntimeError("INCOMPLETE: stop edits; retain journal and run --recover: " + str(journal)) from recovery_error
        else:
            shutil.rmtree(journal)
        raise
    print("APPLIED AND VERIFIED: 8 files, no commit/push. Backup retained: " + str(journal))
    print("Before any commit, --recover restores and verifies all original bytes/modes. Run build and tests first.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--recover", action="store_true", help="restore verified originals before committing; stop concurrent edits first")
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    args = parser.parse_args()
    repo = args.repo.resolve()
    if args.recover:
        check_base(repo)
        restore(repo, journal_path(repo))
        print("RESTORED AND VERIFIED: original bytes/modes, new targets absent. No commit/push.")
    else:
        apply(repo, Path(__file__).resolve().parent, check=args.check)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
