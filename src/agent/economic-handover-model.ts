/** V14.2 accounting transition only. Uses the original V5/V9 state machines. */
import { canonicalHash, exact, hex, time, uuid, transition, economicChanges, validateProjectCommand, type ProjectEvent, type ProjectModel, type ProjectPlan } from "./project-model.js";
import { auditProjects } from "./project-manager.js";
import { parseEconomicLedger, reserveProjectReference, type EconomicLedger } from "./economic-ledger.js";
import { reference, preparationBlockers, type PreparedProject } from "./pilot-preparation-model.js";

export interface HandoverScope {
  transfer_id: string; project_id: string; dossier_hash: string; request_id: string; source_hash: string;
  created_at: string; expires_at: string; amount_cents: number; target_plan: ProjectPlan; reservation_request_id: string;
}
export interface HandoverRequest {
  scope: HandoverScope; fingerprint: string; status: "pending" | "approved" | "denied";
  decided_at: string | null; human_reference: string | null;
}
export function validateHandoverRequest(r: HandoverRequest): void {
  exact(r, ["scope", "fingerprint", "status", "decided_at", "human_reference"]);
  const s = r.scope;
  exact(s, ["transfer_id", "project_id", "dossier_hash", "request_id", "source_hash", "created_at", "expires_at", "amount_cents", "target_plan", "reservation_request_id"]);
  reference(s.project_id); reference(s.transfer_id); uuid(s.request_id, "handover-request"); hex(s.dossier_hash); hex(s.source_hash); time(s.created_at); time(s.expires_at);
  if (s.transfer_id !== `handover-${canonicalHash([s.project_id, s.dossier_hash]).slice(0, 32)}` || s.created_at >= s.expires_at || Date.parse(s.expires_at) - Date.parse(s.created_at) > 7 * 86400000 || !Number.isSafeInteger(s.amount_cents) || s.amount_cents < 1 || s.amount_cents > 1000) throw new Error("HANDOVER_SCOPE_INVALID");
  exact(s.target_plan, ["project_id", "batch_id", "name", "hypothesis", "budget_cents", "duration_days", "created_at"]);
  uuid(s.target_plan.project_id, "project"); uuid(s.target_plan.batch_id, "batch"); uuid(s.reservation_request_id, "request");
  validateProjectCommand({ operation: "create-project", target: s.target_plan.batch_id, fields: { name: s.target_plan.name, hypothesis: s.target_plan.hypothesis, "budget-cents": String(s.target_plan.budget_cents), "duration-days": String(s.target_plan.duration_days) }, preview: false });
  if (s.target_plan.budget_cents !== s.amount_cents || s.target_plan.created_at !== s.created_at || r.fingerprint !== canonicalHash(s) || !["pending", "approved", "denied"].includes(r.status)) throw new Error("HANDOVER_SCOPE_INVALID");
  if (r.status === "pending") {
    if (r.decided_at !== null || r.human_reference !== null) throw new Error("HANDOVER_DECISION_INVALID");
  } else if (!r.decided_at || time(r.decided_at) < s.created_at || r.decided_at >= s.expires_at || r.human_reference !== `local-cli:v14.2:${r.status}:${s.request_id}`) throw new Error("HANDOVER_DECISION_INVALID");
}
export function assertExactHandoverApproval(r: HandoverRequest, p: PreparedProject, at: string): void {
  validateHandoverRequest(r); time(at);
  if (at < r.scope.created_at || r.decided_at && at < r.decided_at) throw new Error("HANDOVER_CLOCK_ROLLBACK");
  if (at >= r.scope.expires_at || at >= p.dossier.review_expires_at) throw new Error("HANDOVER_APPROVAL_EXPIRED");
  if (r.status !== "approved") throw new Error("HANDOVER_APPROVAL_REQUIRED");
  if (p.accounting_transfer || preparationBlockers(p, at).length || p.project_id !== r.scope.project_id || p.dossier_hash !== r.scope.dossier_hash || p.reserved_budget_cents !== r.scope.amount_cents || p.candidate.title !== r.scope.target_plan.name || p.dossier.description !== r.scope.target_plan.hypothesis || p.dossier.duration_days !== r.scope.target_plan.duration_days) throw new Error("HANDOVER_DOSSIER_BLOCKED");
}
/** Construct/replay ONLY create-batch, create-project and reserve-project. */
export function buildHandoverDelta(ledger: EconomicLedger, previousEvents: ProjectEvent[], r: HandoverRequest, committedAt: string, eventIds: string[]) {
  let model: ProjectModel = auditProjects(previousEvents, ledger), next = parseEconomicLedger(JSON.stringify(ledger));
  const events = [...previousEvents], plan = r.scope.target_plan;
  let i = 0;
  const apply = (operation: ProjectEvent["command"]["operation"], target: string | null, fields: Record<string, string>, newId: string, at: string) => {
    const before = next, beforeCount = next.entries.length;
    const event: ProjectEvent = { event_id: uuid(eventIds[i++], "projectevent"), at, new_id: newId,
      command: { operation, target, fields, preview: false }, external: null,
      ledger_before_count: beforeCount, ledger_before_hash: canonicalHash(before), ledger_after_count: beforeCount, ledger_after_hash: canonicalHash(before), ledger_entry_ids: [] };
    for (const change of economicChanges(model, event.command, event.event_id)) {
      if (change.type !== "reserve") throw new Error("HANDOVER_NON_RESERVATION_CHANGE");
      next = reserveProjectReference(next, change.reference);
    }
    event.ledger_after_count = next.entries.length; event.ledger_after_hash = canonicalHash(next);
    event.ledger_entry_ids = next.entries.slice(beforeCount).map(e => e.id);
    model = transition(model, event, before, next); events.push(event);
  };
  if (!model.batch) apply("create-batch", null, {}, plan.batch_id, plan.created_at);
  else if (model.batch.batch_id !== plan.batch_id) throw new Error("HANDOVER_BATCH_CHANGED");
  apply("create-project", plan.batch_id, { name: plan.name, hypothesis: plan.hypothesis, "budget-cents": String(plan.budget_cents), "duration-days": String(plan.duration_days) }, plan.project_id, plan.created_at);
  apply("reserve-project", plan.project_id, { "experiment-id": canonicalHash(plan) }, r.scope.reservation_request_id, committedAt);
  model = auditProjects(events, next);
  if (next.entries.length !== ledger.entries.length + 1 || next.total_recorded_expenses_cents !== ledger.total_recorded_expenses_cents || next.total_recorded_revenue_cents !== ledger.total_recorded_revenue_cents || next.initial_capital_cents !== ledger.initial_capital_cents) throw new Error("HANDOVER_FINANCIAL_INVARIANT");
  return { ledger: next, events, model, entry: next.entries.at(-1)! };
}
