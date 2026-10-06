/** V9 replayable state machine. The V5 ledger remains the financial authority. */
import { createHash } from "node:crypto";
import { createProjectApproval, decideProjectApproval, parseProjectApproval, type RecordEntry, type ProjectApprovalScope } from "./approval-gate.js";
import { PROJECT_LIMITS, assetMetrics, closeAsset, experimentTiming, integerCents, type ProjectAsset, type Classification } from "./asset-lifecycle.js";
import { type EconomicLedger, type ExperimentReference, type AuthorizedLedgerEvent } from "./economic-ledger.js";
export const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export const canonicalHash = (v: unknown) => digest(JSON.stringify(v));
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const structured = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
export function exact(v: unknown, fields: string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== fields.length || Object.keys(v).some(k => !fields.includes(k))) throw new Error("Unexpected/missing V9 fields");
  return v as Record<string, unknown>;
}
export function uuid(v: unknown, prefix: string): string {
  if (typeof v !== "string" || !new RegExp(`^${prefix}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`).test(v)) throw new Error(`Exact ${prefix} ID required`);
  return v;
}
export function hex(v: unknown): string { if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) throw new Error("Exact experiment ID/fingerprint required"); return v; }
export function time(v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) throw new Error("Invalid V9 timestamp"); return v;
}
function text(v: unknown, max: number): string { if (typeof v !== "string" || !v.trim() || v.length > max || /[\x00-\x1f\x7f]/.test(v)) throw new Error("Invalid project text"); return v; }
const grammar = {
  "create-batch": [], "list-projects": [], "inspect-project": [],
  "create-project": ["name", "hypothesis", "budget-cents", "duration-days"],
  "reserve-project": ["experiment-id"], "approve-project": ["experiment-id", "request-id"],
  "deny-project": ["experiment-id", "request-id"], "start-project": ["experiment-id", "request-id"],
  "cancel-project": ["experiment-id"], "create-asset": ["experiment-id"],
  "activate-asset": ["experiment-id", "asset-id"], "retire-asset": ["experiment-id", "asset-id"],
  "close-experiment": ["experiment-id", "request-id", "expense-cents", "revenue-cents", "classification", "asset-policy"],
  "record-passive-revenue": ["experiment-id", "asset-id", "receipt-id", "revenue-cents"],
  "link-external-action": ["experiment-id", "action-id", "request-id"],
} as const;
export type ProjectOperation = keyof typeof grammar;
export interface ProjectCommand { operation: ProjectOperation; target: string | null; fields: Record<string, string>; preview: boolean }
export function parseProjectCommand(args: string[]): ProjectCommand {
  const operation = args[0]?.replace(/^--/, "") as ProjectOperation;
  if (!args[0]?.startsWith("--") || !Object.hasOwn(grammar, operation)) throw new Error("Unknown V9 command");
  const noTarget = operation === "create-batch" || operation === "list-projects";
  const target = noTarget ? null : operation === "create-project" ? uuid(args[1], "batch") : uuid(args[1], "project");
  const allowed: readonly string[] = grammar[operation], fields: Record<string, string> = {}; let preview = false;
  for (let i = noTarget ? 1 : 2; i < args.length; i++) {
    if (args[i] === "--preview") { if (preview || operation === "list-projects" || operation === "inspect-project") throw new Error("Invalid duplicate/read-only preview"); preview = true; continue; }
    const key = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || !allowed.includes(key) || Object.hasOwn(fields, key) || i + 1 >= args.length) throw new Error("Unknown/duplicate/missing V9 argument");
    fields[key] = args[++i];
  }
  if (Object.keys(fields).length !== allowed.length) throw new Error("Missing explicit V9 fields");
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== "string") throw new Error("String CLI field required");
    if (key.endsWith("-cents") || key === "duration-days") {
      if (!/^(?:0|[1-9][0-9]{0,9})$/.test(value)) throw new Error("Unambiguous decimal integer required");
      integerCents(Number(value));
    }
    if (key === "experiment-id") hex(value);
    if (["request-id", "asset-id", "receipt-id", "action-id"].includes(key)) uuid(value, key.slice(0, -3));
  }
  if (operation === "create-project") {
    text(fields.name, 120); text(fields.hypothesis, 500);
    if (+fields["budget-cents"] > PROJECT_LIMITS.MAX_PROJECT_BUDGET_CENTS) throw new Error("Project budget exceeds 1000 cents");
    if (+fields["duration-days"] < 1 || +fields["duration-days"] > PROJECT_LIMITS.MAX_EXPERIMENT_DURATION_DAYS) throw new Error("Duration must be 1..7 days");
  }
  if (operation === "close-experiment") {
    if (!["successful", "failed", "inconclusive", "cancelled"].includes(fields.classification)) throw new Error("Invalid experiment classification");
    if (!["keep", "retire"].includes(fields["asset-policy"])) throw new Error("Explicit asset policy required");
  }
  if (operation === "record-passive-revenue" && +fields["revenue-cents"] === 0) throw new Error("Passive revenue must be positive");
  return { operation, target, fields: Object.fromEntries(allowed.map(k => [k, fields[k]])), preview };
}
export function validateProjectCommand(v: ProjectCommand): ProjectCommand {
  exact(v, ["operation", "target", "fields", "preview"]);
  if (typeof v.preview !== "boolean" || !Object.hasOwn(grammar, v.operation)) throw new Error("Invalid V9 command");
  exact(v.fields, [...grammar[v.operation]]);
  const parsed = parseProjectCommand([`--${v.operation}`, ...(v.target === null ? [] : [v.target]),
    ...Object.entries(v.fields).flatMap(([k, value]) => [`--${k}`, value]), ...(v.preview ? ["--preview"] : [])]);
  if (parsed.target !== v.target) throw new Error("Unexpected V9 target"); return parsed;
}
export interface ProjectPlan { project_id: string; batch_id: string; name: string; hypothesis: string; budget_cents: number; duration_days: number; created_at: string }
export interface ProjectResult { result_id: string; project_id: string; experiment_id: string; closed_at: string; classification: Classification;
  experiment_expense_cents: number; experiment_revenue_cents: number; experiment_net_result_cents: number; released_cents: number; ledger_entry_ids: string[] }
