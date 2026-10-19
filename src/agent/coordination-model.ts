/** V14.6 Coordination Preview: deterministic, data-only contracts. No tools, network or finance imports. */
import { createHash } from "node:crypto";
import type { ResearchOutput } from "./research-controller.js";
import type { ResearchOpportunity, ResearchEvidence } from "./research-model.js";

const MAX_INPUT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SOURCE_MAX_CHARS = 2_400;
const sha256 = (raw: string) => createHash("sha256").update(raw).digest("hex");
const exact = (v: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== fields.length ||
      Object.keys(v).some(k => !fields.includes(k))) throw new Error("Invalid preview snapshot structure");
  return v as Record<string, unknown>;
};
const str = (v: unknown, length: number): string => {
  if (typeof v !== "string" || !v.trim() || v.length > length || /[\p{Cc}\p{Cf}]/u.test(v)) throw new Error("Invalid preview text");
  return v;
};
const id = (v: unknown, prefix: string, max = 100): string => {
  const s = str(v, max);
  if (!new RegExp(`^${prefix}-[1-9][0-9]*$`).test(s)) throw new Error("Invalid preview reference");
  return s;
};
const num = (v: unknown, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || Object.is(v, -0) || v < min || v > max)
    throw new Error("Invalid preview integer");
  return v;
};
const arr = (v: unknown, max: number): unknown[] => {
  if (!Array.isArray(v) || v.length > max) throw new Error("Invalid preview array");
  return v;
};
const enumValue = <T extends string>(v: unknown, options: readonly T[]): T => {
  if (typeof v !== "string" || !options.includes(v as T)) throw new Error("Invalid preview enum");
  return v as T;
};
const optionalCents = (v: unknown, max = 10_000): number | null => v === null ? null : num(v, 0, max);
const sourceFields = ["source_id", "url", "text", "query_id", "round"];
const queryFields = ["query_id", "round", "provenance", "evidence_source_ids", "decision", "query", "reason", "result_count", "provider_source"];
const opportunityFields = ["opportunity_id", "name", "kind", "classification", "estimated_cost_cents", "cost_basis", "budget_excess_cents", "summary", "human_minutes_daily", "market", "platform", "fees", "account_required", "evidence", "risks", "reason_surfaced", "mini_test", "first_question", "execution_authorized", "score"];
const metricFields = ["rounds", "queries", "pages", "model_calls", "compressed_bytes", "decompressed_bytes", "gzip_reads", "rejected_model_outputs"];
const securityFields = ["project_created", "approval_created", "external_action_executed", "money_spent", "capability_granted", "installation_performed"];
const topFields = ["version", "status", "reason", "execution_budget_cents", "research_horizon_cents", "queries", "evidence", "opportunities", "tool_requests", "capabilities", "operator_attention", "metrics", "security"];

export interface CoordinationInput {
  readonly research: ResearchOutput;
  readonly input_sha256: string;
}

/** Parse the whole V14.5 snapshot, then validate every field consumed by V14.6.
 * Other arrays are deliberately ignored and never forwarded to inference. */
