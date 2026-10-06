/** V11 private authenticated append-only hypothesis journal using V5 storage.
 * No economic, V9 or external files are written by this module. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { safePath } from "./local-tools.js";
import { readConfined, atomicWrite } from "./ledger-runner.js";
import { exact, hex, digest, structured, same } from "./project-model.js";
import { LEARNING_LIMITS, type LearningEvent } from "./learning-model.js";
export const LEARNING_FILES = ["learning-history.json", "learning-hypotheses.json"];
export interface LearningState { version: 11; workspace: string; phase: "prepared" | "complete"; events: LearningEvent[] }
export function learningStoreRoot(root: string): string { return path.join(path.dirname(path.resolve(root)), `.scout-learning-${digest(path.resolve(root)).slice(0, 32)}`); }
const mac = (state: LearningState, key: Buffer) => createHmac("sha256", key).update(JSON.stringify(state)).digest("hex");
function decode(raw: string, root: string, key: Buffer): LearningState {
  const d = exact(JSON.parse(raw), ["version", "workspace", "phase", "events", "mac"]);
  const state = { version: d.version, workspace: d.workspace, phase: d.phase, events: d.events } as LearningState;
  if (!timingSafeEqual(Buffer.from(hex(d.mac), "hex"), Buffer.from(mac(state, key), "hex"))) throw new Error("Learning history authentication failed");
  if (state.version !== 11 || state.workspace !== root || !["prepared", "complete"].includes(state.phase) || !Array.isArray(state.events) || !state.events.length || state.events.length > LEARNING_LIMITS.MAX_HISTORY_ENTRIES) throw new Error("Invalid learning history");
  return state;
}
export async function loadLearningState(root: string): Promise<{ state?: LearningState; key?: Buffer }> {
  const store = learningStoreRoot(root);
  try { await fs.lstat(store); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
  await safePath(store, "state.json");
  if (((await fs.stat(store)).mode & 0o077) !== 0) throw new Error("Learning store must be private (0700)");
  const keyRaw = await readConfined(store, "integrity-key", 65), raw = await readConfined(store, "state.json", LEARNING_LIMITS.MAX_HISTORY_BYTES);
  if (!keyRaw || raw === undefined || !/^[a-f0-9]{64}\n$/.test(keyRaw)) throw new Error("Incomplete learning anchor; human inspection required");
  for (const name of ["integrity-key", "state.json"]) if (((await fs.stat(await safePath(store, name))).mode & 0o077) !== 0) throw new Error("Learning files must be private (0600)");
  const key = Buffer.from(keyRaw.trim(), "hex"), state = decode(raw, root, key);
  if (state.phase !== "complete") throw new Error("Incomplete learning transaction; human inspection required; no automatic repair");
  return { state, key };
}
function views(events: LearningEvent[], report: string | undefined): (string | undefined)[] {
  return events.length ? [structured({ version: 11, events }), report] : [undefined, undefined];
}
export async function checkLearningViews(root: string, events: LearningEvent[], report: string | undefined): Promise<void> {
  const expected = views(events, report);
  for (const [i, name] of LEARNING_FILES.entries()) {
    if (await readConfined(root, name, i ? LEARNING_LIMITS.MAX_HISTORY_BYTES : LEARNING_LIMITS.MAX_HISTORY_BYTES) !== expected[i]) throw new Error(`Modified, missing or orphan ${name}`);
  }
}
async function persist(root: string, state: LearningState, key: Buffer) {
  const raw = structured({ ...state, mac: mac(state, key) });
  if (Buffer.byteLength(raw) > LEARNING_LIMITS.MAX_HISTORY_BYTES) throw new Error("Learning history size limit");
  await atomicWrite(learningStoreRoot(root), "state.json", raw, s => decode(s, root, key));
  if (await readConfined(learningStoreRoot(root), "state.json", LEARNING_LIMITS.MAX_HISTORY_BYTES) !== raw) throw new Error("Learning history reread mismatch");
}
export async function saveLearning(root: string, previous: LearningState | undefined, events: LearningEvent[],
  previousReport: string | undefined, report: string, storedKey: Buffer | undefined, verifySources: () => Promise<void>): Promise<void> {
  const before = previous?.events ?? [];
  if (events.length !== before.length + 1 || !same(events.slice(0, -1), before)) throw new Error("Learning journal is append-only");
  const state: LearningState = { version: 11, workspace: root, phase: "prepared", events };
  const contents = views(events, report);
  if (Buffer.byteLength(structured({ ...state, mac: "0".repeat(64) })) > LEARNING_LIMITS.MAX_HISTORY_BYTES ||
    Buffer.byteLength(contents[0]!) > LEARNING_LIMITS.MAX_HISTORY_BYTES || Buffer.byteLength(report) > LEARNING_LIMITS.MAX_HISTORY_BYTES) throw new Error("Learning history/report size limit");
  for (const name of LEARNING_FILES) await safePath(root, name);
  await checkLearningViews(root, before, previousReport); await verifySources();
  if (!same((await loadLearningState(root)).state, previous)) throw new Error("Learning state changed before append");
  let key = storedKey;
  if (!key) {
    const store = learningStoreRoot(root); await safePath(store, "integrity-key", true); key = randomBytes(32);
    const file = await fs.open(await safePath(store, "integrity-key"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(key.toString("hex") + "\n"); await file.sync(); } finally { await file.close(); }
  }
  // Same fail-closed transaction pattern as V7/V9, without a ledger write.
  await persist(root, state, key); await verifySources();
  await checkLearningViews(root, before, previousReport);
  for (const [i, name] of LEARNING_FILES.entries()) {
    const content = contents[i]!;
    await atomicWrite(root, name, content, raw => { if (raw !== content) throw new Error("Learning view write mismatch"); });
  }
  await checkLearningViews(root, events, report); await verifySources();
  await persist(root, { ...state, phase: "complete" }, key);
}
