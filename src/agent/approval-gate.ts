/** V6 local authorization only. No inference, network, tool dispatch or ledger mutation. */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { scoutWorkspaceRoot, safePath } from "./local-tools.js";
import { scoutMode } from "./opportunity-scout.js";
import { readConfined, atomicWrite, locked } from "./ledger-runner.js";
import { LEDGER_LIMITS, parseEconomicLedger, parseLedgerExperiment, experimentReference, formatCents } from "./economic-ledger.js";

const MAX_BYTES = 512 * 1024;
const MAX_REQUESTS = 100;
const REQUEST = "approval-request.json", APPROVAL = "approval.json", REPORT = "approval-report.txt";
const STATE = "state.json", KEY = "integrity-key";
const CAPABILITIES = ["real_spending", "external_account", "publication", "other_sensitive_action"] as const;
type Capability = typeof CAPABILITIES[number];
type Status = "pending" | "approved" | "denied";
export interface ApprovalRequest {
  version: 6;
  request_id: string;
  created_at: string;
  experiment_id: string;
  opportunity_name: string;
  action_summary: string[];
  max_amount_cents: number;
  currency: "EUR";
  requires_real_spending: boolean;
  requires_external_account: boolean;
  requires_publication: boolean;
  requested_capabilities: Capability[];
  experiment_hash: string;
  ledger_hash: string;
  reservation_reference: { entry_id: string; entry_hash: string; amount_cents: number } | null;
  request_fingerprint: string;
  status: Status;
}
export interface Approval {
  version: 6;
  approval_id: string;
  request_id: string;
  approved_at: string;
  experiment_id: string;
  max_amount_cents: number;
  currency: "EUR";
  approved_capabilities: Capability[];
  request_fingerprint: string;
  human_reference: string;
  status: "approved";
}
interface Denial {
  version: 6;
  request_id: string;
  denied_at: string;
  request_fingerprint: string;
  human_reference: string;
  status: "denied";
}
export interface RecordEntry { request: ApprovalRequest; decision: Approval | Denial | null }
interface State { version: 6; workspace: string; records: RecordEntry[] }
export type ApprovalCommand = { kind: "run" | "new-request" } | { kind: "approve" | "deny"; requestId: string };

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const structured = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function obj(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Approval object required");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== fields.length || Object.keys(data).some(key => !fields.includes(key))) throw new Error("Unexpected/missing approval fields");
  return data;
}
function str(value: unknown, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid approval string");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid approval hash");
  return value;
}
function id(value: unknown, prefix: string): string {
  if (typeof value !== "string" || !new RegExp(`^${prefix}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`).test(value)) throw new Error("Exact runtime request/decision id required");
  return value;
}
function timestamp(value: unknown): string {
  const s = str(value, 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== s) throw new Error("Invalid approval timestamp");
  return s;
}
function money(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 0 || value > 1000) throw new Error("Invalid approval amount");
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Strict approval boolean required");
  return value;
}
function capabilities(value: unknown): Capability[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > CAPABILITIES.length || !same(value, CAPABILITIES.filter(c => value.includes(c)))) throw new Error("Invalid capabilities/order");
  return value as Capability[];
}
function fingerprint(request: Omit<ApprovalRequest, "request_fingerprint" | "status">): string {
  return digest(JSON.stringify(request));
}
function parseRequest(value: unknown): ApprovalRequest {
  const d = obj(value, ["version", "request_id", "created_at", "experiment_id", "opportunity_name", "action_summary", "max_amount_cents", "currency",
    "requires_real_spending", "requires_external_account", "requires_publication", "requested_capabilities", "experiment_hash", "ledger_hash", "reservation_reference", "request_fingerprint", "status"]);
  if (d.version !== 6 || d.currency !== "EUR" || (typeof d.status !== "string" || !["pending", "approved", "denied"].includes(d.status))) throw new Error("Invalid approval version/currency/status");
  if (!Array.isArray(d.action_summary) || d.action_summary.length < 1 || d.action_summary.length > 5) throw new Error("Invalid approval actions");
  let reference: ApprovalRequest["reservation_reference"] = null;
  if (d.reservation_reference !== null) {
    const r = obj(d.reservation_reference, ["entry_id", "entry_hash", "amount_cents"]);
    if (typeof r.entry_id !== "string" || !/^entry-[0-9]{6}$/.test(r.entry_id)) throw new Error("Invalid reservation entry id");
    reference = { entry_id: r.entry_id, entry_hash: hash(r.entry_hash), amount_cents: money(r.amount_cents) };
  }
  const base: Omit<ApprovalRequest, "request_fingerprint" | "status"> = {
    version: 6, request_id: id(d.request_id, "request"), created_at: timestamp(d.created_at), experiment_id: hash(d.experiment_id),
    opportunity_name: str(d.opportunity_name, 120), action_summary: d.action_summary.map(s => str(s, 240)), max_amount_cents: money(d.max_amount_cents), currency: "EUR",
    requires_real_spending: bool(d.requires_real_spending), requires_external_account: bool(d.requires_external_account), requires_publication: bool(d.requires_publication),
    requested_capabilities: capabilities(d.requested_capabilities), experiment_hash: hash(d.experiment_hash), ledger_hash: hash(d.ledger_hash), reservation_reference: reference,
  };
  const expected = CAPABILITIES.filter(c => c === "real_spending" ? base.requires_real_spending : c === "external_account" ? base.requires_external_account : c === "publication" ? base.requires_publication : base.requested_capabilities.includes(c));
  if (!same(expected, base.requested_capabilities)) throw new Error("Capability flags mismatch");
  if (base.max_amount_cents > 0 && (!base.requires_real_spending || !reference || reference.amount_cents !== base.max_amount_cents)) throw new Error("Amount exceeds matching reservation");
  if (base.max_amount_cents === 0 && reference !== null) throw new Error("Unexpected zero-cost reservation");
  if (d.request_fingerprint !== fingerprint(base)) throw new Error("Request fingerprint mismatch");
  return { ...base, request_fingerprint: hash(d.request_fingerprint), status: d.status as Status };
}
function parseDecision(value: unknown, request: ApprovalRequest): Approval | Denial | null {
  if (value === null) {
    if (request.status !== "pending") throw new Error("Missing human decision");
    return null;
  }
  if (request.status === "pending") throw new Error("Pending request cannot have a decision");
  const approved = request.status === "approved";
  const d = obj(value, approved ? ["version", "approval_id", "request_id", "approved_at", "experiment_id", "max_amount_cents", "currency", "approved_capabilities", "request_fingerprint", "human_reference", "status"]
    : ["version", "request_id", "denied_at", "request_fingerprint", "human_reference", "status"]);
  if (d.version !== 6 || d.status !== request.status || d.request_id !== request.request_id || d.request_fingerprint !== request.request_fingerprint || d.human_reference !== `local-cli:${approved ? "approve" : "deny"}:${request.request_id}`) throw new Error("Decision binding mismatch");
  const time = timestamp(approved ? d.approved_at : d.denied_at);
  if (time < request.created_at) throw new Error("Decision predates request");
  if (approved) {
    if (d.experiment_id !== request.experiment_id || d.max_amount_cents !== request.max_amount_cents || d.currency !== "EUR" || !same(capabilities(d.approved_capabilities), request.requested_capabilities)) throw new Error("Approval scope mismatch");
    return { version: 6, approval_id: id(d.approval_id, "approval"), request_id: request.request_id, approved_at: time,
      experiment_id: request.experiment_id, max_amount_cents: request.max_amount_cents, currency: "EUR", approved_capabilities: request.requested_capabilities,
      request_fingerprint: request.request_fingerprint, human_reference: d.human_reference as string, status: "approved" };
  }
  return { version: 6, request_id: request.request_id, denied_at: time, request_fingerprint: request.request_fingerprint, human_reference: d.human_reference as string, status: "denied" };
}