export interface ExternalProjectLink { project_id: string; experiment_id: string; action_id: string; request_id: string; action_fingerprint: string; request_fingerprint: string }
export interface Project {
  plan: ProjectPlan; experiment_id: string; status: "planned" | "reserved" | "approved" | "active" | "experiment_closed" | "fully_closed" | "cancelled";
  approval_scope: ProjectApprovalScope | null; approval: RecordEntry | null;
  started_at: string | null; experiment_deadline: string | null; closed_at: string | null;
  asset: ProjectAsset | null; result: ProjectResult | null;
  passive_receipts: { receipt_id: string; amount_cents: number; recorded_at: string; ledger_entry_ids: string[] }[];
  external_actions: ExternalProjectLink[];
}
export interface ProjectBatch { version: 9; batch_id: string; max_projects: 2; max_total_budget_cents: 2000; created_at: string; status: "prepared"; project_ids: string[] }
export interface ProjectModel { batch: ProjectBatch | null; projects: Project[] }
export interface ProjectEvent {
  event_id: string; at: string; new_id: string | null; command: ProjectCommand; external: ExternalProjectLink | null;
  ledger_before_count: number; ledger_before_hash: string; ledger_after_count: number; ledger_after_hash: string; ledger_entry_ids: string[];
}
export function findProject(model: ProjectModel, target: string | null, experiment?: string): Project {
  uuid(target, "project"); const project = model.projects.find(p => p.plan.project_id === target);
  if (!project || (experiment !== undefined && project.experiment_id !== experiment)) throw new Error("Exact matching project/experiment required");
  return project;
}
export function reference(p: Project): ExperimentReference { return { id: p.experiment_id, name: p.plan.name, budget_cents: p.plan.budget_cents, requires_real_spending: true, requires_human_approval: true }; }
export function projectMetrics(p: Project) { return assetMetrics(p.result?.experiment_expense_cents ?? 0, p.result?.experiment_revenue_cents ?? 0,
  p.passive_receipts.reduce((s, r) => integerCents(s + r.amount_cents), 0)); }
