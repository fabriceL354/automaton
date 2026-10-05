/** V7: human-confirmed accounting only. No model, external API, payment or action executor. */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { safePath, scoutWorkspaceRoot } from "./local-tools.js";
import { scoutMode } from "./opportunity-scout.js";
import { atomicWrite, locked, readConfined } from "./ledger-runner.js";
import { readVerifiedApprovalRecords, verifyCurrentApprovalBinding, type RecordEntry as ApprovalRecord } from "./approval-gate.js";
import { LEDGER_LIMITS, parseEconomicLedger, parseLedgerExperiment, experimentReference, recordAuthorizedEvent, ledgerPrefix,
  buildEconomicReport, formatCents, type EconomicLedger } from "./economic-ledger.js";
import type { ExperimentPlan } from "./experiment-runner.js";

const MAX_HISTORY_BYTES = 1024 * 1024, MAX_RESULTS = 100;
const RESULT = "experiment-result.json", HISTORY = "economic-history.json", REPORT = "revenue-report.txt";
const LEDGER = "economic-ledger.json", STATE = "state.json", KEY = "integrity-key";
const OUTCOMES = ["success", "partial", "failed", "cancelled"] as const;
type Outcome = typeof OUTCOMES[number];
interface Confirmation {
  experiment_id: string; expense_cents: number; revenue_cents: number; outcome: Outcome; approval_request_id: string | null;
}
export interface RevenueCommand extends Confirmation { preview: boolean }
export interface ExperimentResult {
  version: 7; result_id: string; experiment_id: string; opportunity_name: string; recorded_at: string;
  outcome: Outcome; reserved_cents: number; expense_cents: number; revenue_cents: number; net_result_cents: number;
  released_cents: number; approval_request_id: string | null; approval_id: string | null; human_reference: string;
  source: "human_confirmed"; status: "closed"; opportunity_score: number; planned_duration_days: number;
  expected_learning: string; experiment_hash: string; ledger_entry_ids: string[];
}
interface ClosureRecord {
  confirmation: Confirmation; result: ExperimentResult; experiment_raw: string; approval: ApprovalRecord | null;
  ledger_before_count: number; ledger_before_hash: string; ledger_before_raw_hash: string;
  ledger_after_count: number; ledger_after_hash: string; ledger_after_raw_hash: string;
}
interface State { version: 7; workspace: string; phase: "prepared" | "complete"; records: ClosureRecord[] }
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const canonicalHash = (v: unknown) => digest(JSON.stringify(v));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const structured = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Revenue object required");
  const d = value as Record<string, unknown>;
  if (Object.keys(d).length !== keys.length || Object.keys(d).some(k => !keys.includes(k))) throw new Error("Unexpected or missing revenue fields");
  return d;
}
function money(v: unknown, signed = false): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || Object.is(v, -0) || v < (signed ? -LEDGER_LIMITS.maxCents : 0) || v > LEDGER_LIMITS.maxCents) throw new Error("Invalid integer cents or monetary overflow");
  return v;
}
function exactAmount(value: bigint, signed = false): number {
  if (value < (signed ? -BigInt(LEDGER_LIMITS.maxCents) : 0n) || value > BigInt(LEDGER_LIMITS.maxCents)) throw new Error("Monetary overflow");
  return Number(value);
}
function hex(v: unknown): string {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) throw new Error("Exact experiment id/hash required");
  return v;
}
function uuid(v: unknown, prefix: string): string {
  if (typeof v !== "string" || !new RegExp(`^${prefix}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`).test(v)) throw new Error("Exact runtime request/result id required");
  return v;
}
function time(v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) throw new Error("Invalid result timestamp");
  return v;
}
function confirmation(value: unknown): Confirmation {
  const d = exact(value, ["experiment_id", "expense_cents", "revenue_cents", "outcome", "approval_request_id"]);
  if (typeof d.outcome !== "string" || !OUTCOMES.includes(d.outcome as Outcome)) throw new Error("Outcome must be success, partial, failed or cancelled");
  return { experiment_id: hex(d.experiment_id), expense_cents: money(d.expense_cents), revenue_cents: money(d.revenue_cents), outcome: d.outcome as Outcome,
    approval_request_id: d.approval_request_id === null ? null : uuid(d.approval_request_id, "request") };
}
/** Human CLI only. No defaults for realized amounts, env, free text or file inputs. */
export function parseRevenueCommand(args: string[]): RevenueCommand {
  if (args[0] !== "--record-result" || args.length < 8) throw new Error("Use --record-result <exact_experiment_id> --expense-cents <integer> --revenue-cents <integer> --outcome <enum> [--approval-request-id <exact_id>] [--preview]");
  const values = new Map<string, string>(); let preview = false;
  for (let i = 2; i < args.length; i++) {
    const key = args[i];
    if (key === "--preview") { if (preview) throw new Error("Duplicate preview"); preview = true; continue; }
    if (!["--expense-cents", "--revenue-cents", "--outcome", "--approval-request-id"].includes(key) || values.has(key) || i + 1 >= args.length) throw new Error("Unknown, duplicate or missing revenue argument");
    values.set(key, args[++i]);
  }
  function cents(name: string) {
    const raw = values.get(name);
    if (raw === undefined || !/^(?:0|[1-9][0-9]{0,9})$/.test(raw)) throw new Error("Explicit decimal integer cents required");
    return money(Number(raw));
  }
  const input = confirmation({ experiment_id: args[1], expense_cents: cents("--expense-cents"), revenue_cents: cents("--revenue-cents"),
    outcome: values.get("--outcome"), approval_request_id: values.get("--approval-request-id") ?? null });
  return { ...input, preview };
}
function validateCommand(value: RevenueCommand): RevenueCommand {
  exact(value, ["experiment_id", "expense_cents", "revenue_cents", "outcome", "approval_request_id", "preview"]);
  const { preview, ...fields } = value;
  if (typeof preview !== "boolean") throw new Error("Strict preview boolean required");
  return { ...confirmation(fields), preview };
}
function reservation(ledger: EconomicLedger, plan: ExperimentPlan): number {
  const ref = experimentReference(plan), entries = ledger.entries.filter(e => e.experiment?.id === ref.id);
  if (ref.budget_cents === 0) { if (entries.length) throw new Error("Unexpected zero-cost reservation"); return 0; }
  const entry = entries.find(e => e.type === "reserve");
  if (!entry || !same(entry.experiment, ref) || entry.amount_cents !== ref.budget_cents || entries.length !== 1) throw new Error("Intact matching active V5 reservation required");
  return entry.amount_cents;
}
function scope(input: Confirmation, plan: ExperimentPlan, reserved: number, approval: ApprovalRecord | null): void {
  if (input.experiment_id !== experimentReference(plan).id) throw new Error("Wrong experiment_id");
  if (input.expense_cents > reserved) throw new Error("Expense exceeds active reservation");
  if (approval && approval.request.experiment_id !== input.experiment_id) throw new Error("Approval belongs to another experiment");
  if (input.approval_request_id !== null && input.approval_request_id !== approval?.request.request_id) throw new Error("Wrong approval request_id");
  if (input.expense_cents > 0) {
    if (!plan.requires_real_spending || !input.approval_request_id || !approval || approval.request.status !== "approved" || approval.decision?.status !== "approved") throw new Error("Positive expense requires explicit current approved V6 request_id");
    if (!approval.request.requested_capabilities.includes("real_spending") || !approval.decision.approved_capabilities.includes("real_spending") ||
      approval.decision.max_amount_cents < input.expense_cents || approval.decision.max_amount_cents !== reserved) throw new Error("Insufficient approval amount or real_spending capability");
  }
}
const human = (resultId: string) => `local-cli:record-result:${resultId}`;
const description = (kind: "expense" | "release" | "revenue", experimentId: string) =>
  `${kind === "expense" ? "Dépense confirmée par l'humain" : kind === "revenue" ? "Revenu confirmé par l'humain" : "Reliquat libéré à la clôture"} ; expérience ${experimentId}`;