/** Private integrity anchor is outside the only workspace exposed to model tools.
 * It authenticates local records, not a person's identity or an external payment.
 * The OS user and host process are trusted; V6 cannot defend against their compromise.
 */
export function approvalStoreRoot(root: string): string {
  return path.join(path.dirname(path.resolve(root)), `.scout-approval-${digest(path.resolve(root)).slice(0, 32)}`);
}
function mac(state: State, key: Buffer): string {
  return createHmac("sha256", key).update(JSON.stringify(state)).digest("hex");
}
function parseState(raw: string, root: string, key: Buffer): State {
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("Approval history too large");
  const d = obj(JSON.parse(raw), ["version", "workspace", "records", "mac"]);
  if (d.version !== 6 || d.workspace !== root || !Array.isArray(d.records) || d.records.length < 1 || d.records.length > MAX_REQUESTS) throw new Error("Invalid approval history");
  // Authenticate BEFORE trusting any of its content or derived views.
  const payload = { version: 6, workspace: root, records: d.records } as State;
  const supplied = Buffer.from(hash(d.mac), "hex");
  if (!timingSafeEqual(supplied, Buffer.from(mac(payload, key), "hex"))) throw new Error("Approval history authentication failed");
  const ids = new Set<string>();
  const records = d.records.map(value => {
    const entry = obj(value, ["request", "decision"]);
    const request = parseRequest(entry.request);
    if (ids.has(request.request_id)) throw new Error("Replayed request id");
    ids.add(request.request_id);
    return { request, decision: parseDecision(entry.decision, request) };
  });
  const state: State = { version: 6, workspace: root, records };
  if (!same(payload, state)) throw new Error("Noncanonical approval history");
  return state;
}
async function readInputs(root: string) {
  const experimentRaw = await readConfined(root, "experiment.json", 128 * 1024);
  const ledgerRaw = await readConfined(root, "economic-ledger.json", LEDGER_LIMITS.maxBytes);
  if (experimentRaw === undefined || ledgerRaw === undefined) throw new Error("V6 requires existing experiment.json and economic-ledger.json");
  const plan = parseLedgerExperiment(experimentRaw), ledger = parseEconomicLedger(ledgerRaw), ref = experimentReference(plan);
  const caps: Capability[] = [];
  if (plan.requires_real_spending) caps.push("real_spending");
  if (plan.requires_external_account) caps.push("external_account");
  if (plan.requires_publication) caps.push("publication");
  // V4 can flag other sensitive actions; never silently translate that flag to false.
  if (plan.requires_human_approval && !caps.length) caps.push("other_sensitive_action");
  if (!caps.length) throw new Error("No sensitive capability requested by this plan");
  let reservation: ApprovalRequest["reservation_reference"] = null;
  const entries = ledger.entries.filter(e => e.experiment?.id === ref.id);
  if (ref.budget_cents > 0) {
    const entry = entries.find(e => e.type === "reserve");
    const remaining = entries.reduce((total, e) => total + (e.type === "reserve" ? e.amount_cents : e.type === "expense" || e.type === "release" ? -e.amount_cents : 0), 0);
    if (!entry || !same(entry.experiment, ref) || entry.amount_cents !== ref.budget_cents || remaining !== ref.budget_cents) throw new Error("Amount exceeds or differs from intact V5 reservation");
    reservation = { entry_id: entry.id, entry_hash: entry.hash, amount_cents: remaining };
  } else if (entries.length) throw new Error("Unexpected reservation for zero-cost plan");
  return { experiment_id: ref.id, opportunity_name: plan.opportunity_name, action_summary: plan.actions, max_amount_cents: ref.budget_cents,
    currency: "EUR" as const, requires_real_spending: plan.requires_real_spending, requires_external_account: plan.requires_external_account, requires_publication: plan.requires_publication,
    requested_capabilities: caps, experiment_hash: digest(experimentRaw), ledger_hash: digest(ledgerRaw), reservation_reference: reservation };
}
function ensureCurrent(request: ApprovalRequest, inputs: Awaited<ReturnType<typeof readInputs>>): void {
  const { version: _v, request_id: _id, created_at: _time, request_fingerprint: _fp, status: _status, ...bound } = request;
  if (!same(bound, inputs)) throw new Error("Approval binding is stale: experiment/ledger/reservation changed; explicit --new-request required");
}
function report(entry: RecordEntry): string {
  const r = entry.request;
  return ["Scout V6 — autorisation locale uniquement", `Opportunité : ${r.opportunity_name}`, "Actions proposées (non exécutées) :",
    ...r.action_summary.map(a => `- ${a}`), `Montant maximum autorisé si approbation : ${formatCents(r.max_amount_cents)}`,
    `Capacités demandées : ${r.requested_capabilities.join(", ")}`, `Identifiant exact : ${r.request_id}`,
    `Expérience : ${r.experiment_id}`, `Empreinte : ${r.request_fingerprint}`,
    `État : ${r.status === "pending" ? "EN ATTENTE" : r.status === "approved" ? "APPROUVÉE" : "REFUSÉE"}`,
    ...(entry.decision ? [`Référence humaine locale : ${entry.decision.human_reference}`] : [
      `Approuver : SCOUT_MODE=approval node dist/index.js --approve ${r.request_id}`,
      `Refuser : SCOUT_MODE=approval node dist/index.js --deny ${r.request_id}`]),
    "Réservation ≠ approbation ≠ exécution. Le ledger est inchangé.",
    "Ce rapport seul n'est pas une autorisation : relancer V6 pour vérifier la liaison aux fichiers actuels.",
    "Aucune dépense ni action externe n'a été exécutée par Scout.", ""].join("\n");
}

