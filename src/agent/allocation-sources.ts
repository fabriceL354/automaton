/** V12 read-only adapters. Opportunity estimates never become financial facts. */
import { readConfined } from "./ledger-runner.js";
import { parseOpportunitiesFile } from "./experiment-runner.js";
import { parseOpportunityPhases, researchInteger, researchText, RESEARCH_LIMITS, type ResearchOpportunity, type ResearchEvidence } from "./research-model.js";
import { publicHttpsUrl } from "../scout-web/network.js";
import { exact, canonicalHash, same } from "./project-model.js";
import { integerCents } from "./asset-lifecycle.js";
import { readLearningSources, type Sources } from "./evidence-builder.js";
import { auditLearning } from "./economic-learning.js";
import { loadLearningState, checkLearningViews } from "./learning-store.js";
import { readVerifiedApprovalRecords } from "./approval-gate.js";
import type { LearningEvent } from "./learning-model.js";

export const ALLOCATION_LIMITS = Object.freeze({ MAX_CANDIDATES: 3, MAX_INPUT_BYTES: 128 * 1024,
  MAX_OUTPUT_BYTES: 128 * 1024, MAX_STATE_BYTES: 512 * 1024, MAX_ATTENTION_HISTORY: 128,
  OUT_OF_BUDGET_SCORE_GAP: 15, MIN_RESEARCH_SCORE: 50, MIN_V3_SCORE: 75 });
export const normalizeExposure = (text: string) => text.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
export interface AllocationCandidate {
  opportunity_id: string; fingerprint: string; origin: "V3" | "V11.1"; title: string;
  estimated_cost_cents: number | null; cost_basis: "SOURCE_ESTIMATE" | "ASSUMPTION" | "UNKNOWN";
  score: number; risk_notes: string[]; evidence_ids: string[]; exposure_key: string | null;
  uncertainties: string[];
}
/** Decimal-to-integer conversion: no rounding of monetary floats. */
export function eurosToCents(value: number): number {
  if (!Number.isFinite(value) || Object.is(value, -0) || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(String(value))) throw new Error("Exact euro cents required");
  const [whole, fraction = ""] = String(value).split(".");
  return integerCents(Number(whole) * 100 + Number(fraction.padEnd(2, "0")));
}
function boundedList(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw new Error("Allocation source list limit"); return v;
}
export function researchCandidates(raw: string): AllocationCandidate[] {
  const data = exact(JSON.parse(raw), ["version", "status", "reason", "execution_budget_cents", "research_horizon_cents", "queries", "evidence", "opportunities", "tool_requests", "capabilities", "operator_attention", "metrics", "security"]);
  if (data.version !== "11.1" || !["PASS", "INSUFFICIENT_EVIDENCE"].includes(String(data.status)) || data.execution_budget_cents !== 1000 || data.research_horizon_cents !== 10000) throw new Error("Usable V11.1 research required");
  const security = exact(data.security, ["project_created", "approval_created", "external_action_executed", "money_spent", "capability_granted", "installation_performed"]);
  if (Object.values(security).some(v => v !== false)) throw new Error("Research must confer no authority");
  const evidence = boundedList(data.evidence, RESEARCH_LIMITS.pages).map((v, index): ResearchEvidence => {
    const e = exact(v, ["source_id", "url", "text", "query_id", "round"]);
    if (e.source_id !== `research-source-${index + 1}` || typeof e.query_id !== "string" || !/^research-query-[1-6]$/.test(e.query_id) ||
      typeof e.text !== "string" || !e.text.trim() || e.text.length > RESEARCH_LIMITS.textPerPage) throw new Error("Invalid bounded research evidence");
    return { source_id: e.source_id as string, url: publicHttpsUrl(e.url as string).toString(), text: e.text,
      query_id: e.query_id, round: researchInteger(e.round, RESEARCH_LIMITS.rounds, 1) };
  });
  const ids = new Set<string>();
  return boundedList(data.opportunities, ALLOCATION_LIMITS.MAX_CANDIDATES).map(v => {
    const o = exact(v, ["opportunity_id", "name", "kind", "classification", "estimated_cost_cents", "cost_basis", "budget_excess_cents", "summary", "human_minutes_daily", "market", "platform", "fees", "account_required", "evidence", "risks", "reason_surfaced", "mini_test", "first_question", "execution_authorized", "score"]) as unknown as ResearchOpportunity;
    if (!/^research-opportunity-[1-3]$/.test(o.opportunity_id) || ids.has(o.opportunity_id) || !["QUICK_SERVICE", "DURABLE_ASSET"].includes(o.kind)) throw new Error("Duplicate/invalid canonical opportunity ID/kind");
    ids.add(o.opportunity_id);
    exact(o.evidence, ["source_id", "url", "quote"]); exact(o.mini_test, ["possible", "estimated_cost_cents", "description"]);
    const index = evidence.findIndex(e => e.source_id === o.evidence.source_id);
    if (index < 0) throw new Error("Missing opportunity source");
    const rebuilt = parseOpportunityPhases({ name: o.name, kind: o.kind, source_index: index },
      JSON.stringify({ summary: o.summary, estimated_cost_cents: o.estimated_cost_cents, cost_basis: o.cost_basis, human_minutes_daily: o.human_minutes_daily, account_required: o.account_required }),
      JSON.stringify({ market: o.market, platform: o.platform, fees: o.fees, quote: o.evidence.quote }),
      JSON.stringify({ risks: o.risks, reason_surfaced: o.reason_surfaced, mini_test_possible: o.mini_test.possible, mini_test_cost_cents: o.mini_test.estimated_cost_cents, mini_test_description: o.mini_test.description }),
      evidence, Number(o.opportunity_id.slice(-1)) - 1);
    if (!same(rebuilt, o)) throw new Error("Research opportunity differs from deterministic source/score contract");
    return { opportunity_id: o.opportunity_id, fingerprint: canonicalHash(o), origin: "V11.1" as const, title: o.name,
      estimated_cost_cents: o.estimated_cost_cents, cost_basis: o.cost_basis, score: o.score, risk_notes: o.risks,
      evidence_ids: [o.evidence.source_id],
      // Exact source + explicit market/distribution is a conservative identity,
      // not an inferred correlation between unrelated businesses.
      exposure_key: canonicalHash([o.evidence.url, normalizeExposure(o.market), normalizeExposure(o.platform)]),
      uncertainties: ["FUTURE_REVENUE_UNKNOWN", "ACTUAL_EXPERIMENT_DURATION_UNKNOWN", "ESTIMATE_NOT_FINANCIAL_CONFIRMATION", ...(o.cost_basis === "SOURCE_ESTIMATE" ? [] : ["COST_NOT_SOURCED"])] };
  });
}
export interface AllocationSources {
  financial: Sources; learning_events: LearningEvent[];
  approvals: Awaited<ReturnType<typeof readVerifiedApprovalRecords>>;
  input_file: "research.json" | "opportunities.json"; input_hash: string; candidates: AllocationCandidate[];
}
/** V6 can replace the final pending record with its decision. Pin immutable
 * request bodies and the append-only sequence of terminal decisions separately. */
