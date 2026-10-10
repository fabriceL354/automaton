/** V13 deterministic proposals and integer simulations. No I/O or executor. */
import { integerCents } from "./asset-lifecycle.js";
import { canonicalHash, exact, hex, same, time } from "./project-model.js";
import { parseDossier, reference, type Dossier, type PreparedProject } from "./pilot-preparation-model.js";
import { validateCheckScope, type CheckScope } from "./pilot-readiness-model.js";

export const PLANNING_LIMITS = Object.freeze({ MAX_PLANS: 8, MAX_EVENTS: 128 });
export const PLANNING_RESULTS = ["PLAN_RECORDED_NO_EXECUTION", "EXACT_AUTHORIZATION_CURRENT_NO_EXECUTION", "SCOPE_MISMATCH", "APPROVAL_EXPIRED", "APPROVAL_REQUIRED", "DOSSIER_BLOCKED", "PLAN_SOURCE_CHANGED"] as const;
export type PlanningResult = typeof PLANNING_RESULTS[number];
export interface ScenarioInput { budget_cents: number; baseline_cost_cents: number | null; baseline_revenue_cents: number | null }
/** Fixed sensitivity assumptions, not forecasts learned from sales. BigInt
 * prevents intermediate rounding/overflow; every output keeps the money cap. */