export function parseCoordinationInput(raw: string): CoordinationInput {
  if (typeof raw !== "string" || !raw.length || Buffer.byteLength(raw) > MAX_INPUT_BYTES) throw new Error("Invalid preview input size");
  const data = exact(JSON.parse(raw), topFields);
  if (data.version !== "11.1" || data.execution_budget_cents !== 1000 || data.research_horizon_cents !== 10000)
    throw new Error("Invalid preview research contract");
  enumValue(data.status, ["PASS", "BLOCKED", "INSUFFICIENT_EVIDENCE"] as const);
  str(data.reason, 160);
  const security = exact(data.security, securityFields);
  for (const field of securityFields) if (security[field] !== false) throw new Error("Unsafe preview input security state");
  const metrics = exact(data.metrics, metricFields);
  for (const field of metricFields) num(metrics[field], 0, 10_000_000);
  if ((metrics.model_calls as number) > 20 || (metrics.pages as number) > 10 || (metrics.rounds as number) > 3 || (metrics.queries as number) > 6)
    throw new Error("Preview research limits exceeded");
  const queries = arr(data.queries, 18);
  const seenQueries = new Set<string>();
  const accepted = new Map<string, number>();
  for (const item of queries) {
    const q = exact(item, queryFields);
    const queryId = id(q.query_id, "research-query");
    if (seenQueries.has(queryId)) throw new Error("Duplicate query");
    seenQueries.add(queryId);
    const round = num(q.round, 1, 3);
    enumValue(q.provenance, ["INITIAL_PUBLIC_MISSION", "MODEL_REFINEMENT", "EVIDENCE_DERIVED"] as const);
    enumValue(q.decision, ["ACCEPT", "REJECT", "DUPLICATE"] as const);
    arr(q.evidence_source_ids, 10).forEach(v => id(v, "research-source"));
    if (q.query !== null) str(q.query, 300);
    if (q.reason !== null) str(q.reason, 200);
    if (q.provider_source !== null) str(q.provider_source, 2000);
    num(q.result_count, 0, 5);
    if (q.decision === "ACCEPT") accepted.set(queryId, round);
  }
  const evidence = arr(data.evidence, 10);
  const seenSourceIds = new Set<string>();
  const seenUrls = new Set<string>();
  const sources = new Map<string, ResearchEvidence>();
  for (const item of evidence) {
    const e = exact(item, sourceFields);
    const sourceId = id(e.source_id, "research-source");
    const url = str(e.url, 2000);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("Invalid preview evidence URL"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || !parsed.hostname ||
        /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|\[)/i.test(parsed.hostname))
      throw new Error("Nonpublic preview evidence URL");
    const body = e.text;
    if (typeof body !== "string" || body.length < 80 || body.length > SOURCE_MAX_CHARS) {
      throw new Error("Invalid preview evidence text");
    }
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B-\u200F\u202A-\u202E\u2060-\u206F]/u.test(body)) throw new Error("Unsafe preview evidence text");
    const queryId = id(e.query_id, "research-query");
    const round = num(e.round, 1, 3);
    if (seenSourceIds.has(sourceId) || seenUrls.has(url) || accepted.get(queryId) !== round)
      throw new Error("Duplicate or unverified preview evidence");
    seenSourceIds.add(sourceId); seenUrls.add(url);
    sources.set(sourceId, item as ResearchEvidence);
  }
  const opportunities = arr(data.opportunities, 3);
  const opportunityIds = new Set<string>();
  for (const item of opportunities) {
    const o = exact(item, opportunityFields);
    const oid = id(o.opportunity_id, "research-opportunity");
    if (opportunityIds.has(oid)) throw new Error("Duplicate opportunity");
    opportunityIds.add(oid);
    str(o.name, 80); str(o.summary, 240); str(o.market, 240); str(o.platform, 240); str(o.fees, 240);
    str(o.reason_surfaced, 240); str(o.first_question, 200);
    enumValue(o.kind, ["QUICK_SERVICE", "DURABLE_ASSET"] as const);
    enumValue(o.classification, ["IN_BUDGET_CANDIDATE", "OUT_OF_BUDGET_OPPORTUNITY", "COST_UNCONFIRMED"] as const);
    enumValue(o.cost_basis, ["SOURCE_ESTIMATE", "ASSUMPTION", "UNKNOWN"] as const);
    num(o.human_minutes_daily, 0, 480); num(o.score, 0, 100);
    if (typeof o.account_required !== "boolean" || o.execution_authorized !== false) throw new Error("Unsafe opportunity flags");
    for (const risk of arr(o.risks, 3)) str(risk, 160);
    if ((o.risks as unknown[]).length === 0) throw new Error("Missing opportunity risks");
    const snippet = exact(o.evidence, ["source_id", "url", "quote"]);
    const matched = sources.get(id(snippet.source_id, "research-source"));
    const quote = str(snippet.quote, 180);
    if (quote.length < 16 || !matched || matched.url !== snippet.url || !matched.text.includes(quote))
      throw new Error("Forged or ungrounded preview citation");
    const cost = optionalCents(o.estimated_cost_cents);
    if ((cost === null) !== (o.cost_basis === "UNKNOWN")) throw new Error("Invalid cost uncertainty");
    const correctCategory = cost === null ? "COST_UNCONFIRMED" : cost > 1000 ? "OUT_OF_BUDGET_OPPORTUNITY" : "IN_BUDGET_CANDIDATE";
    if (o.classification !== correctCategory || o.budget_excess_cents !== (cost === null ? null : Math.max(cost - 1000, 0)))
      throw new Error("Invalid cost classification");
    if (o.cost_basis === "SOURCE_ESTIMATE") {
      const amounts = [...quote.matchAll(/\b(\d+(?:[.,]\d{1,2})?)\s*(?:EUR|euros?|€)/gi)]
        .map(m => Math.round(Number(m[1].replace(",", ".")) * 100));
      if (!(cost === 0 && /gratuit|free|sans investissement/i.test(quote)) && !amounts.includes(cost!))
        throw new Error("Preview source amount is not grounded");
    }
    const mini = exact(o.mini_test, ["possible", "estimated_cost_cents", "description"]);
    if (typeof mini.possible !== "boolean" || (mini.estimated_cost_cents === null) === mini.possible)
      throw new Error("Invalid mini-test cost status");
    optionalCents(mini.estimated_cost_cents, 1000);
    str(mini.description, 240);
  }
  arr(data.tool_requests, 5); arr(data.capabilities, 64); arr(data.operator_attention, 60);
  const parsed = data as unknown as ResearchOutput;
  return { research: parsed, input_sha256: sha256(raw) };
}