export function approvalPins(records: NonNullable<AllocationSources["approvals"]>): { requests: unknown[]; decisions: unknown[] } {
  return { requests: records.map(r => { const { status: _status, ...body } = r.request; return body; }),
    decisions: records.filter(r => r.decision !== null).map(r => r.decision) };
}
export async function readAllocationSources(root: string, input: AllocationSources["input_file"]): Promise<AllocationSources> {
  const financial = await readLearningSources(root), learning = await loadLearningState(root);
  const learning_events = learning.state?.events ?? [], hypotheses = auditLearning(learning_events, financial);
  await checkLearningViews(root, learning_events, learning_events.length ? JSON.stringify({ version: 11, hypotheses, notice: "NO ACTION IS AUTHORIZED BY THIS REPORT." }, null, 2) + "\n" : undefined);
  const approvals = await readVerifiedApprovalRecords(root);
  const owned = new Set([...financial.model.projects.flatMap(p => [...(p.result?.ledger_entry_ids ?? []), ...p.passive_receipts.flatMap(r => r.ledger_entry_ids)]),
    ...financial.revenues.flatMap(r => r.result.ledger_entry_ids)]);
  if (financial.ledger.entries.some(e => (e.type === "revenue" || e.type === "expense") && !owned.has(e.id))) throw new Error("Unauthenticated financial outcome; V7/V9 confirmation required");
  const raw = await readConfined(root, input, ALLOCATION_LIMITS.MAX_INPUT_BYTES);
  if (raw === undefined) throw new Error(`Missing explicit allocation input ${input}`);
  let candidates: AllocationCandidate[];
  if (input === "research.json") candidates = researchCandidates(raw);
  else {
    const file = parseOpportunitiesFile(raw);
    candidates = file.opportunities.map(o => {
      // V3 has no canonical opportunity ID; derive a stable content ID, never a project ID.
      const fingerprint = canonicalHash(o);
      return { opportunity_id: `v3-opportunity-${fingerprint.slice(0, 24)}`, fingerprint, origin: "V3", title: researchText(o.name, 120),
        estimated_cost_cents: eurosToCents(o.startup_cost_eur), cost_basis: "ASSUMPTION", score: o.score, risk_notes: o.key_risks,
        evidence_ids: o.evidence_source_indexes.map(i => `v3-source-index-${i}`), exposure_key: null,
        uncertainties: ["FUTURE_REVENUE_UNKNOWN", "ACTUAL_EXPERIMENT_DURATION_UNKNOWN", "V3_SOURCE_CONTENT_UNAVAILABLE", "COST_NOT_SOURCED", "DIVERSIFICATION_UNKNOWN"] };
    });
  }
  if (new Set(candidates.map(c => normalizeExposure(c.title))).size !== candidates.length) throw new Error("Ambiguous duplicate opportunity titles");
  return { financial, learning_events, approvals, input_file: input, input_hash: canonicalHash(raw), candidates };
}
