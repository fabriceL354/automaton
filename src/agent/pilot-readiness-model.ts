/** Pure V12.8 handover proposal and authenticated audit contracts. No economic
 * writer is imported. Target identities are UNASSIGNED until an atomic host exists. */
import { canonicalHash, exact, hex, time } from "./project-model.js";
import { integerCents } from "./asset-lifecycle.js";
import { normalizeExposure, type AllocationSources } from "./allocation-sources.js";
import { reference, type PreparedProject } from "./pilot-preparation-model.js";
export const CHECK_RESULTS = ["EXACT_AUTHORIZATION_CURRENT_NO_EXECUTION", "SCOPE_MISMATCH", "APPROVAL_EXPIRED", "APPROVAL_REQUIRED", "DOSSIER_BLOCKED", "HANDOVER_CAPACITY_BLOCKED"] as const;
export type CheckResult = typeof CHECK_RESULTS[number];
export interface CheckScope { project_id: string; dossier_hash: string; action_id: string; request_id: string; fingerprint: string }
export interface ReadinessEvent {
  sequence: number; at: string; scope: CheckScope | null; result: "HANDOVER_PLANNED_NO_TRANSFER" | CheckResult;
  previous_hash: string | null; hash: string; execution_performed: false;
}
export interface PilotSupervision {
  version: "12.8"; prepared_at: string; plan_hash: string; events: ReadinessEvent[];
}
export function validateCheckScope(v: unknown): CheckScope {
  const c = exact(v, ["project_id", "dossier_hash", "action_id", "request_id", "fingerprint"]);
  reference(c.project_id); hex(c.dossier_hash); reference(c.action_id); reference(c.request_id); hex(c.fingerprint);
  return c as unknown as CheckScope;
}
export function validateSupervision(s: PilotSupervision, updated: string): void {
  exact(s, ["version", "prepared_at", "plan_hash", "events"]); time(s.prepared_at); hex(s.plan_hash);
  if (s.version !== "12.8" || s.prepared_at > updated || !Array.isArray(s.events) || !s.events.length || s.events.length > 128) throw new Error("Invalid supervision history");
  let previous: string | null = null, at = s.prepared_at;
  for (const [i, e] of s.events.entries()) {
    exact(e, ["sequence", "at", "scope", "result", "previous_hash", "hash", "execution_performed"]); time(e.at); hex(e.hash);
    const { hash, ...body } = e;
    if (e.sequence !== i + 1 || e.at < at || e.at > updated || e.previous_hash !== previous || hash !== canonicalHash(body) || e.execution_performed !== false) throw new Error("Supervision chain mismatch");
    if (i === 0 ? e.scope !== null || e.result !== "HANDOVER_PLANNED_NO_TRANSFER" || e.at !== s.prepared_at : e.scope === null || !CHECK_RESULTS.includes(e.result as CheckResult)) throw new Error("Invalid supervision decision");
    if (e.scope) validateCheckScope(e.scope);
    previous = hash; at = e.at;
  }
}
export function appendReadinessEvent(s: PilotSupervision, at: string, scope: CheckScope | null, result: ReadinessEvent["result"]) {
  if (s.events.length >= 128) throw new Error("Supervision history full; human inspection required");
  const body = { sequence: s.events.length + 1, at, scope, result, previous_hash: s.events.at(-1)?.hash ?? null, execution_performed: false as const };
  s.events.push({ ...body, hash: canonicalHash(body) });
}
export function buildHandoverPlan(sources: AllocationSources, projects: PreparedProject[]) {
  const { ledger, model } = sources.financial;
  const reserved = ledger.entries.filter(e => e.type === "reserve");
  const v9Ids = new Set(model.projects.map(p => p.experiment_id));
  // A V9 reservation appears in both histories but counts as ONE commitment.
  const standalone = reserved.filter(e => !v9Ids.has(e.experiment!.id));
  const historicalNames = new Set([...reserved.map(e => e.experiment!.name), ...model.projects.map(p => p.plan.name)].map(normalizeExposure));
  const planned = integerCents(model.projects.filter(p => p.status === "planned").reduce((sum, p) => sum + p.plan.budget_cents, 0));
  const earmarked = integerCents(projects.reduce((sum, p) => sum + p.reserved_budget_cents, 0));
  const exposure = integerCents(ledger.reserved_balance_cents + ledger.total_recorded_expenses_cents + planned + earmarked);
  const historicalCount = model.projects.length + standalone.length;
  const blockers = [
    ...(historicalCount + projects.length > 2 ? ["PROJECT_LIMIT_EXCEEDED"] : []),
    ...(exposure > 2000 || projects.some(p => p.reserved_budget_cents > 1000) || model.projects.reduce((n, p) => n + p.plan.budget_cents, 0) + earmarked > 2000 ? ["SPENDING_CEILING_EXCEEDED"] : []),
    ...(earmarked + planned > Math.min(10000, ledger.available_balance_cents) ? ["INSUFFICIENT_BUDGET"] : []),
    ...(projects.some(p => historicalNames.has(normalizeExposure(p.candidate.title))) || new Set(projects.map(p => normalizeExposure(p.candidate.title))).size !== projects.length ? ["POSSIBLE_DUPLICATE_HISTORICAL_COMMITMENT"] : []),
  ];
  const lines = projects.map(p => ({ transfer_id: `handover-${canonicalHash([p.project_id, p.dossier_hash]).slice(0, 32)}`,
    source_project_id: p.project_id, source_dossier_hash: p.dossier_hash, amount_cents: p.reserved_budget_cents,
    target_v9_project_id: null, target_v5_experiment_id: null, source_earmark_retained: true,
    current_v5_reservation_cents: 0, proposed_reclassification_cents: p.reserved_budget_cents, additional_exposure_cents: 0,
    status: "PROPOSAL_ONLY_NO_TRANSFER" }));
  return { version: "12.8", status: "BLOCKED_ATOMIC_HANDOVER_NOT_IMPLEMENTED", executable: false, financial_transfer_performed: false,
    reference_capital_cents: 10000, capital_is_bank_balance: false, bank_balance_cents: null,
    financial_source_hash: canonicalHash(sources.financial), source_input_hash: sources.input_hash,
    limits: { projects: 2, per_project_cents: 1000, total_cents: 2000 },
    historical_project_count: historicalCount, historical_v9_project_count: model.projects.length, standalone_v5_commitment_count: standalone.length,
    historical_v5_reserved_cents: ledger.reserved_balance_cents, historical_recorded_expense_cents: ledger.total_recorded_expenses_cents,
    historical_v9_unreserved_planned_cents: planned, current_preparation_earmarked_cents: earmarked, current_total_exposure_cents: exposure,
    proposed_total_exposure_after_atomic_reclassification_cents: exposure, capacity_blockers: blockers, lines,
    required_future_protocol: ["REVALIDATE_STOP_SOURCES_LIMITS_AND_EXACT_APPROVALS_UNDER_SHARED_LOCK", "BIND_UNIQUE_V127_TO_V9_AND_V5_IDENTITIES",
      "COMMIT_SOURCE_EARMARK_RETIREMENT_AND_TARGET_RESERVATION_IN_ONE_DURABLE_TRANSACTION", "REPLAY_BY_TRANSFER_ID_WITHOUT_DUPLICATION",
      "RECOVER_ALL_OR_NOTHING_BEFORE_ANY_WRITER_IS_UNSEALED", "KEEP_EXECUTION_AND_BANK_VERIFICATION_SEPARATE"],
  };
}
