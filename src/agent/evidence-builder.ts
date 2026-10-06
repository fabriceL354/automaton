/** Read/authenticate V5/V7/V9/V10, then build reconstructible V11 evidence.
 * Missing financial outcomes remain null; claims never enter the arithmetic. */
import { readProjectContext, auditProjects } from "./project-manager.js";
import { readVerifiedRevenueHistory } from "./revenue-runner.js";
import { loadObservationState, checkObservationViews } from "./observation-store.js";
import { auditObservations } from "./experiment-monitor.js";
import { ledgerPrefix, type EconomicLedger } from "./economic-ledger.js";
import { canonicalHash, exact, hex, findProject, type Project, type ProjectModel, type ProjectEvent } from "./project-model.js";
import { integerCents } from "./asset-lifecycle.js";
import { boundedInteger, type ObservationEvent } from "./monitoring-model.js";
import { LEARNING_LIMITS, evidenceLevel, rational, type SourcePin, type HypothesisDefinition, type Evaluation, type EvidenceLink, type Recommendation } from "./learning-model.js";
export class DataConflict extends Error { readonly code = "DATA_CONFLICT"; constructor(message: string) { super(`DATA_CONFLICT: ${message}`); } }
export interface Sources { ledger: EconomicLedger; model: ProjectModel; projects: ProjectEvent[]; observations: ObservationEvent[];
  revenues: Awaited<ReturnType<typeof readVerifiedRevenueHistory>> }
