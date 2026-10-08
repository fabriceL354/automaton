/** Crash recovery ONLY for the isolated pilot. V5 remains the business lock.
 * SQLite supplies an OS-released mutex so two resumes cannot remove each other's
 * lock. Never remove a live/unknown PID lock, nor repair a business store. */
import Database from "better-sqlite3";
import * as fs from "node:fs/promises";
import path from "node:path";
import { safePath } from "./local-tools.js";
import { readConfined, locked } from "./ledger-runner.js";
import { pilotContext } from "./pilot-context.js";
import { pilotStoreRoot } from "./pilot-store.js";
export async function pilotLocked<T>(root: string, operation: () => Promise<T>): Promise<T> {
  if (process.env.SCOUT_MODE !== "pilot-dry-run" || pilotContext()?.root !== root || pilotContext()?.lockHeld) throw new Error("Pilot lock scope required");
  const directory = pilotStoreRoot(root);
  await safePath(directory, "mutex.sqlite", true);
  if ((await fs.stat(directory)).mode & 0o077) throw new Error("Pilot mutex directory must be private");
  for (const file of ["mutex.sqlite", "mutex.sqlite-journal", "mutex.sqlite-wal", "mutex.sqlite-shm"]) await safePath(directory, file);
  const db = new Database(path.join(directory, "mutex.sqlite"), { timeout: 0 });
  try {
    await fs.chmod(path.join(directory, "mutex.sqlite"), 0o600);
    db.exec("BEGIN EXCLUSIVE");
    // Forces a persistent database header; there are no business rows here.
    db.pragma("user_version = 126");
    const previous = await readConfined(root, ".economic-ledger.lock", 1024);
    if (previous !== undefined) {
      const value = JSON.parse(previous);
      if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.created_at !== "string") throw new Error("Unknown V5 lock owner; inspection required");
      let dead = false;
      try { process.kill(value.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") dead = true; else throw e; }
      if (!dead) throw new Error("Ledger locked by live/unknown owner");
      // Every pilot writer enters this exclusive mutex before the existing lock.
      if (await readConfined(root, ".economic-ledger.lock", 1024) !== previous) throw new Error("Lock owner changed");
      await fs.unlink(await safePath(root, ".economic-ledger.lock"));
    }
    return await locked(root, operation);
  } finally { if (db.inTransaction) db.exec("COMMIT"); db.close(); }
}
