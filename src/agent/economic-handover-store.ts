/** Durable V14.2 write-ahead transaction. No second ledger or action executor.
 * A signed committed write set is installed into the EXISTING V5/V9/V12.7 stores.
 * All other locked hosts refuse an unfinished installation. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite, readConfined } from "./ledger-runner.js";
import { safePath } from "./local-tools.js";
import { preparationStoreRoot, decodePreparation } from "./pilot-preparation-store.js";
import { projectStoreRoot, PROJECT_FILES, encodeProjectState, projectViews } from "./project-store.js";
import { canonicalHash, exact, hex, same, structured, time, type ProjectEvent } from "./project-model.js";
import { parseEconomicLedger, buildEconomicReport } from "./economic-ledger.js";
import { auditProjects } from "./project-manager.js";
import { assertExactHandoverApproval, validateHandoverRequest, type HandoverRequest } from "./economic-handover-model.js";
import { assertPreparationCapacity } from "./pilot-preparation.js";
import type { AllocationSources } from "./allocation-sources.js";

export const HANDOVER_FILE = "economic-handover-state.json";
export const HANDOVER_MAX_BYTES = 2 * 1024 * 1024;
export interface WriteImage { area: "workspace" | "preparation" | "projects"; name: string; before: string | null; after: string }
export interface HandoverTransaction { request_id: string; committed_at: string; writes: WriteImage[]; installed: boolean }
export interface HandoverState { version: "14.2"; workspace: string; requests: HandoverRequest[]; transactions: HandoverTransaction[] }
const sign = (s: HandoverState, key: Buffer) => createHmac("sha256", key).update(JSON.stringify(s)).digest();
export function writeDirectory(root: string, area: WriteImage["area"]): string {
  if (area === "workspace") return root;
  if (area === "preparation") return preparationStoreRoot(root);
  if (area === "projects") return projectStoreRoot(root);
  throw new Error("HANDOVER_WRITE_AREA_FORBIDDEN");
}
function validateImage(w: WriteImage) {
  exact(w, ["area", "name", "before", "after"]);
  const allowed = w.area === "workspace" ? ["economic-ledger.json", "economic-report.txt", ...PROJECT_FILES] : w.area === "preparation" ? ["state.json"] : w.area === "projects" ? ["integrity-key", "state.json"] : [];
  if (!allowed.includes(w.name) || w.before !== null && typeof w.before !== "string" || typeof w.after !== "string" || !w.after || Buffer.byteLength(w.after) > HANDOVER_MAX_BYTES) throw new Error("HANDOVER_WRITE_FORBIDDEN");
}
/** Revalidate the original formats and semantic before/after delta, not just MAC. */
function auditTransaction(root: string, t: HandoverTransaction, r: HandoverRequest, key: Buffer) {
  exact(t, ["request_id", "committed_at", "writes", "installed"]); time(t.committed_at);
  if (r.status !== "approved" || !r.decided_at || t.committed_at < r.decided_at || t.committed_at >= r.scope.expires_at || typeof t.installed !== "boolean" || !Array.isArray(t.writes) || t.writes.length !== 9) throw new Error("HANDOVER_TRANSACTION_INVALID");
  t.writes.forEach(validateImage);
  if (new Set(t.writes.map(w => `${w.area}:${w.name}`)).size !== 9) throw new Error("HANDOVER_DUPLICATE_WRITE");
  const get = (area: WriteImage["area"], name: string) => { const w = t.writes.find(w => w.area === area && w.name === name); if (!w) throw new Error("HANDOVER_MISSING_WRITE"); return w; };
  const l = get("workspace", "economic-ledger.json");
  if (!l.before) throw new Error("HANDOVER_MISSING_LEDGER");
  const before = parseEconomicLedger(l.before), after = parseEconomicLedger(l.after), entry = after.entries.at(-1)!;
  if (t.committed_at < entry.timestamp) throw new Error("HANDOVER_TRANSACTION_CLOCK_ROLLBACK");
  if (after.entries.length !== before.entries.length + 1 || !same(after.entries.slice(0, -1), before.entries) || entry.type !== "reserve" || entry.amount_cents !== r.scope.amount_cents || entry.experiment?.id !== canonicalHash(r.scope.target_plan)) throw new Error("HANDOVER_LEDGER_DELTA_INVALID");
  const p = get("preparation", "state.json");
  if (!p.before) throw new Error("HANDOVER_MISSING_SOURCE");
  const original = decodePreparation(p.before, root, key), reclassified = decodePreparation(p.after, root, key);
  const source = original.projects.find(p => p.project_id === r.scope.project_id), target = reclassified.projects.find(p => p.project_id === r.scope.project_id);
  const receipt = target?.accounting_transfer;
  if (!source || source.accounting_transfer || !target || !receipt || receipt.transfer_id !== r.scope.transfer_id || receipt.request_id !== t.request_id || receipt.fingerprint !== r.fingerprint || receipt.transferred_at !== t.committed_at || receipt.target_project_id !== r.scope.target_plan.project_id || receipt.experiment_id !== entry.experiment?.id || receipt.ledger_entry_id !== entry.id || receipt.ledger_entry_hash !== entry.hash || receipt.amount_cents !== entry.amount_cents) throw new Error("HANDOVER_RECLASSIFICATION_INVALID");
  assertExactHandoverApproval(r, source, t.committed_at);
  const restored = structuredClone(reclassified); restored.updated_at = original.updated_at; delete restored.projects.find(p => p.project_id === source.project_id)!.accounting_transfer;
  if (!same(restored, original) || source.reserved_budget_cents !== entry.amount_cents) throw new Error("HANDOVER_HISTORY_REWRITE");
  const k = get("projects", "integrity-key");
  if (!/^[a-f0-9]{64}\n$/.test(k.after) || k.before !== null && k.before !== k.after) throw new Error("HANDOVER_PROJECT_KEY_CHANGED");
  const projectKey = Buffer.from(k.after.trim(), "hex"), v = get("projects", "state.json");
  const parsed = JSON.parse(v.after);
  const state = { version: parsed.version, workspace: parsed.workspace, phase: parsed.phase, events: parsed.events };
  if (state.phase !== "complete" || encodeProjectState(root, state, projectKey) !== v.after) throw new Error("HANDOVER_V9_AUTHENTICATION_FAILED");
  let beforeEvents: ProjectEvent[] = [];
  if (v.before !== null) {
    const b = JSON.parse(v.before), bs = { version: b.version, workspace: b.workspace, phase: b.phase, events: b.events };
    if (encodeProjectState(root, bs, projectKey) !== v.before || bs.phase !== "complete") throw new Error("HANDOVER_V9_BEFORE_INVALID");
    beforeEvents = bs.events;
  } else if (k.before !== null) throw new Error("HANDOVER_ORPHAN_PROJECT_KEY");
  const oldModel = auditProjects(beforeEvents, before), model = auditProjects(state.events, after);
  assertPreparationCapacity({ financial: { ledger: before, model: oldModel } } as AllocationSources, original.projects);
  assertPreparationCapacity({ financial: { ledger: after, model } } as AllocationSources, reclassified.projects);
  const delta: ProjectEvent[] = state.events.slice(beforeEvents.length);
  if (!same(state.events.slice(0, beforeEvents.length), beforeEvents) || !same(delta.map(e => e.command.operation), oldModel.batch ? ["create-project", "reserve-project"] : ["create-batch", "create-project", "reserve-project"])) throw new Error("HANDOVER_V9_HISTORY_REWRITE");
  const bound = model.projects.find(p => p.plan.project_id === r.scope.target_plan.project_id);
  if (!bound || !same(bound.plan, r.scope.target_plan) || bound.status !== "reserved" || bound.approval?.request.status !== "pending" || bound.started_at !== null || bound.approval.request.request_id !== r.scope.reservation_request_id) throw new Error("HANDOVER_EXECUTION_FORBIDDEN");
  for (const [i, name] of PROJECT_FILES.entries()) if (get("workspace", name).after !== projectViews(model)[i]) throw new Error("HANDOVER_VIEW_INVALID");
  if (get("workspace", "economic-report.txt").after !== buildEconomicReport(after)) throw new Error("HANDOVER_REPORT_INVALID");
}
export function decodeHandover(raw: string, root: string, key: Buffer): HandoverState {
  if (Buffer.byteLength(raw) > HANDOVER_MAX_BYTES) throw new Error("HANDOVER_SIZE_LIMIT");
  const d = exact(JSON.parse(raw), ["state", "mac"]), s = d.state as HandoverState;
  if (!timingSafeEqual(sign(s, key), Buffer.from(hex(d.mac), "hex"))) throw new Error("HANDOVER_AUTHENTICATION_FAILED");
  exact(s, ["version", "workspace", "requests", "transactions"]);
  if (s.version !== "14.2" || s.workspace !== root || !Array.isArray(s.requests) || s.requests.length > 8 || !Array.isArray(s.transactions) || s.transactions.length > 2) throw new Error("HANDOVER_STATE_INVALID");
  const ids = new Set<string>(), transfers = new Set<string>();
  for (const r of s.requests) { validateHandoverRequest(r); if (ids.has(r.scope.request_id)) throw new Error("HANDOVER_DUPLICATE_REQUEST"); ids.add(r.scope.request_id); }
  let at = "";
  for (const [i, t] of s.transactions.entries()) {
    const r = s.requests.find(r => r.scope.request_id === t.request_id);
    if (!r || transfers.has(r.scope.transfer_id) || t.committed_at < at || i < s.transactions.length - 1 && !t.installed) throw new Error("HANDOVER_TRANSACTION_ORDER");
    auditTransaction(root, t, r, key); transfers.add(r.scope.transfer_id); at = t.committed_at;
  }
  return s;
}
export async function loadHandover(root: string): Promise<{ state: HandoverState; key?: Buffer }> {
  const directory = preparationStoreRoot(root);
  const raw = await readConfined(directory, HANDOVER_FILE, HANDOVER_MAX_BYTES).catch(e => { if (e.code === "ENOENT") return undefined; throw e; });
  if (raw === undefined) {
    const preparation = await readConfined(directory, "state.json", HANDOVER_MAX_BYTES).catch(e => { if (e.code === "ENOENT") return undefined; throw e; });
    if (preparation) {
      // Missing journal must never erase an installed transfer's audit. Leave
      // malformed legacy preparation to its existing stricter validator.
      let parsed: any; try { parsed = JSON.parse(preparation); } catch { parsed = null; }
      if (parsed?.state?.projects?.some((p: any) => Object.hasOwn(p, "accounting_transfer"))) throw new Error("HANDOVER_AUTHENTICATED_JOURNAL_MISSING");
    }
    return { state: { version: "14.2", workspace: root, requests: [], transactions: [] } };
  }
  const keyRaw = await readConfined(directory, "integrity-key", 65);
  if (!keyRaw || !/^[a-f0-9]{64}\n$/.test(keyRaw) || (await fs.stat(directory)).mode & 0o077 || (await fs.stat(await safePath(directory, HANDOVER_FILE))).mode & 0o077 || (await fs.stat(await safePath(directory, "integrity-key"))).mode & 0o077) throw new Error("HANDOVER_PRIVATE_ANCHOR_REQUIRED");
  const key = Buffer.from(keyRaw.trim(), "hex"); return { state: decodeHandover(raw, root, key), key };
}
export async function saveHandover(root: string, s: HandoverState, key: Buffer): Promise<void> {
  const raw = structured({ state: s, mac: sign(s, key).toString("hex") }); decodeHandover(raw, root, key);
  // V12.7's anchor already exists. Persist its parent entry before relying on
  // that anchor/key as the durable transaction authority across a power loss.
  const parent = await fs.open(path.dirname(preparationStoreRoot(root)), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
  await atomicWrite(preparationStoreRoot(root), HANDOVER_FILE, raw, v => decodeHandover(v, root, key));
  if (await readConfined(preparationStoreRoot(root), HANDOVER_FILE, HANDOVER_MAX_BYTES) !== raw) throw new Error("HANDOVER_REREAD_FAILED");
}
export async function assertHandoverInstalled(root: string): Promise<void> {
  const { state, key } = await loadHandover(root);
  if (state.transactions.some(t => !t.installed)) throw new Error("HANDOVER_COMMITTED_INSTALLATION_PENDING; local recovery required");
  const latest = state.transactions.at(-1);
  if (!latest || !key) return;
  for (const w of latest.writes.filter(w => w.area !== "preparation")) {
    if (await readConfined(writeDirectory(root, w.area), w.name, HANDOVER_MAX_BYTES) !== w.after) throw new Error("HANDOVER_INSTALLED_STATE_CHANGED");
  }
  const raw = await readConfined(preparationStoreRoot(root), "state.json", HANDOVER_MAX_BYTES);
  if (!raw) throw new Error("HANDOVER_INSTALLED_SOURCE_MISSING");
  const current = decodePreparation(raw, root, key);
  const expected = decodePreparation(latest.writes.find(w => w.area === "preparation")!.after, root, key);
  for (const p of expected.projects.filter(p => p.accounting_transfer)) {
    if (!same(current.projects.find(c => c.project_id === p.project_id)?.accounting_transfer, p.accounting_transfer)) throw new Error("HANDOVER_INSTALLED_RECEIPT_CHANGED");
  }
}
/** No rollback of a durable authorization. Install exact committed bytes only.
 * An unexpected third value blocks before ANY recovery write. */
export async function installHandover(root: string, s: HandoverState, key: Buffer): Promise<void> {
  const t = s.transactions.find(t => !t.installed); if (!t) return;
  for (const w of t.writes) {
    const directory = writeDirectory(root, w.area);
    const current = await readConfined(directory, w.name, HANDOVER_MAX_BYTES).catch(e => { if (e.code === "ENOENT") return undefined; throw e; });
    if ((current ?? null) !== w.before && current !== w.after) throw new Error("HANDOVER_RECOVERY_CONFLICT; human inspection required");
    await safePath(directory, w.name, true);
  }
  for (const w of t.writes) {
    const directory = writeDirectory(root, w.area);
    const current = await readConfined(directory, w.name, HANDOVER_MAX_BYTES);
    if (current !== w.after) await atomicWrite(directory, w.name, w.after, raw => { if (raw !== w.after) throw new Error("HANDOVER_INSTALL_MISMATCH"); });
    if (await readConfined(directory, w.name, HANDOVER_MAX_BYTES) !== w.after) throw new Error("HANDOVER_INSTALL_REREAD_FAILED");
  }
  // Re-sync every directory before recording installation complete, including
  // a newly created V9 anchor's parent entry. Never acknowledge only memory.
  const directories = new Set([root, preparationStoreRoot(root), projectStoreRoot(root)]);
  directories.add(path.dirname(projectStoreRoot(root)));
  for (const dir of directories) { const fd = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await fd.sync(); } finally { await fd.close(); } }
  t.installed = true; await saveHandover(root, s, key);
}