export async function readLearningSources(root: string): Promise<Sources> {
  const current = await readProjectContext(root);
  const revenues = await readVerifiedRevenueHistory(root, current.ledger);
  const loaded = await loadObservationState(root), observations = loaded.state?.events ?? [];
  const verified = await auditObservations(root, observations, current);
  await checkObservationViews(root, observations, verified.report);
  const sources = { ledger: current.ledger, model: current.model, projects: current.state?.events ?? [], observations, revenues };
  assertNoConflicts(sources); return sources;
}
export function sourcePin(s: Sources): SourcePin {
  return { ledger_count: s.ledger.entries.length, ledger_hash: canonicalHash(s.ledger), project_count: s.projects.length, project_hash: canonicalHash(s.projects),
    observation_count: s.observations.length, observation_hash: canonicalHash(s.observations), revenue_count: s.revenues.length, revenue_hash: canonicalHash(s.revenues) };
}
export function historicalSources(s: Sources, pin: SourcePin): Sources {
  exact(pin, ["ledger_count", "ledger_hash", "project_count", "project_hash", "observation_count", "observation_hash", "revenue_count", "revenue_hash"]);
  boundedInteger(pin.ledger_count, s.ledger.entries.length, 1); boundedInteger(pin.project_count, s.projects.length);
  boundedInteger(pin.observation_count, s.observations.length); boundedInteger(pin.revenue_count, s.revenues.length);
  const ledger = ledgerPrefix(s.ledger, pin.ledger_count), projects = s.projects.slice(0, pin.project_count), observations = s.observations.slice(0, pin.observation_count), revenues = s.revenues.slice(0, pin.revenue_count);
  for (const [value, hash] of [[ledger, pin.ledger_hash], [projects, pin.project_hash], [observations, pin.observation_hash], [revenues, pin.revenue_hash]] as const) {
    if (canonicalHash(value) !== hex(hash)) throw new Error("Learning authenticated source prefix mismatch");
  }
  if (observations.some(e => e.project_history_count > projects.length || e.ledger_count > ledger.entries.length) || revenues.some(r => r.ledger_after_count > ledger.entries.length)) throw new DataConflict("Source snapshot includes future records");
  const historical = { ledger, projects, observations, revenues, model: auditProjects(projects, ledger) };
  assertNoConflicts(historical); return historical;
}
export function sourceTime(s: Sources): string {
  return [s.ledger.entries.at(-1)!.timestamp, ...s.projects.map(e => e.at), ...s.observations.map(e => e.recorded_at), ...s.revenues.map(r => r.result.recorded_at)].sort().at(-1)!;
}
export function assertNoConflicts(s: Sources): void {
  const owners = new Map<string, string>(), experiments = new Set(s.model.projects.map(p => p.experiment_id));
  const own = (id: string, entries: string[]) => { for (const entry of entries) { if (owners.has(entry)) throw new DataConflict("Financial entry has multiple authoritative owners"); owners.set(entry, id); } };
  for (const p of s.model.projects) { if (p.result) own(p.experiment_id, p.result.ledger_entry_ids); for (const r of p.passive_receipts) own(p.experiment_id, r.ledger_entry_ids); }
  for (const r of s.revenues) {
    if (experiments.has(r.result.experiment_id)) throw new DataConflict("V7 and V9 both claim the same experiment");
    experiments.add(r.result.experiment_id); own(r.result.experiment_id, r.result.ledger_entry_ids);
  }
}
function financialEntries(s: Sources, ids: string[], scope: "experiment" | "post_experiment") {
  return ids.map(id => {
    const entry = s.ledger.entries.find(e => e.id === id);
    if (!entry) throw new DataConflict("Missing linked financial entry");
    return { entry_id: entry.id, hash: entry.hash, type: entry.type, amount_cents: entry.amount_cents, timestamp: entry.timestamp, scope };
  });
}
export function verifyFinancialTotals(entries: ReturnType<typeof financialEntries>, expense: number, revenue: number) {
  const total = (type: string) => integerCents(entries.filter(e => e.type === type).reduce((sum, e) => sum + e.amount_cents, 0));
  if (total("expense") !== expense || total("revenue") !== revenue) throw new DataConflict("Authenticated result and ledger totals disagree");
}
function outcome(net: number | null) { return net === null ? "unknown" : net > 0 ? "positive" : net < 0 ? "negative" : "break_even"; }
function derived(expense: number | null, revenue: number | null, passive: number | null, blockers: number, risks: number, pendingAsset: boolean) {
  const net = expense === null || revenue === null ? null : integerCents(revenue - expense, true);
  const lifetime = revenue === null || passive === null ? null : integerCents(revenue + passive);
  const lifetimeNet = lifetime === null || expense === null ? null : integerCents(lifetime - expense, true);
  const components = { experiment_net_sign: net === null ? 0 : Math.sign(net) * 2, lifetime_net_sign: lifetimeNet === null ? 0 : Math.sign(lifetimeNet) * 2,
    confirmed_revenue_present: lifetime !== null && lifetime > 0 ? 1 : 0, blocker_present: blockers ? -1 : 0, risk_present: risks ? -1 : 0 };
  const score = { value: net === null ? null : Object.values(components).reduce((a, b) => a + b, 0), components, is_probability: false, meaning: "descriptive_only" };
  let recommendation: Recommendation = "insufficient_evidence";
  if (net !== null && lifetimeNet !== null) {
    if (blockers || risks) recommendation = "modify_and_retry";
    else if (net > 0 && lifetimeNet > 0) recommendation = "repeat_small";
    else if (net <= 0 && lifetimeNet > 0) recommendation = "modify_and_retry";
    else if (pendingAsset) recommendation = "observe_longer";
    else if (lifetimeNet < 0) recommendation = "avoid_for_now";
  }
  return { experiment_net_cents: net, lifetime_revenue_cents: lifetime, lifetime_net_cents: lifetimeNet,
    experiment_outcome: outcome(net), lifetime_outcome: outcome(lifetimeNet),
    revenue_per_euro_spent: rational(revenue, expense), net_per_euro_spent: rational(net, expense), lifetime_revenue_per_euro_spent: rational(lifetime, expense),
    score, recommendation: { kind: recommendation, action_authorized: false, confidence: evidenceLevel(net === null ? 0 : 1) } };
}
export function buildProjectEvidence(s: Sources, projectId: string, experimentId?: string) {
  const p = findProject(s.model, projectId, experimentId), result = p.result;
  const events = s.observations.filter(e => e.project_id === projectId && e.experiment_id === p.experiment_id);
  const snapshots = (asset: boolean) => {
    const values: Record<string, { value: number; observation_id: string; effective_at: string; recorded_at: string }> = {};
    for (const e of [...events].filter(e => (e.asset_id !== null) === asset).sort((a, b) => a.effective_at < b.effective_at ? -1 : a.effective_at > b.effective_at ? 1 : 0)) {
      if (typeof e.data.metric === "string") values[e.data.metric] = { value: e.data.value as number, observation_id: e.event_id, effective_at: e.effective_at, recorded_at: e.recorded_at };
    }
    return values;
  };
  const experiment = financialEntries(s, result?.ledger_entry_ids ?? [], "experiment");
  if (result) verifyFinancialTotals(experiment, result.experiment_expense_cents, result.experiment_revenue_cents);
  const post = p.passive_receipts.flatMap(r => { const entries = financialEntries(s, r.ledger_entry_ids, "post_experiment"); verifyFinancialTotals(entries, 0, r.amount_cents); return entries; });
  const financial = [...experiment, ...post];
  if (financial.some(e => p.started_at && e.timestamp < p.started_at)) throw new DataConflict("Financial event precedes project start");
  const first = financial.filter(e => e.type === "revenue").map(e => e.timestamp).sort()[0] ?? null;
  const risks = events.filter(e => e.type === "risk"), blockers = events.filter(e => e.type === "blocker");
  const observations = { availability: s.observations.length ? "authenticated_history" : "no_history", experiment_metrics: snapshots(false), asset_metrics: snapshots(true),
    checkpoints: events.filter(e => e.type === "checkpoint"), risks, blockers,
    claims: events.filter(e => e.type === "sale_claim" || e.type === "expense_claim").map(e => ({ observation_id: e.event_id, type: e.type, amount_cents: e.data.amount_cents,
      asset_id: e.asset_id, reconciliation: events.find(r => r.type === "reconciliation" && r.data.observation_id === e.event_id)?.data ?? null })) };
  const expense = result?.experiment_expense_cents ?? null, revenue = result?.experiment_revenue_cents ?? null;
  const passive = result ? integerCents(post.filter(e => e.type === "revenue").reduce((sum, e) => sum + e.amount_cents, 0)) : null;
  const metrics = derived(expense, revenue, passive, blockers.length, risks.length, p.asset?.status === "passive_monitoring");
  const refs = { snapshot: sourcePin(s), result_id: result?.result_id ?? null, result_hash: result ? canonicalHash(result) : null,
    project_event_refs: s.projects.filter(e => e.command.target === projectId || e.new_id === projectId).map(e => ({ event_id: e.event_id, hash: canonicalHash(e) })),
    receipt_refs: p.passive_receipts.map(r => ({ receipt_id: r.receipt_id, hash: canonicalHash(r) })), financial_entries: financial,
    observation_refs: events.map(e => ({ event_id: e.event_id, hash: canonicalHash(e) })) };
  const refCount = refs.project_event_refs.length + refs.receipt_refs.length + refs.financial_entries.length + refs.observation_refs.length;
  if (refCount > LEARNING_LIMITS.MAX_EVIDENCE_LINKS) throw new Error("Learning evidence link limit");
  return { project_id: projectId, experiment_id: p.experiment_id, asset_id: p.asset?.asset_id ?? null, batch_id: p.plan.batch_id, name: p.plan.name,
    as_of: sourceTime(s), facts: { source: "authenticated_human_confirmation", financial_status: result ? "confirmed_closed" : "pending_result",
      experiment_expense_cents: expense, experiment_revenue_cents: revenue, post_experiment_revenue_cents: passive,
      planned_duration_days: p.plan.duration_days, started_at: p.started_at, experiment_deadline: p.experiment_deadline, closed_at: p.closed_at,
      classification: result?.classification ?? null, asset_status: p.asset?.status ?? null, project_status: p.status, first_confirmed_revenue_at: first },
    observations, derived_metrics: { ...metrics, actual_duration_ms: p.started_at && result ? Date.parse(result.closed_at) - Date.parse(p.started_at) : null,
      deadline_net_cents: result && result.closed_at === p.experiment_deadline ? metrics.experiment_net_cents : null,
      time_to_first_confirmed_revenue_ms: first && p.started_at ? Date.parse(first) - Date.parse(p.started_at) : null },
    original_hypothesis: { statement: p.plan.hypothesis, human_classification: result?.classification ?? null, automatic_validation: "not_inferred" },
    source_refs: refs };
}
export type ProjectEvidence = ReturnType<typeof buildProjectEvidence>;
export function buildLegacyEvidence(s: Sources, experimentId: string) {
  hex(experimentId); const record = s.revenues.find(r => r.result.experiment_id === experimentId);
  if (!record) throw new Error("Exact authenticated V7 experiment required");
  const r = record.result, entries = financialEntries(s, r.ledger_entry_ids, "experiment"); verifyFinancialTotals(entries, r.expense_cents, r.revenue_cents);
  const metrics = derived(r.expense_cents, r.revenue_cents, null, 0, 0, false);
  return { project_id: null, experiment_id: experimentId, asset_id: null, batch_id: null, name: r.opportunity_name,
    facts: { source: "authenticated_V7_human_confirmation", experiment_expense_cents: r.expense_cents, experiment_revenue_cents: r.revenue_cents,
      classification: r.outcome, closed_at: r.recorded_at, planned_duration_days: r.planned_duration_days, post_experiment_revenue_cents: null,
      first_confirmed_revenue_at: entries.filter(e => e.type === "revenue").map(e => e.timestamp).sort()[0] ?? null },
    observations: { availability: "no_V9_project_binding" }, derived_metrics: { ...metrics, time_to_first_confirmed_revenue_ms: null, deadline_net_cents: null },
    source_refs: { snapshot: sourcePin(s), result_id: r.result_id, record_hash: canonicalHash(record), financial_entries: entries },
    limitation: "Standalone V7 has no authenticated V9 project/start/asset binding; lifetime and elapsed revenue time remain unknown." };
}
export function batchEvidence(s: Sources, batchId: string): ProjectEvidence[] {
  if (s.model.batch?.batch_id !== batchId) throw new Error("Exact existing batch required");
  if (s.model.projects.length > LEARNING_LIMITS.MAX_PROJECTS_ANALYZED_PER_RUN) throw new Error("Learning project limit");
  return s.model.projects.map(p => buildProjectEvidence(s, p.plan.project_id));
}
export function evaluateHypothesis(s: Sources, d: HypothesisDefinition): Evaluation {
  const result: Evaluation = { evidence_for: [], evidence_against: [], missing_project_ids: [] };
  for (const e of batchEvidence(s, d.batch_id)) {
    const net = e.derived_metrics.experiment_net_cents, lifetime = e.derived_metrics.lifetime_net_cents;
    const inquiries = e.observations.experiment_metrics.inquiries?.value ?? null;
    if (net === null || lifetime === null || (d.rule === "inquiries_lifetime" && inquiries === null)) { result.missing_project_ids.push(e.project_id); continue; }
    const support = d.rule === "experiment_profitability" ? net > 0 : (inquiries! >= d.min_inquiries!) === (lifetime > 0);
    const link: EvidenceLink = { project_id: e.project_id, experiment_id: e.experiment_id, asset_id: e.asset_id,
      evidence_hash: canonicalHash({ experiment: e.experiment_id, net, lifetime, inquiries, rule: d.rule, threshold: d.min_inquiries }),
      inquiries, experiment_net_cents: net, lifetime_net_cents: lifetime,
      reason: d.rule === "experiment_profitability" ? "Confirmed experiment net compared with zero" : "Observed inquiries threshold compared with confirmed lifetime net; association only, no causality" };
    (support ? result.evidence_for : result.evidence_against).push(link);
  }
  return result;
}
export function compareEvidence(items: ProjectEvidence[]) {
  if (items.length !== 2 || items[0].project_id === items[1].project_id) throw new Error("Two distinct projects required");
  const [a, b] = items, warnings: string[] = [];
  if (items.some(e => e.facts.financial_status !== "confirmed_closed")) warnings.push("MISSING_CONFIRMED_RESULT");
  if (a.facts.planned_duration_days !== b.facts.planned_duration_days || a.derived_metrics.actual_duration_ms !== b.derived_metrics.actual_duration_ms) warnings.push("UNEQUAL_EXPERIMENT_DURATION");
  if (a.facts.experiment_expense_cents !== b.facts.experiment_expense_cents) warnings.push("UNEQUAL_CONFIRMED_COSTS");
  if (a.facts.started_at !== b.facts.started_at || a.facts.closed_at !== b.facts.closed_at || a.facts.asset_status !== b.facts.asset_status) warnings.push("UNEQUAL_LIFETIME_EXPOSURE_OR_ASSET_STATE");
  const samples = items.filter(e => e.facts.financial_status === "confirmed_closed").length;
  return { winner: null, generalization: "insufficient_evidence", confidence: evidenceLevel(samples), sample_size: samples, warnings,
    lifetime_net_difference_a_minus_b_cents: a.derived_metrics.lifetime_net_cents !== null && b.derived_metrics.lifetime_net_cents !== null ? integerCents(a.derived_metrics.lifetime_net_cents - b.derived_metrics.lifetime_net_cents, true) : null,
    interpretation: "Descriptive comparison of these exact histories only; no strategy is proven." };
}