export type PreviewDecision = "REVIEW_REQUIRED" | "REJECTED" | "INSUFFICIENT_EVIDENCE";
export interface PreviewOpportunity {
  opportunity_id: string;
  decision: PreviewDecision;
  evidence_source_ids: string[];
  facts: string[];
  assumptions: string[];
  unknowns: string[];
  blocking_reasons: string[];
  priority: number;
}
export interface CoordinationOutput {
  version: "14.6-preview";
  status: "PASS" | "BLOCKED" | "INSUFFICIENT_EVIDENCE";
  input_sha256: string;
  opportunities: PreviewOpportunity[];
  metrics: { extra_model_calls: number; duration_ms: number; rejected_outputs: number };
  security: { external_action_executed: false; money_spent: false; project_created: false; approval_created: false; publication_performed: false };
}
export const previewSecurity = () => ({ external_action_executed: false, money_spent: false, project_created: false, approval_created: false, publication_performed: false } as const);

/** Cost facts are deliberately NEVER promoted into project startup costs by this preview. */
export function classifyUncertainty(o: ResearchOpportunity): Pick<PreviewOpportunity, "decision" | "assumptions" | "unknowns" | "blocking_reasons"> {
  const assumptions = ["Demande et revenus du projet non démontrés"];
  const unknowns = ["Rentabilité, clientèle et ventes non vérifiées"];
  const blocking_reasons: string[] = ["NO_VERIFIED_DEMAND"];
  if (o.estimated_cost_cents === null) {
    unknowns.push("Coût de lancement inconnu"); blocking_reasons.push("COST_UNCONFIRMED");
  } else if (o.cost_basis === "ASSUMPTION") {
    assumptions.push(`Budget supposé : ${o.estimated_cost_cents} centimes, non vérifié`);
    blocking_reasons.push("COST_ASSUMPTION_ONLY");
  } else {
    unknowns.push("Un montant cité ne prouve pas le coût de lancement de ce projet");
    blocking_reasons.push("SOURCE_AMOUNT_NOT_PROJECT_COST");
  }
  if (o.account_required) { unknowns.push("Conditions d'ouverture du compte non vérifiées"); blocking_reasons.push("ACCOUNT_REQUIRED"); }
  if (o.human_minutes_daily > 15) { assumptions.push("Supervision quotidienne estimée supérieure à 15 minutes"); blocking_reasons.push("SUPERVISION_ESTIMATE_HIGH"); }
  if (o.classification === "OUT_OF_BUDGET_OPPORTUNITY") blocking_reasons.push("OVER_SIMULATED_BUDGET");
  return { decision: o.cost_basis === "UNKNOWN" ? "INSUFFICIENT_EVIDENCE" : "REVIEW_REQUIRED", assumptions, unknowns, blocking_reasons };
}

