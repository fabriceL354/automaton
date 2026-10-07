/** V12 single-slot HMAC anchor, using the V5/V9 storage pattern and shared lock.
 * Public JSON is a projection, never transaction evidence or an approval. */
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { safePath } from "./local-tools.js";
import { readConfined, atomicWrite } from "./ledger-runner.js";
import { exact, digest, hex, structured, same, time } from "./project-model.js";
import { ALLOCATION_LIMITS } from "./allocation-sources.js";
import { ALLOCATION_NOTICE, type CapitalAllocation } from "./capital-allocator.js";
import { integerCents } from "./asset-lifecycle.js";

export const ALLOCATION_FILE = "capital-allocation.json";
export function allocationStoreRoot(root: string) { return path.join(path.dirname(path.resolve(root)), `.scout-allocation-${digest(path.resolve(root)).slice(0, 32)}`); }
export interface AllocationState {
  version: 12; workspace: string; phase: "prepared" | "complete";
  proposal: CapitalAllocation; seen_attention_ids: string[];
  learning_count: number; learning_prefix_hash: string;
  approval_count: number; approval_prefix_hash: string;
  approval_decision_count: number; approval_decision_hash: string;
}
function validateProposal(v: CapitalAllocation) {
  if (!v || v.schema_version !== 12 || v.status !== "PROPOSAL_ONLY" || v.notice !== ALLOCATION_NOTICE || v.action_authorized !== false || v.approval_created !== false || v.capability_granted !== false || v.actually_spent_by_v12_cents !== 0 ||
    v.max_active_projects !== 2 || v.max_project_budget_cents !== 1000 || v.max_batch_budget_cents !== 2000 || v.max_experiment_duration_days !== 7) throw new Error("Invalid allocation proposal safety contract");
  hex(v.source_state_fingerprint); time(v.generated_at);
  if (v.allocation_id !== `allocation-${v.source_state_fingerprint}`) throw new Error("Invalid allocation ID");
  [v.confirmed_available_cents, v.confirmed_reserved_cents, v.total_confirmed_spent_cents, v.total_proposed_cents, v.approved_allocation_cents].forEach(n => integerCents(n));
  if (!Array.isArray(v.selected_projects) || v.selected_projects.length > 2 || !Array.isArray(v.candidates_considered) || v.candidates_considered.length > 3 || !Array.isArray(v.attention_items) || v.attention_items.length > 5) throw new Error("Allocation list limit");
  if (v.selected_projects.some(p => integerCents(p.proposed_cents) > 1000 || p.max_duration_days !== 7) ||
    v.selected_projects.reduce((sum, p) => sum + p.proposed_cents, 0) !== v.total_proposed_cents ||
    v.total_proposed_cents > v.confirmed_available_cents || v.total_proposed_cents + v.confirmed_reserved_cents + v.total_confirmed_spent_cents > 2000) throw new Error("Stored allocation exceeds financial limits");
}
const mac = (s: AllocationState, key: Buffer) => createHmac("sha256", key).update(JSON.stringify(s)).digest("hex");
function decode(raw: string, root: string, key: Buffer): AllocationState {
  const d = exact(JSON.parse(raw), ["version", "workspace", "phase", "proposal", "seen_attention_ids", "learning_count", "learning_prefix_hash", "approval_count", "approval_prefix_hash", "approval_decision_count", "approval_decision_hash", "mac"]);
  const state = { version: d.version, workspace: d.workspace, phase: d.phase, proposal: d.proposal, seen_attention_ids: d.seen_attention_ids,
    learning_count: d.learning_count, learning_prefix_hash: d.learning_prefix_hash, approval_count: d.approval_count, approval_prefix_hash: d.approval_prefix_hash,
    approval_decision_count: d.approval_decision_count, approval_decision_hash: d.approval_decision_hash } as AllocationState;
  if (!timingSafeEqual(Buffer.from(hex(d.mac), "hex"), Buffer.from(mac(state, key), "hex"))) throw new Error("Allocation authentication failed");
  if (state.version !== 12 || state.workspace !== root || !["prepared", "complete"].includes(state.phase) ||
    !Array.isArray(state.seen_attention_ids) || state.seen_attention_ids.length > ALLOCATION_LIMITS.MAX_ATTENTION_HISTORY ||
    new Set(state.seen_attention_ids).size !== state.seen_attention_ids.length || state.seen_attention_ids.some(v => typeof v !== "string" || !/^allocation-attention-[a-f0-9]{64}$/.test(v))) throw new Error("Invalid allocation state");
  for (const count of [state.learning_count, state.approval_count, state.approval_decision_count]) if (!Number.isSafeInteger(count) || count < 0 || count > 1000) throw new Error("Invalid allocation prefix count");
  hex(state.learning_prefix_hash); hex(state.approval_prefix_hash); hex(state.approval_decision_hash); validateProposal(state.proposal);
  return state;
}
export async function loadAllocation(root: string): Promise<{ state?: AllocationState; key?: Buffer }> {
  const store = allocationStoreRoot(root);
  try { await fs.lstat(store); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    if (await readConfined(root, ALLOCATION_FILE, ALLOCATION_LIMITS.MAX_OUTPUT_BYTES) !== undefined) throw new Error("Orphan allocation projection; missing authentication anchor");
    return {};
  }
  await safePath(store, "state.json");
  if (((await fs.stat(store)).mode & 0o077) !== 0) throw new Error("Allocation store must be private (0700)");
  const keyRaw = await readConfined(store, "integrity-key", 65), raw = await readConfined(store, "state.json", ALLOCATION_LIMITS.MAX_STATE_BYTES);
  if (!keyRaw || !/^[a-f0-9]{64}\n$/.test(keyRaw) || raw === undefined) throw new Error("Incomplete allocation anchor; human inspection required; no key regeneration");
  for (const name of ["integrity-key", "state.json"]) if (((await fs.stat(await safePath(store, name))).mode & 0o077) !== 0) throw new Error("Allocation files must be private (0600)");
  const key = Buffer.from(keyRaw.trim(), "hex"), state = decode(raw, root, key);
  if (state.phase !== "complete") throw new Error("Incomplete allocation transaction; human inspection required; no automatic repair");
  if (await readConfined(root, ALLOCATION_FILE, ALLOCATION_LIMITS.MAX_OUTPUT_BYTES) !== structured(state.proposal)) throw new Error("Modified or missing allocation projection");
  return { state, key };
}
async function persist(root: string, state: AllocationState, key: Buffer) {
  const raw = structured({ ...state, mac: mac(state, key) });
  if (Buffer.byteLength(raw) > ALLOCATION_LIMITS.MAX_STATE_BYTES) throw new Error("Allocation state size limit");
  await atomicWrite(allocationStoreRoot(root), "state.json", raw, v => decode(v, root, key));
  if (await readConfined(allocationStoreRoot(root), "state.json", ALLOCATION_LIMITS.MAX_STATE_BYTES) !== raw) throw new Error("Allocation state reread mismatch");
}
/** Caller holds the existing V5–V11 shared lock. Single replacement, no ledger mutation. */
export async function saveAllocation(root: string, loaded: Awaited<ReturnType<typeof loadAllocation>>, next: AllocationState, verify: () => Promise<void>) {
  validateProposal(next.proposal);
  const content = structured(next.proposal);
  if (Buffer.byteLength(content) > ALLOCATION_LIMITS.MAX_OUTPUT_BYTES || Buffer.byteLength(structured({ ...next, mac: "0".repeat(64) })) > ALLOCATION_LIMITS.MAX_STATE_BYTES || next.seen_attention_ids.length > ALLOCATION_LIMITS.MAX_ATTENTION_HISTORY) throw new Error("Allocation storage/history size limit");
  await safePath(root, ALLOCATION_FILE); await verify();
  if (!same((await loadAllocation(root)).state, loaded.state)) throw new Error("Allocation changed before commit");
  let key = loaded.key;
  if (!key) {
    const store = allocationStoreRoot(root); await safePath(store, "integrity-key", true); key = randomBytes(32);
    const file = await fs.open(await safePath(store, "integrity-key"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(key.toString("hex") + "\n"); await file.sync(); } finally { await file.close(); }
  }
  await persist(root, { ...next, phase: "prepared" }, key); await verify();
  const previous = loaded.state ? structured(loaded.state.proposal) : undefined;
  if (await readConfined(root, ALLOCATION_FILE, ALLOCATION_LIMITS.MAX_OUTPUT_BYTES) !== previous) throw new Error("Allocation projection changed during commit");
  await atomicWrite(root, ALLOCATION_FILE, content, raw => { if (raw !== content) throw new Error("Allocation projection write mismatch"); });
  if (await readConfined(root, ALLOCATION_FILE, ALLOCATION_LIMITS.MAX_OUTPUT_BYTES) !== content) throw new Error("Allocation projection reread mismatch");
  await verify(); await persist(root, { ...next, phase: "complete" }, key);
}