/** Strict CLI grammar. No aliases, implicit yes, env/file decision, or approval-all. */
export function parseApprovalCommand(args: string[]): ApprovalCommand {
  if (args.length === 1 && (args[0] === "--run" || args[0] === "--new-request")) return { kind: args[0] === "--run" ? "run" : "new-request" };
  if (args.length === 2 && (args[0] === "--approve" || args[0] === "--deny")) return { kind: args[0] === "--approve" ? "approve" : "deny", requestId: id(args[1], "request") };
  throw new Error("Use --run, --new-request, --approve <exact_request_id> or --deny <exact_request_id>; no implicit/global approval");
}
async function views(root: string, entry?: RecordEntry): Promise<void> {
  for (const [name, expected] of [[REQUEST, entry?.request], [APPROVAL, entry?.decision?.status === "approved" ? entry.decision : undefined]] as const) {
    const raw = await readConfined(root, name, MAX_BYTES);
    if (expected === undefined ? raw !== undefined : raw === undefined || raw !== structured(expected)) throw new Error(`Modified, missing or orphan ${name}; human inspection required`);
  }
  const raw = await readConfined(root, REPORT, MAX_BYTES);
  if (entry ? raw !== report(entry) : raw !== undefined) throw new Error("Modified, missing or orphan approval-report.txt; human inspection required");
}
async function saveView(root: string, name: string, content: string): Promise<void> {
  await atomicWrite(root, name, content, raw => { if (raw !== content) throw new Error("Approval view mismatch"); });
  if (await readConfined(root, name, MAX_BYTES) !== content) throw new Error("Approval view reread failed");
}

