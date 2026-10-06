/** V10 private authenticated journal using V5 confinement/atomic-write primitives.
 * No economic, V9 or external files are written by this module. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { safePath } from "./local-tools.js";
import { readConfined, atomicWrite } from "./ledger-runner.js";
import { exact, hex, digest, structured, same } from "./project-model.js";
import { MONITORING_LIMITS, type ObservationEvent } from "./monitoring-model.js";
export const MONITORING_FILES = ["monitoring-history.json", "monitoring-report.txt"];
export interface ObservationState { version: 10; workspace: string; phase: "prepared" | "complete"; events: ObservationEvent[] }
export function observationStoreRoot(root: string): string { return path.join(path.dirname(path.resolve(root)), `.scout-monitoring-${digest(path.resolve(root)).slice(0, 32)}`); }
const mac = (state: ObservationState, key: Buffer) => createHmac("sha256", key).update(JSON.stringify(state)).digest("hex");
function decode(raw: string, root: string, key: Buffer): ObservationState {
  const d = exact(JSON.parse(raw), ["version", "workspace", "phase", "events", "mac"]);
  const state = { version: d.version, workspace: d.workspace, phase: d.phase, events: d.events } as ObservationState;
  if (!timingSafeEqual(Buffer.from(hex(d.mac), "hex"), Buffer.from(mac(state, key), "hex"))) throw new Error("Monitoring history authentication failed");
  if (state.version !== 10 || state.workspace !== root || !["prepared", "complete"].includes(state.phase) || !Array.isArray(state.events) || !state.events.length || state.events.length > MONITORING_LIMITS.MAX_TOTAL_EVENTS) throw new Error("Invalid monitoring history");
  return state;
}
export async function loadObservationState(root: string): Promise<{ state?: ObservationState; key?: Buffer }> {
  const store = observationStoreRoot(root);
  try { await fs.lstat(store); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
  await safePath(store, "state.json");
  if (((await fs.stat(store)).mode & 0o077) !== 0) throw new Error("Monitoring store must be private (0700)");
  const keyRaw = await readConfined(store, "integrity-key", 65), raw = await readConfined(store, "state.json", MONITORING_LIMITS.MAX_HISTORY_SIZE);
  if (!keyRaw || raw === undefined || !/^[a-f0-9]{64}\n$/.test(keyRaw)) throw new Error("Incomplete monitoring anchor; human inspection required");
  for (const name of ["integrity-key", "state.json"]) if (((await fs.stat(await safePath(store, name))).mode & 0o077) !== 0) throw new Error("Monitoring files must be private (0600)");
  const key = Buffer.from(keyRaw.trim(), "hex"), state = decode(raw, root, key);
  if (state.phase !== "complete") throw new Error("Incomplete monitoring transaction; human inspection required; no automatic repair");
  return { state, key };
}
function views(events: ObservationEvent[], report: string | undefined): (string | undefined)[] {
  return events.length ? [structured({ version: 10, events }), report] : [undefined, undefined];
}
export async function checkObservationViews(root: string, events: ObservationEvent[], report: string | undefined): Promise<void> {
  const expected = views(events, report);
  for (const [i, name] of MONITORING_FILES.entries()) {
    if (await readConfined(root, name, i ? MONITORING_LIMITS.MAX_REPORT_SIZE : MONITORING_LIMITS.MAX_HISTORY_SIZE) !== expected[i]) throw new Error(`Modified, missing or orphan ${name}`);
  }
}
async function persist(root: string, state: ObservationState, key: Buffer) {
  const raw = structured({ ...state, mac: mac(state, key) });
  if (Buffer.byteLength(raw) > MONITORING_LIMITS.MAX_HISTORY_SIZE) throw new Error("Monitoring history size limit");
  await atomicWrite(observationStoreRoot(root), "state.json", raw, s => decode(s, root, key));
  if (await readConfined(observationStoreRoot(root), "state.json", MONITORING_LIMITS.MAX_HISTORY_SIZE) !== raw) throw new Error("Monitoring history reread mismatch");
}
export async function saveObservations(root: string, previous: ObservationState | undefined, events: ObservationEvent[],
  previousReport: string | undefined, report: string, storedKey: Buffer | undefined, verifySources: () => Promise<void>): Promise<void> {
  const before = previous?.events ?? [];
  if (events.length !== before.length + 1 || !same(events.slice(0, -1), before)) throw new Error("Monitoring journal is append-only");
  const state: ObservationState = { version: 10, workspace: root, phase: "prepared", events };
  const contents = views(events, report);
  if (Buffer.byteLength(structured({ ...state, mac: "0".repeat(64) })) > MONITORING_LIMITS.MAX_HISTORY_SIZE ||
    Buffer.byteLength(contents[0]!) > MONITORING_LIMITS.MAX_HISTORY_SIZE || Buffer.byteLength(report) > MONITORING_LIMITS.MAX_REPORT_SIZE) throw new Error("Monitoring history/report size limit");
  for (const name of MONITORING_FILES) await safePath(root, name);
  await checkObservationViews(root, before, previousReport); await verifySources();
  if (!same((await loadObservationState(root)).state, previous)) throw new Error("Monitoring state changed before append");
  let key = storedKey;
  if (!key) {
    const store = observationStoreRoot(root); await safePath(store, "integrity-key", true); key = randomBytes(32);
    const file = await fs.open(await safePath(store, "integrity-key"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(key.toString("hex") + "\n"); await file.sync(); } finally { await file.close(); }
  }
  // Same fail-closed transaction pattern as V7/V9, without a ledger write.
  await persist(root, state, key); await verifySources();
  await checkObservationViews(root, before, previousReport);
  for (const [i, name] of MONITORING_FILES.entries()) {
    const content = contents[i]!;
    await atomicWrite(root, name, content, raw => { if (raw !== content) throw new Error("Monitoring view write mismatch"); });
  }
  await checkObservationViews(root, events, report); await verifySources();
  await persist(root, { ...state, phase: "complete" }, key);
}
