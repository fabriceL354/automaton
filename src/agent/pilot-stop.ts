/** V12.8 terminal stop latch. Existence alone blocks writers, including an
 * incomplete/corrupt latch. Independent of the business lock and its history.
 * There is deliberately no resume/delete command. OS owner is the trust boundary. */
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { canonicalHash, exact, same, time } from "./project-model.js";
import { safePath } from "./local-tools.js";
import { atomicWrite, readConfined } from "./ledger-runner.js";
export const STOP_REASONS = ["operator-stop", "budget-concern", "evidence-concern", "security-concern"] as const;
export type StopReason = typeof STOP_REASONS[number];
export function pilotStopRoot(root: string) { return path.join(path.dirname(root), `.scout-pilot-stop-${canonicalHash(root).slice(0, 32)}`); }
export function normalizedPilotRoot(root: string) {
  if (!path.isAbsolute(root) || root !== path.normalize(root) || root === path.parse(root).root) throw new Error("Normalized absolute pilot workspace required");
  return root;
}
export async function pilotStopped(root: string): Promise<boolean> {
  try { await fs.lstat(pilotStopRoot(root)); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
export async function assertPilotNotStopped(root: string) {
  if (await pilotStopped(root)) throw new Error("EMERGENCY_STOP");
}
async function syncDirectory(dir: string) {
  const fd = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}
export async function pilotStopView(root: string) {
  if (!await pilotStopped(root)) return { stopped: false, receipt_status: "ABSENT", receipt: null } as const;
  try {
    const store = pilotStopRoot(root);
    await safePath(store, "receipt.json");
    if ((await fs.stat(store)).mode & 0o077) throw new Error("Private latch required");
    const raw = await readConfined(store, "receipt.json", 4096);
    if (!raw) throw new Error("Incomplete latch");
    const d = exact(JSON.parse(raw), ["receipt", "hash"]);
    const r = exact(d.receipt, ["version", "workspace", "stopped_at", "reason", "terminal", "execution_performed"]);
    time(r.stopped_at);
    if (r.version !== "12.8" || r.workspace !== root || !STOP_REASONS.includes(r.reason as StopReason) || r.terminal !== true || r.execution_performed !== false || d.hash !== canonicalHash(r)) throw new Error("Invalid latch receipt");
    return { stopped: true, receipt_status: "CHECKSUM_VALID_OS_TRUSTED", receipt: r } as const;
  } catch { return { stopped: true, receipt_status: "INCOMPLETE_OR_INVALID_HUMAN_INSPECTION_REQUIRED", receipt: null } as const; }
}
export async function haltPilot(root: string, reason: StopReason, at: string) {
  normalizedPilotRoot(root); time(at);
  if (!STOP_REASONS.includes(reason)) throw new Error("Fixed stop reason required");
  // Validate the directory itself, never the possibly damaged lock target.
  // A hostile symlink/hardlink at the lock must not prevent the stop latch.
  if (await fs.realpath(root) !== root || !(await fs.lstat(root)).isDirectory()) throw new Error("Unsafe pilot workspace");
  const store = pilotStopRoot(root);
  try { await fs.mkdir(store, { mode: 0o700 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") { await syncDirectory(path.dirname(store)); return pilotStopView(root); } throw e; }
  // Persist the blocking latch BEFORE writing its descriptive receipt. A crash
  // at any later point leaves an explicit, fail-closed stop, never an auto-resume.
  await syncDirectory(path.dirname(store));
  const receipt = { version: "12.8", workspace: root, stopped_at: at, reason, terminal: true, execution_performed: false };
  const data = { receipt, hash: canonicalHash(receipt) }, raw = JSON.stringify(data, null, 2) + "\n";
  await atomicWrite(store, "receipt.json", raw, value => { if (!same(JSON.parse(value), data)) throw new Error("Stop receipt mismatch"); });
  return pilotStopView(root);
}