/** Only the trusted host CLI calls this; never registered in model tools. */
export async function runApprovalScout(options: { root?: string; command?: ApprovalCommand; onEvent?: (message: string) => void } = {}): Promise<ApprovalRequest> {
  if (scoutMode() !== "approval") throw new Error("Approval requires SCOUT_MODE=approval");
  const root = path.resolve(options.root ?? scoutWorkspaceRoot());
  const supplied = options.command ?? { kind: "run" };
  // Validate host arguments too; JS callers cannot smuggle extra properties or IDs.
  obj(supplied, supplied.kind === "approve" || supplied.kind === "deny" ? ["kind", "requestId"] : ["kind"]);
  const command = parseApprovalCommand(supplied.kind === "approve" || supplied.kind === "deny" ? [`--${supplied.kind}`, supplied.requestId] : [`--${supplied.kind}`]);
  return locked(root, async () => {
    const inputs = await readInputs(root);
    const store = approvalStoreRoot(root);
    await safePath(store, STATE, true);
    // Fail closed if the private runtime anchor is writable by other OS users.
    const stat = await fs.stat(store);
    if ((stat.mode & 0o077) !== 0) throw new Error("Approval store must be private (0700)");
    let keyRaw = await readConfined(store, KEY, 65);
    const stateRaw = await readConfined(store, STATE, MAX_BYTES);
    if ((keyRaw === undefined) !== (stateRaw === undefined)) throw new Error("Incomplete approval integrity anchor; human inspection required");
    let state: State | undefined;
    if (keyRaw !== undefined) {
      if (!/^[a-f0-9]{64}\n$/.test(keyRaw)) throw new Error("Invalid approval integrity key");
      const keyStat = await fs.stat(await safePath(store, KEY));
      if ((keyStat.mode & 0o077) !== 0) throw new Error("Approval integrity key must be private (0600)");
      state = parseState(stateRaw!, root, Buffer.from(keyRaw.trim(), "hex"));
    }
    const previous = state?.records.at(-1);
    await views(root, previous); // Never repair modified or orphan output silently.
    if (command.kind === "approve" || command.kind === "deny") {
      if (!previous || previous.request.status !== "pending" || previous.request.request_id !== command.requestId) throw new Error("Exact current pending request_id required; no replay or denied-to-approved transition");
    }
    if (previous && command.kind !== "new-request") ensureCurrent(previous.request, inputs);
    if (previous && command.kind === "run") {
      options.onEvent?.(`Scout V6: ${previous.request.status}; verified current binding. No execution.`);
      return previous.request;
    }
    const records = state ? [...state.records] : [];
    let entry: RecordEntry;
    if (command.kind === "run" || command.kind === "new-request") {
      if (records.length >= MAX_REQUESTS) throw new Error("Approval history limit reached; human archival required");
      const base = { version: 6 as const, request_id: `request-${randomUUID()}`, created_at: new Date().toISOString(), ...inputs };
      entry = { request: parseRequest({ ...base, request_fingerprint: fingerprint(base), status: "pending" }), decision: null };
      records.push(entry);
    } else {
      const r = previous!.request, now = new Date().toISOString();
      const common = { version: 6 as const, request_id: r.request_id, request_fingerprint: r.request_fingerprint, human_reference: `local-cli:${command.kind}:${r.request_id}` };
      const decision: Approval | Denial = command.kind === "approve" ? {
        version: 6, approval_id: `approval-${randomUUID()}`, request_id: r.request_id, approved_at: now,
        experiment_id: r.experiment_id, max_amount_cents: r.max_amount_cents, currency: "EUR", approved_capabilities: r.requested_capabilities,
        request_fingerprint: r.request_fingerprint, human_reference: common.human_reference, status: "approved",
      } : { version: 6, request_id: r.request_id, denied_at: now, request_fingerprint: r.request_fingerprint, human_reference: common.human_reference, status: "denied" };
      entry = { request: { ...r, status: decision.status }, decision };
      records[records.length - 1] = entry;
    }
    // Detect concurrent V4 writes before committing. V5 writes share our lock.
    if (!same(await readInputs(root), inputs)) throw new Error("V4/V5 inputs changed during approval");
    await views(root, previous);
    if (keyRaw === undefined) {
      keyRaw = randomBytes(32).toString("hex") + "\n";
      const keyFile = await fs.open(await safePath(store, KEY), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await keyFile.writeFile(keyRaw); await keyFile.sync(); } finally { await keyFile.close(); }
    }
    const key = Buffer.from(keyRaw.trim(), "hex");
    const next: State = { version: 6, workspace: root, records };
    const raw = structured({ ...next, mac: mac(next, key) });
    // Journal first, then derived views. Any crash/mismatch fails closed on next
    // load; no automatic rollback, inferred approval or silent overwrite recovery.
    await atomicWrite(store, STATE, raw, s => parseState(s, root, key));
    if (await readConfined(store, STATE, MAX_BYTES) !== raw) throw new Error("Approval state reread failed");
    await saveView(root, REQUEST, structured(entry.request));
    if (entry.decision?.status === "approved") await saveView(root, APPROVAL, structured(entry.decision));
    else if (previous?.decision?.status === "approved") {
      await fs.unlink(await safePath(root, APPROVAL)); // Explicit new request revokes current view; signed history retains it.
      const dir = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await dir.sync(); } finally { await dir.close(); }
    }
    await saveView(root, REPORT, report(entry));
    ensureCurrent(entry.request, await readInputs(root));
    await views(root, entry);
    options.onEvent?.(`Scout V6: ${entry.request.status}; ${entry.request.request_id}. Authorization only; no external action or expense.`);
    return entry.request;
  });
}