export function verifyEvidence(input: CoordinationInput): PreviewOpportunity[] {
  const ordered = [...input.research.opportunities].sort((a, b) => b.score - a.score || a.opportunity_id.localeCompare(b.opportunity_id));
  return ordered.map((o, index) => {
    const finding = classifyUncertainty(o);
    // The actual source quote remains untrusted; avoid copying it into facts or model instructions.
    return {
      opportunity_id: o.opportunity_id,
      decision: finding.decision,
      evidence_source_ids: [o.evidence.source_id],
      facts: [`Provenance vérifiée : ${o.evidence.source_id} (citation exacte présente dans le texte consulté)`],
      assumptions: finding.assumptions,
      unknowns: finding.unknowns,
      blocking_reasons: finding.blocking_reasons,
      priority: index + 1,
    };
  });
}

export function parseCoordinationOutput(raw: string): CoordinationOutput {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_OUTPUT_BYTES) throw new Error("Invalid preview output size");
  const d = exact(JSON.parse(raw), ["version", "status", "input_sha256", "opportunities", "metrics", "security"]);
  if (d.version !== "14.6-preview" || typeof d.input_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(d.input_sha256))
    throw new Error("Invalid preview output identity");
  enumValue(d.status, ["PASS", "BLOCKED", "INSUFFICIENT_EVIDENCE"] as const);
  const opportunities = arr(d.opportunities, 3);
  const seen = new Set<string>();
  for (const item of opportunities) {
    const o = exact(item, ["opportunity_id", "decision", "evidence_source_ids", "facts", "assumptions", "unknowns", "blocking_reasons", "priority"]);
    const oid = id(o.opportunity_id, "research-opportunity");
    if (seen.has(oid)) throw new Error("Duplicate preview result");
    seen.add(oid);
    enumValue(o.decision, ["REVIEW_REQUIRED", "REJECTED", "INSUFFICIENT_EVIDENCE"] as const);
    arr(o.evidence_source_ids, 10).forEach(v => id(v, "research-source"));
    for (const key of ["facts", "assumptions", "unknowns", "blocking_reasons"]) arr(o[key], 10).forEach(v => str(v, 240));
    num(o.priority, 1, 3);
  }
  if (d.status === "PASS" && !opportunities.some(item => {
    const o = item as Record<string, unknown>;
    return o.decision === "REVIEW_REQUIRED" &&
      (o.evidence_source_ids as unknown[]).length > 0 && (o.facts as unknown[]).length > 0;
  })) throw new Error("PASS preview requires a valid reviewable opportunity with provenance");
  const m = exact(d.metrics, ["extra_model_calls", "duration_ms", "rejected_outputs"]);
  num(m.extra_model_calls, 0, 2); num(m.duration_ms, 0, 180_000); num(m.rejected_outputs, 0, 2);
  const safety = exact(d.security, ["external_action_executed", "money_spent", "project_created", "approval_created", "publication_performed"]);
  for (const value of Object.values(safety)) if (value !== false) throw new Error("Preview output claims an unsafe action");
  if (d.status === "BLOCKED" && opportunities.length) throw new Error("Blocked preview cannot return actionable data");
  return d as unknown as CoordinationOutput;
}
