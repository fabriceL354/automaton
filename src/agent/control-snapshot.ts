import { pilotContext } from "./pilot-context.js";
/** Read-only canonical adapters. Caller holds the V5 lock throughout the snapshot. */
import { readLearningSources } from "./evidence-builder.js";
import { loadLearningState, checkLearningViews } from "./learning-store.js";
import { auditLearning } from "./economic-learning.js";
import { readVerifiedApprovalRecords } from "./approval-gate.js";
import { readVerifiedExternalRecords } from "./external-gateway.js";
import { loadAllocation } from "./allocation-store.js";
import { readAllocationSources, researchCandidates, approvalPins } from "./allocation-sources.js";
import { allocationFingerprint, ALLOCATION_NOTICE } from "./capital-allocator.js";
import { verifyPrefixes } from "./allocation-runner.js";
import { readConfined } from "./ledger-runner.js";
import { canonicalHash, same, structured, exact } from "./project-model.js";
import { parseToolRequest, buildAttentionItems, type ToolRequest } from "./tool-discovery.js";
import { RESEARCH_LIMITS } from "./research-model.js";
import { EVENT_TYPES, type AttentionDTO, type EventProjection } from "./control-model.js";

/** V11.1 output is untrusted information, not authenticated approval evidence.
 * Rebuild its Attention Items from validated research; discard all prose in DTOs. */