/** Read-only trusted-host verification for V7. Caller must hold the shared V5 lock.
 * Historical verification does not grant current approval: current binding must
 * ALSO be checked before recording a positive expense against today's ledger.
 */
export async function readVerifiedApprovalRecords(root: string): Promise<RecordEntry[] | undefined> {
  const store = approvalStoreRoot(root);
  try { await fs.lstat(store); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await views(root);
    return undefined;
  }
  await safePath(store, STATE);
  if (((await fs.stat(store)).mode & 0o077) !== 0) throw new Error("Approval store must be private (0700)");
  const keyRaw = await readConfined(store, KEY, 65);
  const stateRaw = await readConfined(store, STATE, MAX_BYTES);
  if (keyRaw === undefined || stateRaw === undefined || !/^[a-f0-9]{64}\n$/.test(keyRaw)) throw new Error("Incomplete approval integrity anchor");
  if (((await fs.stat(await safePath(store, KEY))).mode & 0o077) !== 0) throw new Error("Approval integrity key must be private (0600)");
  const state = parseState(stateRaw, root, Buffer.from(keyRaw.trim(), "hex"));
  await views(root, state.records.at(-1));
  return state.records;
}

/** Current V4/V5 binding, with all existing V6 checks unchanged. No mutations. */
export async function verifyCurrentApprovalBinding(root: string, record: RecordEntry): Promise<void> {
  const request = parseRequest(record.request);
  parseDecision(record.decision, request);
  ensureCurrent(request, await readInputs(root));
}

