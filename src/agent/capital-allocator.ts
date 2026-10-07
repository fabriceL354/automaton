/** V12 pure deterministic proposal engine. No financial/approval/action writer. */
import { PROJECT_LIMITS, integerCents } from "./asset-lifecycle.js";
import { canonicalHash, time, type Project } from "./project-model.js";
import { sourcePin, sourceTime, buildProjectEvidence } from "./evidence-builder.js";
import { attentionItem, type OperatorAttentionItem } from "./tool-discovery.js";
import { ALLOCATION_LIMITS, normalizeExposure, type AllocationCandidate, type AllocationSources } from "./allocation-sources.js";
export const ALLOCATION_NOTICE = "NO REAL MONEY WAS SPENT BY V12";
export type AllocationAttention = OperatorAttentionItem & {
  requires_human_decision: boolean; blocks_allocation: boolean; details: Record<string, unknown>;
};
export interface Selection {
  opportunity_id: string; project_id: string | null; experiment_id: string | null;
  asset_id: string | null; proposed_cents: number; max_duration_days: 7; score: number;
  rationale: string[]; evidence_ids: string[]; learning_refs: string[]; uncertainties: string[];
  risk_notes: string[];
}
export function allocationFingerprint(s: AllocationSources) {
  return canonicalHash({ version: 12, financial: sourcePin(s.financial), learning: canonicalHash(s.learning_events), approvals: canonicalHash(s.approvals ?? []), input: s.input_file, input_hash: s.input_hash });
}
function notification(category: OperatorAttentionItem["category"], reference: string, message: string,
  details: Record<string, unknown>, blocking = false): AllocationAttention {
  const base = attentionItem(category, "allocation-event", message, category !== "INFO");
  return { ...base, attention_id: `allocation-attention-${canonicalHash([category, reference, details])}`,
    reference_id: reference, blocks_research: false, blocks_allocation: blocking,
    requires_human_decision: category !== "INFO", details };
}
export function calculateAllocation(s: AllocationSources, generatedAt: string) {
  time(generatedAt);
  if (generatedAt < sourceTime(s.financial) || s.learning_events.some(e => e.at > generatedAt)) throw new Error("Allocation clock predates verified sources");
  const ledger = s.financial.ledger, projects = s.financial.model.projects;
  const candidates = [...s.candidates].sort((a, b) => b.score - a.score || (a.opportunity_id < b.opportunity_id ? -1 : 1));
  if (candidates.length > ALLOCATION_LIMITS.MAX_CANDIDATES) throw new Error("Allocation candidate limit");
  const planned = projects.filter(p => p.status === "planned");
  const plannedCents = integerCents(planned.reduce((sum, p) => sum + p.plan.budget_cents, 0));
  const usedBatchCents = integerCents(projects.reduce((sum, p) => sum + p.plan.budget_cents, 0));
  // Ledger totals include standalone V4/V7 exposure as well as V9. Confirmed
  // revenue never raises the 20 EUR exposure ceiling or refills a spent batch.
  const exposure = integerCents(ledger.reserved_balance_cents + ledger.total_recorded_expenses_cents);
  const plannedCovered = plannedCents <= ledger.available_balance_cents && exposure + plannedCents <= PROJECT_LIMITS.MAX_BATCH_BUDGET_CENTS;
  let newCash = Math.max(0, ledger.available_balance_cents - plannedCents);
  let newExposure = Math.max(0, PROJECT_LIMITS.MAX_BATCH_BUDGET_CENTS - exposure - plannedCents);
  let batchRoom = Math.max(0, PROJECT_LIMITS.MAX_BATCH_BUDGET_CENTS - usedBatchCents);
  // V9's initial batch has two lifetime slots, including closed/cancelled ones.
  let slots = Math.max(0, PROJECT_LIMITS.MAX_ACTIVE_PROJECTS - projects.length);
  const selected: Selection[] = [], rejected: { opportunity_id: string; reason: string }[] = [];
  const outOfBudget: AllocationCandidate[] = [], attention: AllocationAttention[] = [];
  const exposures = new Set<string>(), names = new Set<string>();
  const evidence = projects.map(p => buildProjectEvidence(s.financial, p.plan.project_id));
  if (candidates.length && candidates.every(c => c.estimated_cost_cents === null)) {
    attention.push(notification("HUMAN_INTERVENTION_REQUIRED", "allocation-costs",
      "Coûts inconnus : une estimation documentée est nécessaire avant de proposer une allocation.",
      { opportunity_ids: candidates.map(c => c.opportunity_id) }, true));
  }
  const live = projects.filter(p => ["reserved", "approved", "active"].includes(p.status));
  for (const p of live) {
    names.add(normalizeExposure(p.plan.name));
    const bound = candidates.find(c => normalizeExposure(c.title) === normalizeExposure(p.plan.name));
    if (bound?.exposure_key) exposures.add(bound.exposure_key);
    if (p.status === "reserved" && p.approval?.request.status === "pending") {
      attention.push(notification("APPROVAL_REQUIRED", p.approval.request.request_id,
        `Projet ${p.plan.name} : approbation humaine nécessaire, maximum ${p.plan.budget_cents} cents.`,
        { project_id: p.plan.project_id, experiment_id: p.experiment_id, request_id: p.approval.request.request_id, max_amount_cents: p.plan.budget_cents }));
    }
    if (p.status === "active" && generatedAt >= p.experiment_deadline!) {
      attention.push(notification("HUMAN_INTERVENTION_REQUIRED", p.experiment_id,
        `Projet ${p.plan.name} : deadline atteinte. Clôture et nouvelle décision humaine nécessaires.`,
        { project_id: p.plan.project_id, experiment_id: p.experiment_id, deadline: p.experiment_deadline }, true));
    }
  }
  if (!plannedCovered || exposure > PROJECT_LIMITS.MAX_BATCH_BUDGET_CENTS) {
    attention.push(notification("HUMAN_INTERVENTION_REQUIRED", "allocation-capital",
      "Les engagements existants ne permettent pas une nouvelle allocation. Vérification humaine nécessaire.",
      { exposure_cents: exposure, planned_unreserved_cents: plannedCents }, true));
  }
  const eligibleForComparison: AllocationCandidate[] = [];
  for (const c of candidates) {
    const reject = (reason: string) => rejected.push({ opportunity_id: c.opportunity_id, reason });
    const matches = projects.filter(p => normalizeExposure(p.plan.name) === normalizeExposure(c.title));
    if (matches.length > 1) throw new Error("Ambiguous canonical project binding");
    const p = matches[0];
    if (c.estimated_cost_cents === null) { reject("COST_UNKNOWN"); continue; }
    integerCents(c.estimated_cost_cents);
    if (c.estimated_cost_cents > PROJECT_LIMITS.MAX_PROJECT_BUDGET_CENTS) { outOfBudget.push(c); reject("PROJECT_CEILING_EXCEEDED"); continue; }
    if (p && p.status !== "planned") { reject("EXISTING_PROJECT_ALREADY_COMMITTED_OR_CLOSED"); continue; }
    if (p && c.estimated_cost_cents > p.plan.budget_cents) { reject("EXISTING_PLAN_BUDGET_TOO_SMALL"); continue; }
    if (!plannedCovered || attention.some(i => i.blocks_allocation)) { reject("EXISTING_COMMITMENTS_REQUIRE_HUMAN_DECISION"); continue; }
    if (names.has(normalizeExposure(c.title)) || (c.exposure_key !== null && exposures.has(c.exposure_key))) { reject("DUPLICATE_EXPOSURE"); continue; }
    const amount = p ? p.plan.budget_cents : c.estimated_cost_cents;
    if (!p && (slots === 0 || selected.length >= PROJECT_LIMITS.MAX_ACTIVE_PROJECTS)) { reject("V9_BATCH_PROJECT_LIMIT"); continue; }
    if (!p && amount > batchRoom) { reject("V9_BATCH_BUDGET_LIMIT"); continue; }
    if (!p && amount > newCash) { reject("INSUFFICIENT_CONFIRMED_CAPITAL"); continue; }
    if (!p && amount > newExposure) { reject("CUMULATIVE_EXPOSURE_LIMIT"); continue; }
    eligibleForComparison.push(c);
    const e = p ? evidence.find(e => e.project_id === p.plan.project_id)! : null;
    const learningRefs = p ? s.learning_events.filter(h => [...h.evaluation.evidence_for, ...h.evaluation.evidence_against].some(link => link.project_id === p.plan.project_id)).map(h => h.event_id) : [];
    selected.push({ opportunity_id: c.opportunity_id, project_id: p?.plan.project_id ?? null, experiment_id: p?.experiment_id ?? null,
      asset_id: p?.asset?.asset_id ?? null, proposed_cents: amount, max_duration_days: 7, score: c.score,
      rationale: [`EXISTING_${c.origin}_DETERMINISTIC_SCORE:${c.score}`, `ESTIMATED_COST_CENTS:${c.estimated_cost_cents}`,
        p ? "EXACT_EXISTING_PLAN_BUDGET; NO_INCREASE" : "WITHIN_EXISTING_V9_LIMITS",
        c.exposure_key === null ? "DIVERSIFICATION_UNKNOWN" : "NO_EXACT_SOURCE_MARKET_PLATFORM_DUPLICATE",
        `V11_RECOMMENDATION:${e?.derived_metrics.recommendation.kind ?? "insufficient_evidence"}`],
      evidence_ids: c.evidence_ids, learning_refs: learningRefs, risk_notes: c.risk_notes,
      uncertainties: [...c.uncertainties, ...(e ? [] : ["NO_AUTHENTICATED_SIMILARITY_LINK_OR_EXPERIMENT_RESULT"])] });
    names.add(normalizeExposure(c.title)); if (c.exposure_key !== null) exposures.add(c.exposure_key);
    if (!p) { slots--; newCash -= amount; newExposure -= amount; batchRoom -= amount; }
  }
  // Compare only scores from the same existing scale. Absent peers: use the
  // absolute threshold, never fabricate a zero-scoring in-budget opportunity.
  const remarkable = outOfBudget.find(c => {
    const peers = eligibleForComparison.filter(p => p.origin === c.origin);
    const baseline = peers.length ? Math.max(...peers.map(p => p.score)) : null;
    const threshold = c.origin === "V11.1" ? ALLOCATION_LIMITS.MIN_RESEARCH_SCORE : ALLOCATION_LIMITS.MIN_V3_SCORE;
    return c.cost_basis === "SOURCE_ESTIMATE" && c.evidence_ids.length > 0 && c.score >= threshold &&
      (baseline === null || c.score >= baseline + ALLOCATION_LIMITS.OUT_OF_BUDGET_SCORE_GAP);
  });
  if (remarkable) {
    const peers = eligibleForComparison.filter(p => p.origin === remarkable.origin);
    const baseline = peers.length ? Math.max(...peers.map(p => p.score)) : null;
    const reason = baseline === null ? "SOURCED_COST_AND_ABSOLUTE_SCORE_THRESHOLD; NO_IN_BUDGET_PEER" : "SOURCED_COST_AND_SCORE_AT_LEAST_15_ABOVE_IN_BUDGET_PEERS";
    const item = notification("OUT_OF_BUDGET_OPPORTUNITY", remarkable.opportunity_id,
      `${remarkable.title} : coût estimé ${remarkable.estimated_cost_cents} cents, plafond 1000 cents. Aucune dépense engagée.`,
      { opportunity_id: remarkable.opportunity_id, title: remarkable.title, opportunity_fingerprint: remarkable.fingerprint,
        estimated_cost_cents: remarkable.estimated_cost_cents, current_ceiling_cents: PROJECT_LIMITS.MAX_PROJECT_BUDGET_CENTS,
        excess_cents: remarkable.estimated_cost_cents! - PROJECT_LIMITS.MAX_PROJECT_BUDGET_CENTS,
        score: remarkable.score, in_budget_baseline_score: baseline, reason_surfaced: reason,
        risks: remarkable.risk_notes, evidence_ids: remarkable.evidence_ids, status: "NON_BLOCKING", execution_authorized: false });
    // Run-local research indexes and small score/prose changes must not re-alert
    // the same economic opportunity. A materially different cost/exposure can.
    item.attention_id = `allocation-attention-${canonicalHash([item.category, normalizeExposure(remarkable.title), remarkable.origin,
      remarkable.estimated_cost_cents, remarkable.exposure_key])}`;
    attention.push(item);
  }
  const proposed = integerCents(selected.reduce((sum, p) => sum + p.proposed_cents, 0));
  if (proposed > ledger.available_balance_cents || proposed + exposure > PROJECT_LIMITS.MAX_BATCH_BUDGET_CENTS || selected.length > 2 || selected.some(p => p.proposed_cents > 1000)) throw new Error("Allocation invariant exceeded");
  const fingerprint = allocationFingerprint(s);
  return { schema_version: 12 as const, allocation_id: `allocation-${fingerprint}`, generated_at: generatedAt,
    source_state_fingerprint: fingerprint, sources: sourcePin(s.financial), input_file: s.input_file, input_hash: s.input_hash,
    learning_history_hash: canonicalHash(s.learning_events), approval_history_hash: canonicalHash(s.approvals ?? []),
    confirmed_available_cents: ledger.available_balance_cents, confirmed_reserved_cents: ledger.reserved_balance_cents,
    total_confirmed_spent_cents: ledger.total_recorded_expenses_cents, total_confirmed_revenue_cents: ledger.total_recorded_revenue_cents,
    approved_allocation_cents: integerCents(projects.filter(p => ["approved", "active"].includes(p.status)).reduce((sum, p) => sum + p.plan.budget_cents, 0)),
    actually_spent_by_v12_cents: 0 as const, planned_unreserved_cents: plannedCents, cumulative_existing_exposure_cents: exposure,
    max_active_projects: PROJECT_LIMITS.MAX_ACTIVE_PROJECTS, max_project_budget_cents: PROJECT_LIMITS.MAX_PROJECT_BUDGET_CENTS,
    max_batch_budget_cents: PROJECT_LIMITS.MAX_BATCH_BUDGET_CENTS, max_experiment_duration_days: PROJECT_LIMITS.MAX_EXPERIMENT_DURATION_DAYS,
    v9_batch_id: s.financial.model.batch?.batch_id ?? null, v9_batch_slots_used: projects.length,
    candidates_considered: candidates, selected_projects: selected, rejected_candidates: rejected,
    out_of_budget_candidates: outOfBudget, total_proposed_cents: proposed, status: "PROPOSAL_ONLY" as const,
    notice: ALLOCATION_NOTICE, action_authorized: false as const, approval_created: false as const, capability_granted: false as const,
    financial_verification: "V5_REPLAY_AND_AUTHENTICATED_V6_V7_V9_HISTORY; NOT_BANK_VERIFICATION",
    learning_evidence: evidence.map(e => ({ project_id: e.project_id, experiment_id: e.experiment_id, asset_id: e.asset_id,
      evidence_hash: canonicalHash(e), result_id: e.source_refs.result_id, derived_metrics: e.derived_metrics })),
    existing_approval_requests: (s.approvals ?? []).map(r => ({ request_id: r.request.request_id,
      experiment_id: r.request.experiment_id, status: r.request.status, max_amount_cents: r.request.max_amount_cents,
      decision_status: r.decision?.status ?? null, source: "AUTHENTICATED_V6_HISTORY", grants_v12_authority: false })),
    existing_projects: projects.map((p: Project) => ({ project_id: p.plan.project_id, experiment_id: p.experiment_id,
      asset_id: p.asset?.asset_id ?? null, status: p.status, budget_cents: p.plan.budget_cents,
      reserved_cents: integerCents(ledger.entries.filter(e => e.experiment?.id === p.experiment_id).reduce((sum, e) => sum + (e.type === "reserve" ? e.amount_cents : e.type === "release" || e.type === "expense" ? -e.amount_cents : 0), 0)),
      approved_cents: p.approval?.request.status === "approved" ? p.plan.budget_cents : 0,
      confirmed_spent_cents: p.result?.experiment_expense_cents ?? 0, request_id: p.approval?.request.request_id ?? null })),
    attention_items: attention };
}
export type CapitalAllocation = ReturnType<typeof calculateAllocation>;