function events(input: Confirmation, reserved: number) {
  return ([{ type: "expense", amount: input.expense_cents }, { type: "release", amount: reserved - input.expense_cents },
    { type: "revenue", amount: input.revenue_cents }] as const).filter(e => e.amount > 0);
}
function apply(ledger: EconomicLedger, input: Confirmation, reserved: number, resultId: string): EconomicLedger {
  let next = ledger;
  for (const event of events(input, reserved)) {
    const shared = { amount_cents: event.amount, description: description(event.type, input.experiment_id),
      authorization: { source: "human" as const, reference: `${human(resultId)}:${event.type}` } };
    next = recordAuthorizedEvent(next, event.type === "revenue" ? { type: "revenue", ...shared } : { type: event.type, experiment_id: input.experiment_id, ...shared });
  }
  return next;
}
function makeResult(input: Confirmation, plan: ExperimentPlan, raw: string, reserved: number, approval: ApprovalRecord | null,
  resultId: string, recordedAt: string, entryIds: string[]): ExperimentResult {
  return { version: 7, result_id: uuid(resultId, "result"), experiment_id: input.experiment_id, opportunity_name: plan.opportunity_name, recorded_at: time(recordedAt),
    outcome: input.outcome, reserved_cents: reserved, expense_cents: input.expense_cents, revenue_cents: input.revenue_cents,
    net_result_cents: exactAmount(BigInt(input.revenue_cents) - BigInt(input.expense_cents), true), released_cents: reserved - input.expense_cents,
    approval_request_id: approval?.request.request_id ?? null, approval_id: approval?.decision?.status === "approved" ? approval.decision.approval_id : null,
    human_reference: human(resultId), source: "human_confirmed", status: "closed", opportunity_score: plan.opportunity_score,
    planned_duration_days: plan.duration_days, expected_learning: plan.expected_learning, experiment_hash: digest(raw), ledger_entry_ids: entryIds };
}
export function revenueStoreRoot(root: string): string {
  return path.join(path.dirname(path.resolve(root)), `.scout-revenue-${digest(path.resolve(root)).slice(0, 32)}`);
}
const sign = (state: State, key: Buffer) => createHmac("sha256", key).update(JSON.stringify(state)).digest("hex");
async function loadState(root: string): Promise<{ state?: State; key?: Buffer }> {
  const store = revenueStoreRoot(root);
  try { await fs.lstat(store); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  await safePath(store, STATE);
  if (((await fs.stat(store)).mode & 0o077) !== 0) throw new Error("Revenue store must be private (0700)");
  const rawKey = await readConfined(store, KEY, 65), raw = await readConfined(store, STATE, MAX_HISTORY_BYTES);
  if (rawKey === undefined || raw === undefined || !/^[a-f0-9]{64}\n$/.test(rawKey)) throw new Error("Incomplete revenue anchor; human inspection required");
  if (((await fs.stat(await safePath(store, KEY))).mode & 0o077) !== 0) throw new Error("Revenue integrity key must be private (0600)");
  const key = Buffer.from(rawKey.trim(), "hex");
  const d = exact(JSON.parse(raw), ["version", "workspace", "phase", "records", "mac"]);
  if (d.version !== 7 || d.workspace !== root || !["prepared", "complete"].includes(d.phase as string) || !Array.isArray(d.records) || !d.records.length || d.records.length > MAX_RESULTS) throw new Error("Invalid revenue state");
  const state = { version: 7, workspace: root, phase: d.phase, records: d.records } as State;
  if (!timingSafeEqual(Buffer.from(hex(d.mac), "hex"), Buffer.from(sign(state, key), "hex"))) throw new Error("Revenue state authentication failed");
  if (state.phase !== "complete") throw new Error("Incomplete revenue transaction; human inspection required; no automatic replay");
  return { state, key };
}
function audit(records: ClosureRecord[], ledger: EconomicLedger, approvals: ApprovalRecord[] | undefined): void {
  const ids = new Set<string>(); let previousCount = 0;
  for (const record of records) {
    exact(record, ["confirmation", "result", "experiment_raw", "approval", "ledger_before_count", "ledger_before_hash", "ledger_before_raw_hash", "ledger_after_count", "ledger_after_hash", "ledger_after_raw_hash"]);
    const input = confirmation(record.confirmation);
    if (typeof record.experiment_raw !== "string" || Buffer.byteLength(record.experiment_raw) > 128 * 1024) throw new Error("Invalid archived experiment");
    const plan = parseLedgerExperiment(record.experiment_raw);
    const before = ledgerPrefix(ledger, record.ledger_before_count), after = ledgerPrefix(ledger, record.ledger_after_count);
    if (record.ledger_before_count < previousCount || record.ledger_after_count < record.ledger_before_count ||
      canonicalHash(before) !== hex(record.ledger_before_hash) || canonicalHash(after) !== hex(record.ledger_after_hash)) throw new Error("Revenue ledger history mismatch");
    hex(record.ledger_before_raw_hash); hex(record.ledger_after_raw_hash);
    previousCount = record.ledger_after_count;
    if (record.approval !== null) {
      const historical = approvals?.find(e => e.request.request_id === record.approval!.request.request_id);
      if (!historical || !same(historical, record.approval) || historical.request.experiment_hash !== digest(record.experiment_raw) || historical.request.ledger_hash !== record.ledger_before_raw_hash) throw new Error("Historical approval changed or missing");
    }
    const reserved = reservation(before, plan);
    scope(input, plan, reserved, record.approval);
    const expectedEvents = events(input, reserved), actualEvents = after.entries.slice(before.entries.length);
    if (actualEvents.length !== expectedEvents.length) throw new Error("Revenue event count mismatch");
    actualEvents.forEach((entry, index) => {
      const expected = expectedEvents[index];
      if (entry.type !== expected.type || entry.amount_cents !== expected.amount || entry.description !== description(expected.type, input.experiment_id) ||
        entry.human_reference !== `${human(record.result.result_id)}:${expected.type}` ||
        !same(entry.experiment, expected.type === "revenue" ? null : experimentReference(plan))) throw new Error("Revenue event binding mismatch");
    });
    const expected = makeResult(input, plan, record.experiment_raw, reserved, record.approval, record.result.result_id, record.result.recorded_at, actualEvents.map(e => e.id));
    if (!same(record.result, expected) || ids.has(input.experiment_id) || ids.has(expected.result_id)) throw new Error("Invalid/repeated experiment result");
    ids.add(input.experiment_id); ids.add(expected.result_id);
  }
}
function memory(records: ClosureRecord[]) {
  const results = records.map(r => r.result);
  const expense = exactAmount(results.reduce((s, r) => s + BigInt(r.expense_cents), 0n));
  const revenue = exactAmount(results.reduce((s, r) => s + BigInt(r.revenue_cents), 0n));
  return { version: 7, results, metrics: { closed_experiments: results.length,
    outcomes: Object.fromEntries(OUTCOMES.map(o => [o, results.filter(r => r.outcome === o).length])),
    expense_cents: expense, gross_revenue_cents: revenue, net_result_cents: exactAmount(BigInt(revenue) - BigInt(expense), true) } };
}
function report(result: ExperimentResult, ledger: EconomicLedger, preview = false): string {
  return [preview ? "Scout V7 — APERÇU : aucune clôture enregistrée" : "Scout V7 — résultat confirmé par l'humain ; expérience clôturée",
    `Expérience : ${result.opportunity_name} (${result.experiment_id})`, `Outcome : ${result.outcome}`,
    `Budget réservé : ${formatCents(result.reserved_cents)}`, `Dépense ${preview ? "proposée" : "confirmée"} : ${formatCents(result.expense_cents)}`,
    `Revenu ${preview ? "proposé" : "confirmé"} : ${formatCents(result.revenue_cents)}`, `Réservation ${preview ? "à libérer" : "libérée"} : ${formatCents(result.released_cents)}`,
    `Résultat net : ${formatCents(result.net_result_cents)}`, `Disponible après clôture${preview ? " (projeté)" : ""} : ${formatCents(ledger.available_balance_cents)}`,
    `Total dépenses : ${formatCents(ledger.total_recorded_expenses_cents)}`, `Total revenus : ${formatCents(ledger.total_recorded_revenue_cents)}`,
    `Résultat net cumulé : ${formatCents(ledger.realized_net_result_cents)}`, `Statut ${preview ? "proposé" : "enregistré"} : closed`,
    ...(preview ? ["Aperçu uniquement : les montants ne sont pas enregistrés et ne constituent pas une confirmation."] : [
      `Résultat : ${result.result_id}`, `Référence humaine : ${result.human_reference}`, "Les montants réalisés ont été déclarés explicitement par l'utilisateur."]),
    "Scout n'a exécuté aucun paiement ni transaction externe.", ""].join("\n");
}
async function views(root: string, records: ClosureRecord[], ledger: EconomicLedger): Promise<void> {
  const last = records.at(-1);
  const expected = last ? [structured(last.result), structured(memory(records)), report(last.result, ledgerPrefix(ledger, last.ledger_after_count))] : [undefined, undefined, undefined];
  for (const [index, name] of [RESULT, HISTORY, REPORT].entries()) {
    if (await readConfined(root, name, MAX_HISTORY_BYTES) !== expected[index]) throw new Error(`Modified, missing or orphan ${name}; human inspection required`);
  }
}
async function writeView(root: string, name: string, content: string): Promise<void> {
  if (Buffer.byteLength(content) > MAX_HISTORY_BYTES) throw new Error("Revenue artifact size limit");
  await atomicWrite(root, name, content, raw => { if (raw !== content) throw new Error("Revenue write verification failed"); });
  if (await readConfined(root, name, MAX_HISTORY_BYTES) !== content) throw new Error("Revenue reread failed");
}
async function persistState(root: string, state: State, key: Buffer): Promise<void> {
  const raw = structured({ ...state, mac: sign(state, key) });
  if (Buffer.byteLength(raw) > MAX_HISTORY_BYTES) throw new Error("Revenue history size limit");
  await atomicWrite(revenueStoreRoot(root), STATE, raw, value => { if (value !== raw) throw new Error("Revenue journal write mismatch"); });
  if (await readConfined(revenueStoreRoot(root), STATE, MAX_HISTORY_BYTES) !== raw) throw new Error("Revenue journal reread mismatch");
}
async function inputFiles(root: string) {
  const planRaw = await readConfined(root, "experiment.json", 128 * 1024), ledgerRaw = await readConfined(root, LEDGER, LEDGER_LIMITS.maxBytes);
  if (planRaw === undefined || ledgerRaw === undefined) throw new Error("Revenue requires existing V4 experiment and V5 ledger");
  return { planRaw, ledgerRaw, plan: parseLedgerExperiment(planRaw), ledger: parseEconomicLedger(ledgerRaw) };
}

/** Host CLI only. Shared lock covers validation, all events, journal and final views. */
export async function runRevenueScout(options: { root?: string; command: RevenueCommand; onEvent?: (message: string) => void }): Promise<{ result: ExperimentResult; preview: boolean; report: string }> {
  if (scoutMode() !== "revenue") throw new Error("Revenue requires SCOUT_MODE=revenue");
  const command = validateCommand(options.command), { preview, ...input } = command;
  const root = path.resolve(options.root ?? scoutWorkspaceRoot());
  // Do not silently create a missing workspace in a supposedly read-only preview.
  await safePath(root, LEDGER);
  return locked(root, async () => {
    const current = await inputFiles(root);
    if (experimentReference(current.plan).id !== input.experiment_id) throw new Error("Wrong experiment_id");
    const approvals = await readVerifiedApprovalRecords(root);
    const { state, key: storedKey } = await loadState(root), records = state?.records ?? [];
    audit(records, current.ledger, approvals);
    const last = records.at(-1);
    if (last && current.ledger.entries.length === last.ledger_after_count && digest(current.ledgerRaw) !== last.ledger_after_raw_hash) throw new Error("Closed ledger bytes changed");
    await views(root, records, current.ledger);
    const existing = records.find(r => r.result.experiment_id === input.experiment_id);
    if (existing) {
      if (current.planRaw !== existing.experiment_raw) throw new Error("Closed experiment changed");
      if (!same(input, existing.confirmation)) throw new Error("Experiment already closed with different confirmation");
      const message = report(existing.result, ledgerPrefix(current.ledger, existing.ledger_after_count), preview);
      options.onEvent?.(`Already closed; no duplicate event.\n${message}`);
      return { result: existing.result, preview, report: message };
    }
    if (records.length >= MAX_RESULTS) throw new Error("Revenue history limit reached");
    const reserved = reservation(current.ledger, current.plan), approval = approvals?.at(-1) ?? null;
    if (approval) await verifyCurrentApprovalBinding(root, approval); // Also reject corrupt/stale existing V6 at expense=0.
    scope(input, current.plan, reserved, approval);
    const resultId = `result-${randomUUID()}`, recordedAt = new Date().toISOString();
    const next = apply(current.ledger, input, reserved, resultId);
    const result = makeResult(input, current.plan, current.planRaw, reserved, approval, resultId, recordedAt, next.entries.slice(current.ledger.entries.length).map(e => e.id));
    const nextRaw = same(next, current.ledger) ? current.ledgerRaw : structured(next);
    const record: ClosureRecord = { confirmation: input, result, experiment_raw: current.planRaw, approval,
      ledger_before_count: current.ledger.entries.length, ledger_before_hash: canonicalHash(current.ledger), ledger_before_raw_hash: digest(current.ledgerRaw),
      ledger_after_count: next.entries.length, ledger_after_hash: canonicalHash(next), ledger_after_raw_hash: digest(nextRaw) };
    const nextRecords = [...records, record];
    audit(nextRecords, next, approvals);
    const nextState: State = { version: 7, workspace: root, phase: "prepared", records: nextRecords };
    const publicHistory = structured(memory(nextRecords));
    if (Buffer.byteLength(structured({ ...nextState, mac: "0".repeat(64) })) > MAX_HISTORY_BYTES || Buffer.byteLength(publicHistory) > MAX_HISTORY_BYTES) throw new Error("Revenue history size limit");
    const message = report(result, next, preview);
    for (const name of [RESULT, HISTORY, REPORT, "economic-report.txt", LEDGER]) await safePath(root, name);
    // Verify snapshots before any persistence, including preview's final read.
    if (!same(await inputFiles(root), current) || !same(await readVerifiedApprovalRecords(root), approvals)) throw new Error("Inputs changed during revenue operation");
    await views(root, records, current.ledger);
    if (preview) { options.onEvent?.(message); return { result, preview: true, report: message }; }
    let key = storedKey;
    if (!key) {
      const store = revenueStoreRoot(root); await safePath(store, KEY, true);
      key = randomBytes(32);
      const file = await fs.open(await safePath(store, KEY), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(key.toString("hex") + "\n"); await file.sync(); } finally { await file.close(); }
    }
    // Durable intent first. Any partial commit remains prepared and blocks all
    // future closes; never automatically replay a human financial confirmation.
    await persistState(root, nextState, key);
    if (!same(await inputFiles(root), current) || !same(await readVerifiedApprovalRecords(root), approvals)) throw new Error("Inputs changed before ledger commit");
    if (nextRaw !== current.ledgerRaw) await atomicWrite(root, LEDGER, nextRaw, parseEconomicLedger);
    if (await readConfined(root, LEDGER, LEDGER_LIMITS.maxBytes) !== nextRaw) throw new Error("Revenue ledger reread mismatch");
    await writeView(root, RESULT, structured(result));
    await writeView(root, HISTORY, publicHistory);
    await writeView(root, REPORT, message);
    await writeView(root, "economic-report.txt", buildEconomicReport(next, current.plan));
    const finalInputs = await inputFiles(root);
    if (finalInputs.planRaw !== current.planRaw || finalInputs.ledgerRaw !== nextRaw || !same(await readVerifiedApprovalRecords(root), approvals)) throw new Error("Inputs changed during revenue commit");
    await views(root, nextRecords, next);
    await persistState(root, { ...nextState, phase: "complete" }, key);
    options.onEvent?.(message);
    return { result, preview: false, report: message };
  });
}
