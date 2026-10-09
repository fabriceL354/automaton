/** Single atomic authenticated preparation history. V5 remains the economic
 * authority. No projections to repair, no stale-lock stealing, no financial write. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { atomicWrite, readConfined } from "./ledger-runner.js";
import { safePath } from "./local-tools.js";
import { canonicalHash, exact, hex, same, structured, time } from "./project-model.js";
import { PREPARATION_EVENTS, PREPARATION_LIMITS, createPreparedProject, parseDossier, reference, requestFingerprint, type PreparedProject, type PreparationEventType } from "./pilot-preparation-model.js";
import { integerCents } from "./asset-lifecycle.js";
import type { SourcePin } from "./learning-model.js";
export interface PreparationEvent {
  event_id: string; sequence: number; event_type: PreparationEventType; subject_id: string; created_at: string;
  requires_human_action: boolean; action_authorized: false; money_moved: false;
}
export interface PreparationState {
  version: "12.7"; mode: "PREPARATION_ONLY"; workspace: string; updated_at: string;
  input_hash: string; source_file: "research.json" | "opportunities.json"; source_hash: string;
  financial_pin: SourcePin; learning_pin: { count: number; hash: string }; approval_pins: { requests: { count: number; hash: string }; decisions: { count: number; hash: string } };
  projects: PreparedProject[]; events: PreparationEvent[];
}
export function preparationStoreRoot(root: string): string { return path.join(path.dirname(root), `.scout-preparation-${canonicalHash(root).slice(0, 32)}`); }
function signature(s: PreparationState, key: Buffer) { return createHmac("sha256", key).update(JSON.stringify(s)).digest("hex"); }
export function decodePreparation(raw: string, root: string, key: Buffer): PreparationState {
  if (Buffer.byteLength(raw) > PREPARATION_LIMITS.MAX_BYTES) throw new Error("Preparation byte limit");
  const d = exact(JSON.parse(raw), ["state", "mac"]), s = d.state as PreparationState;
  if (!timingSafeEqual(Buffer.from(hex(d.mac), "hex"), Buffer.from(signature(s, key), "hex"))) throw new Error("Preparation authentication failed");
  exact(s, ["version", "mode", "workspace", "updated_at", "input_hash", "source_file", "source_hash", "financial_pin", "learning_pin", "approval_pins", "projects", "events"]);
  if (s.version !== "12.7" || s.mode !== "PREPARATION_ONLY" || s.workspace !== root || !["research.json", "opportunities.json"].includes(s.source_file)) throw new Error("Invalid preparation state");
  time(s.updated_at); hex(s.input_hash); hex(s.source_hash);
  if (!Array.isArray(s.projects) || s.projects.length > 2 || new Set(s.projects.map(p => p.project_id)).size !== s.projects.length || !Array.isArray(s.events) || s.events.length > PREPARATION_LIMITS.MAX_RECORDS) throw new Error("Preparation history limits");
  if (s.projects.reduce((sum, p) => sum + integerCents(p.reserved_budget_cents), 0) > 2000) throw new Error("Preparation exposure limit");
  const declarationIds = new Set<string>();
  for (const p of s.projects) {
    exact(p, ["project_id", "dossier", "dossier_hash", "candidate", "created_at", "reserved_budget_cents", "requests", "commercial_review", "declarations"]);
    const dossier = parseDossier(p.dossier); time(p.created_at);
    if (p.created_at > s.updated_at || dossier.review_expires_at <= p.created_at || Date.parse(dossier.review_expires_at) - Date.parse(p.created_at) > 7 * 86400000) throw new Error("Invalid preparation timing");
    const initial = createPreparedProject(dossier, p.candidate, p.created_at);
    if (p.dossier_hash !== canonicalHash(dossier) || p.project_id !== initial.project_id || p.candidate.fingerprint !== dossier.candidate_fingerprint || p.candidate.opportunity_id !== dossier.opportunity_id || p.reserved_budget_cents !== dossier.budget_cents || !Array.isArray(p.requests) || p.requests.length !== initial.requests.length) throw new Error("Preparation binding mismatch");
    for (const [i, r] of p.requests.entries()) {
      exact(r, Object.keys(initial.requests[i]));
      const { status, decided_at, human_reference, ...body } = r;
      const { status: _s, decided_at: _d, human_reference: _h, ...expected } = initial.requests[i];
      if (!same(body, expected) || requestFingerprint(r) !== r.fingerprint || !["pending", "approved", "denied"].includes(status)) throw new Error("Approval scope mismatch");
      if (status === "pending" ? decided_at !== null || human_reference !== null : !decided_at || decided_at < r.created_at || decided_at >= r.expires_at || decided_at > s.updated_at || human_reference !== `local-cli:v12.7:${status}:${r.request_id}`) throw new Error("Invalid preparation decision");
      if (decided_at !== null) time(decided_at);
    }
    if (p.commercial_review) {
      const r = p.commercial_review; exact(r, ["reviewed_at", "cost_proof_id", "confirmed_quote_cents", "scope_hash", "human_reference"]);
      time(r.reviewed_at); integerCents(r.confirmed_quote_cents);
      if (p.dossier.fictional || r.reviewed_at < p.created_at || r.reviewed_at >= p.dossier.review_expires_at || r.reviewed_at > s.updated_at || r.scope_hash !== p.dossier_hash || r.confirmed_quote_cents > p.dossier.budget_cents || r.human_reference !== `local-cli:v12.7:review:${p.project_id}` || !p.dossier.proofs.some(e => e.proof_id === r.cost_proof_id && e.purpose === "cost")) throw new Error("Invalid commercial review");
    }
    if (!Array.isArray(p.declarations) || p.declarations.length > 100) throw new Error("Declaration limit");
    for (const r of p.declarations) {
      exact(r, ["declaration_id", "kind", "amount_cents", "recorded_at", "phase", "proof_id", "verification"]); reference(r.declaration_id); integerCents(r.amount_cents); time(r.recorded_at);
      if (declarationIds.has(r.declaration_id) || !["expense", "revenue"].includes(r.kind) || !["experiment", "post_experiment"].includes(r.phase) || r.kind === "expense" && r.phase !== "experiment" || r.verification !== "UNVERIFIED_HUMAN_DECLARATION" || r.recorded_at < p.created_at || r.recorded_at > s.updated_at || r.proof_id !== null && !p.dossier.proofs.some(e => e.proof_id === r.proof_id)) throw new Error("Invalid economic declaration");
      declarationIds.add(r.declaration_id);
    }
    if (p.declarations.filter(r => r.kind === "expense").reduce((sum, r) => sum + r.amount_cents, 0) > p.reserved_budget_cents) throw new Error("Declared expense exceeds budget");
  }
  const seen = new Set<string>();
  for (const [i, e] of s.events.entries()) {
    exact(e, ["event_id", "sequence", "event_type", "subject_id", "created_at", "requires_human_action", "action_authorized", "money_moved"]);
    reference(e.subject_id); time(e.created_at);
    if (!PREPARATION_EVENTS.includes(e.event_type) || e.sequence !== i + 1 || seen.has(e.event_id) || e.event_id !== `preparation-event-${canonicalHash([e.event_type, e.subject_id])}` || e.created_at > s.updated_at || typeof e.requires_human_action !== "boolean" || e.action_authorized !== false || e.money_moved !== false) throw new Error("Invalid preparation event");
    seen.add(e.event_id);
  }
  return s;
}
export async function loadPreparation(root: string): Promise<{ state?: PreparationState; key?: Buffer }> {
  const store = preparationStoreRoot(root);
  try { await fs.lstat(store); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
  await safePath(store, "state.json");
  if ((await fs.stat(store)).mode & 0o077) throw new Error("Preparation store must be private");
  const raw = await readConfined(store, "state.json", PREPARATION_LIMITS.MAX_BYTES), keyRaw = await readConfined(store, "integrity-key", 65);
  if (!raw || !keyRaw || !/^[a-f0-9]{64}\n$/.test(keyRaw)) throw new Error("Incomplete preparation anchor; human inspection required");
  for (const name of ["state.json", "integrity-key"]) if ((await fs.stat(await safePath(store, name))).mode & 0o077) throw new Error("Preparation files must be private");
  const key = Buffer.from(keyRaw.trim(), "hex"); return { state: decodePreparation(raw, root, key), key };
}
export async function savePreparation(root: string, state: PreparationState, key?: Buffer): Promise<void> {
  const store = preparationStoreRoot(root), nextKey = key ?? randomBytes(32), raw = structured({ state, mac: signature(state, nextKey) });
  decodePreparation(raw, root, nextKey);
  if (!key) {
    await safePath(store, "integrity-key", true);
    if ((await fs.stat(store)).mode & 0o077) throw new Error("Preparation store must be private");
    const fd = await fs.open(await safePath(store, "integrity-key"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await fd.writeFile(nextKey.toString("hex") + "\n"); await fd.sync(); } finally { await fd.close(); }
  }
  await atomicWrite(store, "state.json", raw, v => decodePreparation(v, root, nextKey));
  if (await readConfined(store, "state.json", PREPARATION_LIMITS.MAX_BYTES) !== raw) throw new Error("Preparation reread mismatch");
}
export function addPreparationEvent(s: PreparationState, event_type: PreparationEventType, subject_id: string, at: string): void {
  const event_id = `preparation-event-${canonicalHash([event_type, subject_id])}`;
  if (s.events.some(e => e.event_id === event_id)) return;
  if (s.events.length >= PREPARATION_LIMITS.MAX_RECORDS) throw new Error("Preparation event history full; human inspection required");
  s.events.push({ event_id, sequence: s.events.length + 1, event_type, subject_id, created_at: at,
    requires_human_action: true, action_authorized: false, money_moved: false });
}