async function researchAttention(root: string): Promise<AttentionDTO[]> {
  const raw = await readConfined(root, "research.json", 128 * 1024);
  if (raw === undefined) return [];
  const d = JSON.parse(raw);
  // Reuse V12's full opportunity/evidence/safety-contract validation. BLOCKED is
  // also a legitimate V11.1 output; it carries no execution authority.
  const blocked = d?.status === "BLOCKED";
  researchCandidates(blocked ? JSON.stringify({ ...d, status: "INSUFFICIENT_EVIDENCE" }) : raw);
  if (!Array.isArray(d.tool_requests) || d.tool_requests.length > RESEARCH_LIMITS.toolRequests) throw new Error("Research tool limit");
  const tools: ToolRequest[] = d.tool_requests.map((v: unknown, i: number) => {
    const t = exact(v, ["tool_request_id", "capability_needed", "suggested_tool", "purpose", "project_relevance", "required", "account_required", "credential_required", "estimated_cost_cents", "paid_tool", "data_sent", "risk_level", "expected_benefit", "current_capability_available", "capability_granted", "approval_created"]);
    const { tool_request_id, current_capability_available, capability_granted, approval_created, ...input } = t;
    const parsed = parseToolRequest(JSON.stringify(input), i);
    if (!same(parsed, v)) throw new Error("Research tool contract mismatch");
    return parsed;
  });
  const rebuilt = buildAttentionItems(d.opportunities, tools, blocked);
  if (!same(rebuilt, d.operator_attention)) throw new Error("Research attention differs from canonical projection");
  return rebuilt.map(item => {
    const related = item.category === "TOOL_REQUEST" ? tools.find(t => t.tool_request_id === item.reference_id)
      : d.opportunities.find((o: { opportunity_id: string }) => o.opportunity_id === item.reference_id);
    const ref = `research-${canonicalHash([item, related ?? null])}`;
    return { attention_id: ref, event_type: item.category as AttentionDTO["event_type"],
      subject_type: "research", subject_id: item.reference_id, source_ref: ref,
      requires_human_action: item.actionable, authority: "informational_research" };
  });
}
export async function readControlSnapshot(root: string) {
  const financial = await readLearningSources(root), learning = await loadLearningState(root);
  const learningEvents = learning.state?.events ?? [], hypotheses = auditLearning(learningEvents, financial);
  await checkLearningViews(root, learningEvents, learningEvents.length ? structured({ version: 11, hypotheses, notice: "NO ACTION IS AUTHORIZED BY THIS REPORT." }) : undefined);
  const legacy = await readVerifiedApprovalRecords(root) ?? [], external = await readVerifiedExternalRecords(root);
  const owned = new Set([...financial.model.projects.flatMap(p => [...(p.result?.ledger_entry_ids ?? []), ...p.passive_receipts.flatMap(r => r.ledger_entry_ids)]), ...financial.revenues.flatMap(r => r.result.ledger_entry_ids)]);
  if (financial.ledger.entries.some(e => ["expense", "revenue"].includes(e.type) && !owned.has(e.id))) throw new Error("Unverified financial outcome");
  const approvals = [
    ...legacy.map((r, i) => ({ request_id: r.request.request_id, scope: "experiment" as const, subject_id: r.request.experiment_id,
      status: r.request.status, max_amount_cents: r.request.max_amount_cents, requested_capabilities: r.request.requested_capabilities,
      created_at: r.request.created_at, current: i === legacy.length - 1, consumed: financial.revenues.some(v => v.result.experiment_id === r.request.experiment_id) })),
    ...financial.model.projects.flatMap(p => p.approval ? [{ request_id: p.approval.request.request_id, scope: "project" as const,
      subject_id: p.plan.project_id, status: p.approval.request.status, max_amount_cents: p.approval.request.max_amount_cents,
      requested_capabilities: p.approval.request.requested_capabilities, created_at: p.approval.request.created_at, current: true,
      consumed: !["reserved", "approved"].includes(p.status) }] : []),
    ...external.map((r, i) => ({ request_id: r.approval.request.request_id, scope: "external" as const, subject_id: r.action.action_id,
      status: r.approval.request.status, max_amount_cents: null, requested_capabilities: r.approval.request.requested_capabilities,
      created_at: r.approval.request.created_at, current: i === external.length - 1, consumed: r.execution !== null })),
  ];
  if (new Set(approvals.map(a => a.request_id)).size !== approvals.length) throw new Error("Ambiguous approval ID");
  const attention: AttentionDTO[] = approvals.filter(a => a.current && !a.consumed && a.status === "pending").map(a => ({
    attention_id: `approval-attention-${a.request_id}`, event_type: "APPROVAL_REQUIRED", subject_type: "approval",
    subject_id: a.request_id, source_ref: a.request_id, requires_human_action: true, authority: "authenticated_state" }));
  const loaded = await loadAllocation(root);
  let allocation = null;
  if (loaded.state) {
    const p = loaded.state.proposal, sources = await readAllocationSources(root, p.input_file);
    verifyPrefixes(loaded.state, sources);
    const stale = p.source_state_fingerprint !== allocationFingerprint(sources) || sources.financial.model.projects.some(project =>
      project.status === "active" && project.experiment_deadline! <= new Date().toISOString() && project.experiment_deadline! > p.generated_at);
    allocation = { allocation_id: p.allocation_id, schema_version: 12, status: p.status, generated_at: p.generated_at, stale,
      confirmed_available_cents: p.confirmed_available_cents, confirmed_reserved_cents: p.confirmed_reserved_cents,
      total_confirmed_spent_cents: p.total_confirmed_spent_cents, total_proposed_cents: p.total_proposed_cents,
      selected_projects: p.selected_projects.map(v => ({ opportunity_id: v.opportunity_id, project_id: v.project_id,
        experiment_id: v.experiment_id, proposed_cents: v.proposed_cents, max_duration_days: v.max_duration_days, evidence_ids: v.evidence_ids })),
      out_of_budget_candidates: p.out_of_budget_candidates.map(v => ({ opportunity_id: v.opportunity_id, estimated_cost_cents: v.estimated_cost_cents, evidence_ids: v.evidence_ids })),
      notice: ALLOCATION_NOTICE, action_authorized: false, capability_granted: false, approval_created: false };
    // Pending approvals come from their current V6 state, not an old V12 notice.
    if (!stale) for (const a of p.attention_items) if (a.category !== "APPROVAL_REQUIRED" && a.category !== "INFO") {
      if (!EVENT_TYPES.includes(a.category)) throw new Error("Unknown attention category");
      attention.push({ attention_id: a.attention_id, event_type: a.category, subject_type: "allocation", subject_id: a.reference_id,
        source_ref: a.attention_id, requires_human_action: a.requires_human_decision, authority: "authenticated_state" });
    }
  }
  // Prefer authenticated V12 opportunity alerts when that projection is current.
  attention.push(...(await researchAttention(root)).filter(a => !(allocation && !allocation.stale && a.event_type === "OUT_OF_BUDGET_OPPORTUNITY")));
  const projects = financial.model.projects.map(p => ({ project_id: p.plan.project_id, experiment_id: p.experiment_id, status: p.status,
    budget_cents: p.plan.budget_cents, confirmed_expense_cents: p.result?.experiment_expense_cents ?? null,
    confirmed_revenue_cents: p.result?.experiment_revenue_cents ?? null, lifecycle: p.asset?.status ?? null,
    started_at: p.started_at, deadline: p.experiment_deadline, closed_at: p.closed_at,
    monitoring_state: financial.observations.some(o => o.project_id === p.plan.project_id) ? "authenticated_history" : "no_history",
    latest_observation_at: financial.observations.filter(o => o.project_id === p.plan.project_id).at(-1)?.recorded_at ?? null,
    attention_ids: attention.filter(a => a.subject_id === p.approval?.request.request_id || a.subject_id === p.experiment_id).map(a => a.attention_id) }));
  const projections: EventProjection[] = attention.map(a => ({ ...a, created_at: a.subject_type === "approval" ? approvals.find(r => r.request_id === a.subject_id)!.created_at : null }));
  for (const e of financial.projects) {
    const projectId = e.command.operation === "create-project" ? e.new_id : e.command.target;
    if (!projectId?.startsWith("project-")) continue;
    const type = e.command.operation === "close-experiment" ? "PROJECT_COMPLETED" : "PROJECT_UPDATED";
    projections.push({ attention_id: e.event_id, event_type: type, subject_type: "project", subject_id: projectId,
      source_ref: e.event_id, requires_human_action: false, authority: "authenticated_state", created_at: e.at });
  }
  const pins = approvalPins(legacy);
  const histories: Record<string, unknown[]> = { ledger: financial.ledger.entries, projects: financial.projects, observations: financial.observations,
    revenues: financial.revenues, learning: learningEvents, approval_requests: pins.requests, approval_decisions: pins.decisions,
    external_actions: external.map(r => r.action), external_decisions: external.flatMap(r => r.approval.decision ? [r.approval.decision] : []),
    external_executions: external.flatMap(r => r.execution ? [{ execution_id: r.execution.execution_id, action_id: r.execution.action_id, request_id: r.execution.request_id, attempted_at: r.execution.attempted_at }] : []) };
  const l = financial.ledger, active = projects.filter(p => ["reserved", "approved", "active"].includes(p.status));
  const summary = { schema_version: 1, scout_version: pilotContext() ? "12.6" : "12.5", mode: pilotContext() ? "DRY_RUN_ONLY" : "local", confirmed_available_cents: l.available_balance_cents,
    reserved_cents: l.reserved_balance_cents, confirmed_spent_cents: l.total_recorded_expenses_cents,
    confirmed_revenue_cents: l.total_recorded_revenue_cents, active_project_count: active.length, active_project_ids: active.map(p => p.project_id),
    attention_count: attention.length, pending_approval_count: approvals.filter(a => a.status === "pending" && a.current && !a.consumed).length,
    latest_allocation_id: allocation?.allocation_id ?? null, allocation_stale: allocation?.stale ?? null,
    total_proposed_cents: allocation?.total_proposed_cents ?? null, financial_verification: pilotContext() ? "ALL FINANCIAL VALUES IN THIS PILOT ARE SIMULATED" : "LOCAL_LEDGER_NOT_BANK_VERIFICATION",
    api_can_spend: false, api_can_execute: false };
  return { summary, projects, approvals, allocation, attention, projections, histories };
}
export type ControlSnapshot = Awaited<ReturnType<typeof readControlSnapshot>>;
