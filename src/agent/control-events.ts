/** Durable append-only projections, never a second business authority.
 * All reads/writes run under the existing V5 lock; no timer or network. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { safePath } from "./local-tools.js";
import { atomicWrite, readConfined } from "./ledger-runner.js";
import { canonicalHash, digest, exact, hex, time, same, structured } from "./project-model.js";
import { CONTROL_LIMITS, EVENT_TYPES, EVENT_MESSAGES, ControlError, type ControlEvent, type EventProjection } from "./control-model.js";
import type { ControlSnapshot } from "./control-snapshot.js";
interface Checkpoint { count: number; hash: string }
interface EventState { schema_version: 1; workspace: string; events: ControlEvent[]; checkpoints: Record<string, Checkpoint> }
export function controlEventStoreRoot(root: string) { return path.join(path.dirname(path.resolve(root)), `.scout-control-${digest(path.resolve(root)).slice(0, 32)}`); }
const mac = (s: EventState, key: Buffer) => createHmac("sha256", key).update(JSON.stringify(s)).digest("hex");
function eventIdentity(p: Pick<EventProjection, "event_type" | "source_ref">) { return `event-${canonicalHash([p.event_type, p.source_ref])}`; }
function decode(raw: string, root: string, key: Buffer): EventState {
  if (Buffer.byteLength(raw) > CONTROL_LIMITS.eventBytes) throw new Error("Event store byte limit");
  const d = exact(JSON.parse(raw), ["schema_version", "workspace", "events", "checkpoints", "mac"]);
  const state = { schema_version: d.schema_version, workspace: d.workspace, events: d.events, checkpoints: d.checkpoints } as EventState;
  if (!timingSafeEqual(Buffer.from(hex(d.mac), "hex"), Buffer.from(mac(state, key), "hex"))) throw new Error("Event authentication failed");
  if (state.schema_version !== 1 || state.workspace !== root || !Array.isArray(state.events) || state.events.length > CONTROL_LIMITS.events) throw new Error("Invalid event store");
  const seen = new Set<string>();
  state.events.forEach((e, i) => {
    exact(e, ["schema_version", "event_id", "sequence", "created_at", "event_type", "severity", "subject_type", "subject_id", "title", "short_message", "requires_human_action", "source_ref", "attention_id", "authority", "payload"]);
    if (e.schema_version !== 1 || e.sequence !== i + 1 || e.event_id !== eventIdentity(e) || seen.has(e.event_id) || !EVENT_TYPES.includes(e.event_type) ||
      e.title !== e.event_type || e.short_message !== EVENT_MESSAGES[e.event_type] || !["info", "warning"].includes(e.severity) ||
      !["approval", "project", "research", "allocation"].includes(e.subject_type) || !["authenticated_state", "informational_research"].includes(e.authority) ||
      typeof e.requires_human_action !== "boolean" || !same(e.payload, { action_authorized: false, capability_granted: false })) throw new Error("Invalid event contract");
    for (const ref of [e.subject_id, e.source_ref, e.attention_id]) if (typeof ref !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(ref)) throw new Error("Invalid event reference");
    time(e.created_at); seen.add(e.event_id);
  });
  if (!state.checkpoints || typeof state.checkpoints !== "object" || Array.isArray(state.checkpoints) || Object.keys(state.checkpoints).length > 10) throw new Error("Invalid event checkpoints");
  for (const pin of Object.values(state.checkpoints)) { exact(pin, ["count", "hash"]); hex(pin.hash); if (!Number.isSafeInteger(pin.count) || pin.count < 0 || pin.count > 10000) throw new Error("Invalid checkpoint count"); }
  return state;
}
async function load(root: string): Promise<{ state?: EventState; key?: Buffer }> {
  const store = controlEventStoreRoot(root);
  try { await fs.lstat(store); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
  await safePath(store, "state.json");
  if (((await fs.stat(store)).mode & 0o077) !== 0) throw new Error("Control store must be private");
  const raw = await readConfined(store, "state.json", CONTROL_LIMITS.eventBytes), keyRaw = await readConfined(store, "integrity-key", 65);
  if (raw === undefined || !keyRaw || !/^[a-f0-9]{64}\n$/.test(keyRaw)) throw new Error("Incomplete event anchor; human inspection required");
  for (const name of ["state.json", "integrity-key"]) if (((await fs.stat(await safePath(store, name))).mode & 0o077) !== 0) throw new Error("Control files must be private");
  const key = Buffer.from(keyRaw.trim(), "hex"); return { state: decode(raw, root, key), key };
}
/** Lazy projection at an authenticated read/decision. Polling never invokes Scout.
 * Source checkpoints detect rollback of authenticated append-only histories. */
export async function syncControlEvents(root: string, snapshot: ControlSnapshot): Promise<ControlEvent[]> {
  const loaded = await load(root), previous = loaded.state;
  if (previous) for (const [name, pin] of Object.entries(previous.checkpoints)) {
    const values = snapshot.histories[name];
    if (!values || values.length < pin.count || canonicalHash(values.slice(0, pin.count)) !== pin.hash) throw new Error("Canonical source rollback/rewrite");
  }
  const checkpoints = Object.fromEntries(Object.entries(snapshot.histories).map(([name, values]) => [name, { count: values.length, hash: canonicalHash(values) }]));
  const events = [...(previous?.events ?? [])], seen = new Set(events.map(e => e.event_id));
  const observed = new Date().toISOString();
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const candidates = [...snapshot.projections].sort((a, b) => compare(a.created_at ?? observed, b.created_at ?? observed) || compare(eventIdentity(a), eventIdentity(b)));
  for (const p of candidates) {
    const event_id = eventIdentity(p);
    if (seen.has(event_id)) continue;
    if (events.length >= CONTROL_LIMITS.events) throw new ControlError(503, "EVENT_STORE_FULL", "Event history is full; operator archival is required.");
    const e: ControlEvent = { schema_version: 1, event_id, sequence: events.length + 1, created_at: p.created_at ?? observed,
      event_type: p.event_type, severity: p.requires_human_action ? "warning" : "info", subject_type: p.subject_type, subject_id: p.subject_id,
      title: p.event_type, short_message: EVENT_MESSAGES[p.event_type], requires_human_action: p.requires_human_action,
      source_ref: p.source_ref, attention_id: p.attention_id, authority: p.authority, payload: { action_authorized: false, capability_granted: false } };
    events.push(e); seen.add(event_id);
  }
  const state: EventState = { schema_version: 1, workspace: root, events, checkpoints };
  if (same(previous, state)) return events;
  let key = loaded.key;
  // Validate all sizes/fields before any persistent write, including the key.
  const candidateKey = key ?? randomBytes(32);
  const raw = structured({ ...state, mac: mac(state, candidateKey) }); decode(raw, root, candidateKey);
  const store = controlEventStoreRoot(root);
  if (!key) {
    await safePath(store, "integrity-key", true);
    if (((await fs.stat(store)).mode & 0o077) !== 0) throw new Error("Unsafe event directory");
    const file = await fs.open(await safePath(store, "integrity-key"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(candidateKey.toString("hex") + "\n"); await file.sync(); } finally { await file.close(); }
    key = candidateKey;
  }
  await atomicWrite(store, "state.json", raw, v => decode(v, root, key!));
  if (await readConfined(store, "state.json", CONTROL_LIMITS.eventBytes) !== raw) throw new Error("Event reread mismatch");
  return events;
}