/** V6's separate, non-economic approval contract for the sole V8 capability.
 * Never accepted by the economic approval parser or by V7 spending checks.
 */
export interface WebhookAction {
  version: 8; action_id: string; type: "webhook_ping"; status: "prepared"; created_at: string;
  endpoint_fingerprint: string; payload_fingerprint: string; capabilities: ["webhook_ping"];
}
export interface WebhookApprovalRequest {
  version: 6; target_version: 8; request_id: string; created_at: string; action_id: string;
  action_fingerprint: string; requested_capabilities: ["webhook_ping"]; request_fingerprint: string; status: Status;
}
interface WebhookDecision {
  version: 6; request_id: string; action_id: string; request_fingerprint: string; decided_at: string;
  approval_id: string | null; approved_capabilities: ["webhook_ping"] | []; human_reference: string; status: "approved" | "denied";
}
export interface WebhookApprovalRecord { request: WebhookApprovalRequest; decision: WebhookDecision | null }
export function parseWebhookAction(value: unknown): WebhookAction {
  const d = obj(value, ["version", "action_id", "type", "status", "created_at", "endpoint_fingerprint", "payload_fingerprint", "capabilities"]);
  if (d.version !== 8 || d.type !== "webhook_ping" || d.status !== "prepared" || !same(d.capabilities, ["webhook_ping"])) throw new Error("Only prepared webhook_ping is allowed");
  return { version: 8, action_id: id(d.action_id, "action"), type: "webhook_ping", status: "prepared", created_at: timestamp(d.created_at),
    endpoint_fingerprint: hash(d.endpoint_fingerprint), payload_fingerprint: hash(d.payload_fingerprint), capabilities: ["webhook_ping"] };
}
function webhookRequestFingerprint(base: Omit<WebhookApprovalRequest, "request_fingerprint" | "status">): string { return digest(JSON.stringify(base)); }
export function createWebhookApproval(action: WebhookAction): WebhookApprovalRecord {
  const parsed = parseWebhookAction(action);
  const base = { version: 6 as const, target_version: 8 as const, request_id: `request-${randomUUID()}`, created_at: new Date().toISOString(), action_id: parsed.action_id,
    action_fingerprint: digest(JSON.stringify(parsed)), requested_capabilities: ["webhook_ping"] as ["webhook_ping"] };
  return { request: { ...base, request_fingerprint: webhookRequestFingerprint(base), status: "pending" }, decision: null };
}
export function parseWebhookApproval(value: unknown, action: WebhookAction): WebhookApprovalRecord {
  const entry = obj(value, ["request", "decision"]), parsed = parseWebhookAction(action);
  const r = obj(entry.request, ["version", "target_version", "request_id", "created_at", "action_id", "action_fingerprint", "requested_capabilities", "request_fingerprint", "status"]);
  if (r.version !== 6 || r.target_version !== 8 || r.action_id !== parsed.action_id || r.action_fingerprint !== digest(JSON.stringify(parsed)) ||
    !same(r.requested_capabilities, ["webhook_ping"]) || (r.status !== "pending" && r.status !== "approved" && r.status !== "denied")) throw new Error("V6 webhook approval binding mismatch");
  const base = { version: 6 as const, target_version: 8 as const, request_id: id(r.request_id, "request"), created_at: timestamp(r.created_at),
    action_id: parsed.action_id, action_fingerprint: hash(r.action_fingerprint), requested_capabilities: ["webhook_ping"] as ["webhook_ping"] };
  if (base.created_at < parsed.created_at || r.request_fingerprint !== webhookRequestFingerprint(base)) throw new Error("V6 webhook fingerprint/time mismatch");
  const request: WebhookApprovalRequest = { ...base, request_fingerprint: hash(r.request_fingerprint), status: r.status };
  if (entry.decision === null) {
    if (request.status !== "pending") throw new Error("Missing V6 webhook decision");
    return { request, decision: null };
  }
  const d = obj(entry.decision, ["version", "request_id", "action_id", "request_fingerprint", "decided_at", "approval_id", "approved_capabilities", "human_reference", "status"]);
  if (request.status === "pending" || d.version !== 6 || d.status !== request.status || d.request_id !== request.request_id || d.action_id !== parsed.action_id ||
    d.request_fingerprint !== request.request_fingerprint || d.human_reference !== `local-cli:${request.status === "approved" ? "approve" : "deny"}-external:${request.request_id}` ||
    !same(d.approved_capabilities, request.status === "approved" ? ["webhook_ping"] : [])) throw new Error("Invalid scoped V6 webhook decision");
  const decidedAt = timestamp(d.decided_at);
  if (decidedAt < request.created_at || (request.status === "denied" && d.approval_id !== null)) throw new Error("Invalid webhook decision time/id");
  return { request, decision: { version: 6, request_id: request.request_id, action_id: parsed.action_id, request_fingerprint: request.request_fingerprint,
    decided_at: decidedAt, approval_id: request.status === "approved" ? id(d.approval_id, "approval") : null,
    approved_capabilities: request.status === "approved" ? ["webhook_ping"] : [], human_reference: d.human_reference as string, status: request.status } };
}
/** Called by the trusted V6 CLI only, never by a model or by execution. */
export function decideWebhookApproval(action: WebhookAction, record: WebhookApprovalRecord, requestId: string, kind: "approve" | "deny"): WebhookApprovalRecord {
  const current = parseWebhookApproval(record, action);
  if (kind !== "approve" && kind !== "deny") throw new Error("Explicit V6 decision required");
  if (id(requestId, "request") !== current.request.request_id || current.request.status !== "pending") throw new Error("Exact pending external request_id required");
  const status = kind === "approve" ? "approved" : "denied";
  return parseWebhookApproval({ request: { ...current.request, status }, decision: { version: 6, request_id: requestId, action_id: action.action_id,
    request_fingerprint: current.request.request_fingerprint, decided_at: new Date().toISOString(), approval_id: kind === "approve" ? `approval-${randomUUID()}` : null,
    approved_capabilities: kind === "approve" ? ["webhook_ping"] : [], human_reference: `local-cli:${kind}-external:${requestId}`, status } }, action);
}
