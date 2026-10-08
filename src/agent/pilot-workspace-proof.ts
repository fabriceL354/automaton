/** Read-only byte/name fingerprint; never follows links into user data. */
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export async function workspaceFingerprint(root: string) {
  const hash = createHash("sha256"); let files = 0, bytes = 0;
  async function visit(relative: string): Promise<void> {
    const full = path.join(root, relative);
    let stat; try { stat = await fs.lstat(full); } catch (e) { if (relative === "" && (e as NodeJS.ErrnoException).code === "ENOENT") { hash.update("ABSENT"); return; } throw e; }
    if (++files > 10000) throw new Error("Workspace fingerprint file bound");
    hash.update(JSON.stringify([relative, stat.mode]));
    if (stat.isSymbolicLink()) { hash.update(await fs.readlink(full)); return; }
    if (stat.isDirectory()) { for (const name of (await fs.readdir(full)).sort()) await visit(path.join(relative, name)); return; }
    if (!stat.isFile()) throw new Error("Unsupported workspace entry; cannot prove unchanged");
    bytes += stat.size; if (bytes > 512 * 1024 * 1024) throw new Error("Workspace fingerprint byte bound");
    const fd = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await fd.stat(); if (before.ino !== stat.ino || before.dev !== stat.dev) throw new Error("Workspace changed during fingerprint");
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) { const read = await fd.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break; hash.update(buffer.subarray(0, read.bytesRead)); }
      const after = await fd.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Workspace changed during fingerprint");
    } finally { await fd.close(); }
  }
  await visit(""); return hash.digest("hex");
}