export function simulateEconomics(input: ScenarioInput) {
  exact(input, ["budget_cents", "baseline_cost_cents", "baseline_revenue_cents"]);
  const budget = integerCents(input.budget_cents), cost = input.baseline_cost_cents, revenue = input.baseline_revenue_cents;
  if (budget > 1000) throw new Error("SPENDING_CEILING_EXCEEDED");
  if (cost !== null) integerCents(cost);
  if (revenue !== null) integerCents(revenue);
  const scale = (n: number, numerator: number, denominator: number) => integerCents(Number(BigInt(n) * BigInt(numerator) / BigInt(denominator)));
  return (["pessimistic", "central", "optimistic"] as const).map(name => {
    const estimated_cost_cents = name === "pessimistic" ? cost === null ? null : Math.max(budget, cost) : name === "optimistic" ? cost === null ? null : scale(cost, 4, 5) : cost;
    const hypothetical_revenue_cents = name === "pessimistic" ? 0 : name === "optimistic" ? revenue === null ? null : scale(revenue, 3, 2) : revenue;
    const projected_result_cents = estimated_cost_cents === null || hypothetical_revenue_cents === null ? null : integerCents(hypothetical_revenue_cents - estimated_cost_cents, true);
    return { name, estimated_cost_cents, hypothetical_revenue_cents, projected_result_cents,
      exceeds_budget: estimated_cost_cents === null ? null : estimated_cost_cents > budget,
      assumptions: name === "pessimistic" ? ["COST_AT_LEAST_FULL_BUDGET_WHEN_KNOWN", "ZERO_SALES_ASSUMED"] : name === "central" ? ["BASELINE_COST_UNCONFIRMED", "DOSSIER_REVENUE_HYPOTHESIS"] : ["COST_FOUR_FIFTHS_ROUNDED_DOWN", "REVENUE_THREE_HALVES_ROUNDED_DOWN"],
      unknown_cost: cost === null, unknown_revenue: revenue === null,
      revenue_is_acquired: false as const, revenue_added_to_available_funds_cents: 0 as const, bank_verified_result_cents: null };
  });
}
export interface ProjectInput {
  project_id: string; dossier_hash: string; dossier: Dossier;
  candidate_cost_cents: number | null; cost_basis: PreparedProject["candidate"]["cost_basis"]; human_reviewed_quote_cents: number | null;
}
function projectProposal(input: ProjectInput) {
  const d = input.dossier;
  const baseline = input.human_reviewed_quote_cents ?? (input.cost_basis === "SOURCE_ESTIMATE" ? input.candidate_cost_cents : null);
  const step = (action_id: string, kind: string, description: string, depends_on: string[], risks: string[], criteria: string[], proof_ids: string[], max_amount_cents = 0, source_action_id: string | null = null) => ({
    action_id, kind, description, depends_on, risks, success_criteria: criteria, proof_ids, max_amount_cents, source_action_id,
    proposed_only: true as const, executable: false as const, execution_status: "NOT_RECORDED" as const,
  });
  const actions = [
    step("review-evidence", "review", "Examiner les archives de coût et de marché", [], d.commercial_uncertainties, ["COST_AND_MARKET_EVIDENCE_REVIEWED_BY_HUMAN"], d.proofs.map(p => p.proof_id)),
    step("review-commercial", "review", "Examiner le devis, le public et l'offre", ["review-evidence"], d.operational_risks, ["EXACT_COMMERCIAL_SCOPE_REVIEWED_BY_HUMAN"], d.proofs.filter(p => p.purpose === "cost").map(p => p.proof_id)),
    step("review-authorizations", "review", "Vérifier les autorisations exactes sans les consommer", ["review-commercial"], ["AUTHORIZATION_IS_NOT_EXECUTION"], ["CURRENT_EXACT_AUTHORIZATIONS_CHECKED"], []),
  ];
  // Source order is a conservative serial proposal, not an inferred schedule.
  for (const [i, a] of d.human_actions.entries()) actions.push(step(`proposed-${i + 1}`, a.kind, a.description, [i ? `proposed-${i}` : "review-authorizations"], a.risks, d.success_conditions, a.proof_ids, a.max_amount_cents, a.action_id));
  actions.push(step("review-result", "review", "Examiner les critères et les trois simulations", [`proposed-${d.human_actions.length}`], d.commercial_uncertainties, d.success_conditions, d.proofs.map(p => p.proof_id)));
  return { input, offer: d.offer, target_customers: d.target_customers, actions,
    dependency_assumption: "SOURCE_ORDER_SERIAL_PROPOSAL_ONLY", planned_duration_days: d.duration_days, started_at: null, real_deadline: null,
    risks: [...d.operational_risks, ...d.commercial_uncertainties], success_criteria: d.success_conditions, stop_conditions: d.stop_conditions,
    economics: { input: { budget_cents: d.budget_cents, baseline_cost_cents: baseline, baseline_revenue_cents: d.estimated_revenue_cents },
      cost_basis: input.human_reviewed_quote_cents !== null ? "HUMAN_REVIEWED_QUOTE_NOT_BANK_PROOF" : baseline !== null ? "SOURCE_ESTIMATE_NOT_BANK_PROOF" : "UNKNOWN",
      scenarios: simulateEconomics({ budget_cents: d.budget_cents, baseline_cost_cents: baseline, baseline_revenue_cents: d.estimated_revenue_cents }),
      confirmed_revenue_cents: null, verified_expense_cents: null, available_funds_increase_cents: 0 },
    execution_allowed: false as const };
}
export interface PlanningProvenance {
  preparation_state_hash: string; allocation_sources_hash: string; input_hash: string; handover_plan_hash: string;
}
export function buildOperationalPlan(provenance: PlanningProvenance, projects: PreparedProject[]) {
  const body = { version: "13" as const, policy: "SUPERVISED_NON_EXECUTABLE_V1" as const, provenance,
    projects: projects.map(p => projectProposal({ project_id: p.project_id, dossier_hash: p.dossier_hash, dossier: p.dossier,
      candidate_cost_cents: p.candidate.estimated_cost_cents, cost_basis: p.candidate.cost_basis, human_reviewed_quote_cents: p.commercial_review?.confirmed_quote_cents ?? null })),
    execution_allowed: false as const, financial_transfer_performed: false as const, money_moved_cents: 0 as const };
  const plan_hash = canonicalHash(body);
  return { ...body, plan_hash, plan_id: `operational-plan-${plan_hash}` };
}
export type OperationalPlan = ReturnType<typeof buildOperationalPlan>;
export function validateOperationalPlan(plan: OperationalPlan) {
  exact(plan, ["version", "policy", "provenance", "projects", "execution_allowed", "financial_transfer_performed", "money_moved_cents", "plan_hash", "plan_id"]);
  exact(plan.provenance, ["preparation_state_hash", "allocation_sources_hash", "input_hash", "handover_plan_hash"]);
  Object.values(plan.provenance).forEach(hex);
  if (plan.version !== "13" || plan.policy !== "SUPERVISED_NON_EXECUTABLE_V1" || plan.execution_allowed !== false || plan.financial_transfer_performed !== false || plan.money_moved_cents !== 0 || !Array.isArray(plan.projects) || !plan.projects.length || plan.projects.length > 2) throw new Error("Invalid non-executable plan");
  const ids = new Set<string>(); let totalBudget = 0;
  for (const p of plan.projects) {
    const v = p.input;
    exact(v, ["project_id", "dossier_hash", "dossier", "candidate_cost_cents", "cost_basis", "human_reviewed_quote_cents"]);
    reference(v.project_id); hex(v.dossier_hash); parseDossier(v.dossier);
    if (ids.has(v.project_id) || canonicalHash(v.dossier) !== v.dossier_hash || !["SOURCE_ESTIMATE", "ASSUMPTION", "UNKNOWN"].includes(v.cost_basis)) throw new Error("Plan dossier binding mismatch");
    ids.add(v.project_id); totalBudget += v.dossier.budget_cents;
    if (v.candidate_cost_cents !== null) integerCents(v.candidate_cost_cents);
    if (v.human_reviewed_quote_cents !== null && integerCents(v.human_reviewed_quote_cents) > v.dossier.budget_cents) throw new Error("Plan quote ceiling exceeded");
    if (!same(p, projectProposal(v))) throw new Error("Plan proposal or scenario mismatch");
  }
  if (totalBudget > 2000) throw new Error("SPENDING_CEILING_EXCEEDED");
  const { plan_hash, plan_id, ...body } = plan;
  if (hex(plan_hash) !== canonicalHash(body) || plan_id !== `operational-plan-${plan_hash}`) throw new Error("Plan identity mismatch");
}
export interface PlanningEvent {
  sequence: number; at: string; plan_id: string; scope: CheckScope | null; result: PlanningResult;
  previous_hash: string | null; hash: string; event_id: string; execution_performed: false;
}
export interface OperationalPlanning { version: "13"; plans: { created_at: string; plan: OperationalPlan }[]; events: PlanningEvent[] }
export function appendPlanningEvent(s: OperationalPlanning, at: string, plan_id: string, scope: CheckScope | null, result: PlanningResult): boolean {
  const event_id = `planning-event-${canonicalHash([plan_id, scope, result])}`;
  if (s.events.some(e => e.event_id === event_id)) return false;
  if (s.events.length >= PLANNING_LIMITS.MAX_EVENTS) throw new Error("Planning audit full; human inspection required");
  const body = { sequence: s.events.length + 1, at, plan_id, scope, result, previous_hash: s.events.at(-1)?.hash ?? null, event_id, execution_performed: false as const };
  s.events.push({ ...body, hash: canonicalHash(body) }); return true;
}
export function validateOperationalPlanning(s: OperationalPlanning, updated: string) {
  exact(s, ["version", "plans", "events"]);
  if (s.version !== "13" || !Array.isArray(s.plans) || !s.plans.length || s.plans.length > PLANNING_LIMITS.MAX_PLANS || !Array.isArray(s.events) || !s.events.length || s.events.length > PLANNING_LIMITS.MAX_EVENTS) throw new Error("Planning history limits");
  const plans = new Map<string, string>(); let at = "";
  for (const record of s.plans) {
    exact(record, ["created_at", "plan"]); time(record.created_at); validateOperationalPlan(record.plan);
    if (record.created_at < at || record.created_at > updated || plans.has(record.plan.plan_id)) throw new Error("Invalid plan history");
    plans.set(record.plan.plan_id, record.created_at); at = record.created_at;
  }
  let previous: string | null = null; at = ""; const seen = new Set<string>(), recorded = new Set<string>();
  for (const [i, e] of s.events.entries()) {
    exact(e, ["sequence", "at", "plan_id", "scope", "result", "previous_hash", "hash", "event_id", "execution_performed"]);
    time(e.at); reference(e.plan_id); hex(e.hash);
    if (!PLANNING_RESULTS.includes(e.result) || e.sequence !== i + 1 || e.at < at || e.at > updated || e.previous_hash !== previous || e.execution_performed !== false || seen.has(e.event_id) || e.event_id !== `planning-event-${canonicalHash([e.plan_id, e.scope, e.result])}`) throw new Error("Planning audit chain mismatch");
    if (e.result === "PLAN_RECORDED_NO_EXECUTION") {
      if (e.scope !== null || plans.get(e.plan_id) !== e.at || recorded.has(e.plan_id)) throw new Error("Unbound plan audit");
      recorded.add(e.plan_id);
    } else {
      validateCheckScope(e.scope);
      if (plans.has(e.plan_id) && !recorded.has(e.plan_id)) throw new Error("Check precedes plan audit");
    }
    const { hash, ...body } = e;
    if (hash !== canonicalHash(body)) throw new Error("Planning audit hash mismatch");
    previous = hash; at = e.at; seen.add(e.event_id);
  }
  if (recorded.size !== plans.size) throw new Error("Missing plan audit");
}