export function requireLive(p: Project, at: string) {
  if (p.started_at && at < p.started_at) throw new Error("Clock moved backwards before project start");
  if (p.status !== "active" || experimentTiming(p.started_at, p.experiment_deadline, p.closed_at, at).activity !== "active") throw new Error("Project not active or expired; closure required");
}
function requireApproval(p: Project, requestId: string) {
  if (!p.approval || !p.approval_scope) throw new Error("Project approval required");
  const a = parseProjectApproval(p.approval, p.approval_scope);
  if (a.request.request_id !== requestId || a.request.status !== "approved" || a.decision?.status !== "approved") throw new Error("Exact approved project request required");
}
export type ProjectLedgerChange = { type: "reserve"; reference: ExperimentReference } | AuthorizedLedgerEvent;
/** Economic commands share V5's append/replay implementation. Nothing spends money. */
export function economicChanges(model: ProjectModel, c: ProjectCommand, eventId: string): ProjectLedgerChange[] {
  if (!["reserve-project", "cancel-project", "close-experiment", "record-passive-revenue"].includes(c.operation)) return [];
  const p = findProject(model, c.target, c.fields["experiment-id"]);
  if (c.operation === "reserve-project") return p.plan.budget_cents ? [{ type: "reserve", reference: reference(p) }] : [];
  const changes: ProjectLedgerChange[] = [];
  const add = (type: "expense" | "release" | "revenue", amount: number) => {
    if (!amount) return;
    const common = { amount_cents: integerCents(amount), description: `V9 ${type}; project ${p.plan.project_id}; experiment ${p.experiment_id}`,
      authorization: { source: "human" as const, reference: `local-cli:v9:${eventId}:${type}` } };
    changes.push(type === "revenue" ? { type, ...common } : { type, experiment_id: p.experiment_id, ...common });
  };
  if (c.operation === "cancel-project") { if (p.status !== "planned") add("release", p.plan.budget_cents); }
  else if (c.operation === "close-experiment") {
    const expense = +c.fields["expense-cents"]; if (expense > p.plan.budget_cents) throw new Error("Expense exceeds project reservation");
    add("expense", expense); add("release", p.plan.budget_cents - expense); add("revenue", +c.fields["revenue-cents"]);
  } else add("revenue", +c.fields["revenue-cents"]);
  return changes;
}
export function transition(model: ProjectModel, event: ProjectEvent, before: EconomicLedger, after: EconomicLedger): ProjectModel {
  const c = validateProjectCommand(event.command), at = time(event.at), f = c.fields;
  uuid(event.event_id, "projectevent");
  if (c.preview || c.operation === "list-projects" || c.operation === "inspect-project") throw new Error("Read-only command in history");
  const expectedPrefix: Partial<Record<ProjectOperation, string>> = { "create-batch": "batch", "create-project": "project", "reserve-project": "request", "approve-project": "approval", "create-asset": "asset" };
  const prefix = expectedPrefix[c.operation]; if (prefix) uuid(event.new_id, prefix); else if (event.new_id !== null) throw new Error("Unexpected generated ID");
  if (c.operation !== "link-external-action" && event.external !== null) throw new Error("Unexpected external binding");
  const next = structuredClone(model);
  if (c.operation === "create-batch") {
    if (next.batch) throw new Error("Batch #1 already exists; no implicit/new batch");
    next.batch = { version: 9, batch_id: event.new_id!, max_projects: 2, max_total_budget_cents: 2000, created_at: at, status: "prepared", project_ids: [] }; return next;
  }
  if (!next.batch) throw new Error("Create batch explicitly first");
  if (c.operation === "create-project") {
    if (next.batch.batch_id !== c.target) throw new Error("Exact batch ID required");
    if (next.projects.length >= PROJECT_LIMITS.MAX_ACTIVE_PROJECTS) throw new Error("Batch limited to two projects, including closed projects");
    if (next.projects.reduce((s, p) => s + p.plan.budget_cents, 0) + +f["budget-cents"] > PROJECT_LIMITS.MAX_BATCH_BUDGET_CENTS) throw new Error("Batch exceeds 2000 cents");
    if (next.projects.some(p => p.plan.project_id === event.new_id || p.plan.name === f.name)) throw new Error("Duplicate project ID/name");
    const plan: ProjectPlan = { project_id: event.new_id!, batch_id: next.batch.batch_id, name: f.name, hypothesis: f.hypothesis,
      budget_cents: +f["budget-cents"], duration_days: +f["duration-days"], created_at: at };
    next.projects.push({ plan, experiment_id: canonicalHash(plan), status: "planned", approval_scope: null, approval: null,
      started_at: null, experiment_deadline: null, closed_at: null, asset: null, result: null, passive_receipts: [], external_actions: [] });
    next.batch.project_ids.push(plan.project_id); return next;
  }
  const p = findProject(next, c.target, f["experiment-id"]);
  if (at < p.plan.created_at || (p.started_at && at < p.started_at)) throw new Error("Clock moved backwards");
  switch (c.operation) {
    case "reserve-project": {
      if (p.status !== "planned") throw new Error("Only planned projects can reserve");
      const entry = after.entries.find(e => e.type === "reserve" && e.experiment?.id === p.experiment_id);
      p.approval_scope = { project_id: p.plan.project_id, experiment_id: p.experiment_id, plan_hash: canonicalHash(p.plan), name: p.plan.name,
        max_amount_cents: p.plan.budget_cents, ledger_hash: canonicalHash(after),
        reservation_reference: entry ? { entry_id: entry.id, entry_hash: entry.hash, amount_cents: entry.amount_cents } : null };
      p.approval = createProjectApproval(p.approval_scope, event.new_id!, at); p.status = "reserved"; break;
    }
    case "approve-project": case "deny-project": {
      if (p.status !== "reserved" || !p.approval || !p.approval_scope) throw new Error("Only reserved pending projects can be decided");
      p.approval = decideProjectApproval(p.approval, p.approval_scope, f["request-id"], c.operation === "approve-project" ? "approve" : "deny", at, event.new_id);
      if (c.operation === "approve-project") p.status = "approved"; break;
    }
    case "start-project": {
      if (p.status !== "approved") throw new Error("Only approved projects can start"); requireApproval(p, f["request-id"]);
      p.status = "active"; p.started_at = at; p.experiment_deadline = new Date(Date.parse(at) + p.plan.duration_days * 86_400_000).toISOString(); break;
    }
    case "cancel-project": {
      if (!["planned", "reserved", "approved"].includes(p.status)) throw new Error("Only unstarted projects can cancel; close started experiments explicitly");
      p.status = "cancelled"; p.closed_at = at; break;
    }
    case "create-asset": {
      requireLive(p, at); if (p.asset) throw new Error("Only one initial asset allowed");
      p.asset = { asset_id: event.new_id!, status: "created", created_at: at, retired_at: null }; break;
    }
    case "activate-asset": {
      requireLive(p, at); if (!p.asset || p.asset.asset_id !== f["asset-id"] || p.asset.status !== "created") throw new Error("Exact created asset required");
      p.asset.status = "active"; break;
    }
    case "close-experiment": {
      if (p.status !== "active" || p.result) throw new Error("Experiment already closed or not started");
      requireApproval(p, f["request-id"]);
      const expense = +f["expense-cents"], revenue = +f["revenue-cents"];
      if (expense > p.plan.budget_cents) throw new Error("Expense exceeds reservation");
      p.asset = closeAsset(p.asset, f["asset-policy"] as "keep" | "retire", at);
      p.closed_at = at; p.status = p.asset?.status === "passive_monitoring" ? "experiment_closed" : "fully_closed";
      p.result = { result_id: event.event_id, project_id: p.plan.project_id, experiment_id: p.experiment_id, closed_at: at,
        classification: f.classification as Classification, experiment_expense_cents: expense, experiment_revenue_cents: revenue,
        experiment_net_result_cents: integerCents(revenue - expense, true), released_cents: p.plan.budget_cents - expense, ledger_entry_ids: event.ledger_entry_ids }; break;
    }
    case "record-passive-revenue": {
      if (p.status !== "experiment_closed" || !p.result || !p.asset || p.asset.asset_id !== f["asset-id"] || p.asset.status !== "passive_monitoring") throw new Error("Exact passive asset on closed experiment required");
      if (next.projects.some(item => item.passive_receipts.some(r => r.receipt_id === f["receipt-id"]))) throw new Error("Duplicate passive revenue receipt");
      p.passive_receipts.push({ receipt_id: f["receipt-id"], amount_cents: +f["revenue-cents"], recorded_at: at, ledger_entry_ids: event.ledger_entry_ids }); break;
    }
    case "retire-asset": {
      if (p.status !== "experiment_closed" || !p.asset || p.asset.asset_id !== f["asset-id"] || p.asset.status !== "passive_monitoring") throw new Error("Exact passive asset required for retirement");
      p.asset.status = "retired"; p.asset.retired_at = at; p.status = "fully_closed"; break;
    }
    case "link-external-action": {
      requireLive(p, at); requireApproval(p, p.approval!.request.request_id);
      const link = event.external;
      exact(link, ["project_id", "experiment_id", "action_id", "request_id", "action_fingerprint", "request_fingerprint"]);
      if (!link || link.project_id !== p.plan.project_id || link.experiment_id !== p.experiment_id || link.action_id !== f["action-id"] || link.request_id !== f["request-id"]) throw new Error("Wrong V8 project binding");
      hex(link.action_fingerprint); hex(link.request_fingerprint);
      if (next.projects.some(item => item.external_actions.some(a => a.action_id === link.action_id || a.request_id === link.request_id))) throw new Error("V8 action already bound to a project");
      p.external_actions.push(link); break;
    }
    default: throw new Error("Invalid V9 transition");
  }
  projectMetrics(p); // Detect aggregate overflow before any commit.
  return next;
}
