/** Research contracts only. These artifacts cannot be consumed as V4/V9 plans. */
import { guardQuery, type QueryProvenance } from "./query-guard.js";
export const RESEARCH_LIMITS = Object.freeze({ rounds: 3, queries: 6, resultsPerQuery: 5, pages: 10, toolRequests: 5,
  queryChars: 300, totalCompressedBytes: 4 * 1024 * 1024, totalDecompressedBytes: 4 * 1024 * 1024,
  responseBytes: 256 * 1024, textPerPage: 2400, evidenceToModelChars: 4800, modelCalls: 20,
  modelResponseBytes: 16 * 1024, runTimeoutMs: 20 * 60 * 1000, candidates: 3,
  executionBudgetCents: 1000, researchHorizonCents: 10000, supervisionMinutesDaily: 15 });
export const PUBLIC_RESEARCH_MISSION = "Trouve en France des expériences économiques réalisables par une seule personne avec un budget initial maximum de 10 EUR. Cherche notamment une piste de revenu rapide et une piste créant un actif numérique durable. Identifie également les outils ou capacités manquants qui pourraient améliorer les résultats.";
export const FAMILIES = Object.freeze({ micro_service: "micro service freelance", digital_template: "template produit numérique", writing: "rédaction correction", translation: "traduction service", design: "design graphique service", tutoring: "cours particuliers", spreadsheet: "tableur modèle numérique", guide: "guide numérique" });
export const FOCUSES = Object.freeze({ explore: "sans investissement 0 euro 10 euros", market: "demande marché clients distribution", cost: "coût frais plateforme compte requis", validate: "mini test gratuit validation 7 jours faible temps supervision" });
export interface ResearchIntent { family: keyof typeof FAMILIES; focus: keyof typeof FOCUSES; evidence_index: number | null }
export interface ResearchEvidence { source_id: string; url: string; text: string; query_id: string; round: number }
export interface QueryAudit { query_id: string; round: number; provenance: QueryProvenance; evidence_source_ids: string[];
  decision: "ACCEPT" | "REJECT" | "DUPLICATE"; query: string | null; reason: string | null; result_count: number; provider_source: string | null }
export function exactResearch(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length ||
    Object.keys(value).some(k => !fields.includes(k))) throw new Error("Invalid research fields");
  return value as Record<string, unknown>;
}
export function researchText(value: unknown, max = 240): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\p{Cc}\p{Cf}]/u.test(value) ||
      /(?:https?|file):|[<>]|\b(?:token|bearer|password|credential|cvv|wallet|seed phrase|economic-ledger|read_file|write_file)\b|[a-z0-9_+/-]{32,}/i.test(value)) throw new Error("Invalid public research text");
  return value.trim();
}
export function researchInteger(value: unknown, max: number, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) throw new Error("Invalid research integer");
  return value;
}
export function researchBoolean(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("Invalid research boolean"); return value; }
export function parseIntents(raw: string, evidenceCount: number): ResearchIntent[] {
  const d = exactResearch(JSON.parse(raw), ["intents"]);
  if (!Array.isArray(d.intents) || !d.intents.length || d.intents.length > 2) throw new Error("Invalid intent count");
  return d.intents.map(v => {
    const x = exactResearch(v, ["family", "focus", "evidence_index"]);
    if (typeof x.family !== "string" || !Object.hasOwn(FAMILIES, x.family) || typeof x.focus !== "string" || !Object.hasOwn(FOCUSES, x.focus)) throw new Error("Unknown public intent");
    return { family: x.family as ResearchIntent["family"], focus: x.focus as ResearchIntent["focus"],
      evidence_index: x.evidence_index === null ? null : researchInteger(x.evidence_index, evidenceCount - 1) };
  });
}
/** No model/page prose becomes an outbound string: only audited dictionary terms. */
export function reconstructQuery(intent: ResearchIntent): string {
  // Revalidate even for trusted-host direct callers, never interpolate arbitrary text.
  const [checked] = parseIntents(JSON.stringify({ intents: [intent] }), intent.evidence_index === null ? 0 : RESEARCH_LIMITS.pages);
  return `France ${FAMILIES[checked.family]} ${FOCUSES[checked.focus]}`;
}
export function publicResearchMission(value = PUBLIC_RESEARCH_MISSION): string {
  researchText(value, 1000);
  // Overlap catches sensitive patterns across chunk boundaries; mission prose
  // is never interpolated into outbound queries, regardless of this guard.
  for (let start = 0; start < value.length; start += 225) {
    if (guardQuery(value.slice(start, start + 300), "INITIAL_PUBLIC_MISSION").decision !== "ACCEPT") throw new Error("Public research mission refused");
  }
  return value.trim();
}
export interface ResearchCandidate { name: string; kind: "QUICK_SERVICE" | "DURABLE_ASSET"; source_index: number }
export function parseResearchCandidates(raw: string, evidenceCount: number): ResearchCandidate[] {
  const d = exactResearch(JSON.parse(raw), ["candidates"]);
  if (!Array.isArray(d.candidates) || d.candidates.length > RESEARCH_LIMITS.candidates) throw new Error("Invalid candidate count");
  return d.candidates.map(v => {
    const x = exactResearch(v, ["name", "kind", "source_index"]);
    if (x.kind !== "QUICK_SERVICE" && x.kind !== "DURABLE_ASSET") throw new Error("Invalid candidate kind");
    return { name: researchText(x.name, 80), kind: x.kind, source_index: researchInteger(x.source_index, evidenceCount - 1) };
  });
}
export interface ResearchOpportunity {
  opportunity_id: string; name: string; kind: ResearchCandidate["kind"];
  classification: "IN_BUDGET_CANDIDATE" | "OUT_OF_BUDGET_OPPORTUNITY" | "COST_UNCONFIRMED";
  estimated_cost_cents: number | null; cost_basis: "SOURCE_ESTIMATE" | "ASSUMPTION" | "UNKNOWN";
  budget_excess_cents: number | null; summary: string; human_minutes_daily: number;
  market: string; platform: string; fees: string; account_required: boolean;
  evidence: { source_id: string; url: string; quote: string }; risks: string[]; reason_surfaced: string;
  mini_test: { possible: boolean; estimated_cost_cents: number | null; description: string };
  first_question: string; execution_authorized: false; score: number;
}
export function parseOpportunityPhases(candidate: ResearchCandidate, economicsRaw: string, evidenceRaw: string,
  risksRaw: string, sources: readonly ResearchEvidence[], index: number): ResearchOpportunity {
  const a = exactResearch(JSON.parse(economicsRaw), ["summary", "estimated_cost_cents", "cost_basis", "human_minutes_daily", "account_required"]);
  const b = exactResearch(JSON.parse(evidenceRaw), ["market", "platform", "fees", "quote"]);
  const c = exactResearch(JSON.parse(risksRaw), ["risks", "reason_surfaced", "mini_test_possible", "mini_test_cost_cents", "mini_test_description"]);
  const source = sources[researchInteger(candidate.source_index, sources.length - 1)];
  const quote = researchText(b.quote, 180);
  if (quote.length < 16 || !source.text.includes(quote)) throw new Error("Evidence must quote a page actually read");
  if (a.cost_basis !== "SOURCE_ESTIMATE" && a.cost_basis !== "ASSUMPTION" && a.cost_basis !== "UNKNOWN") throw new Error("Invalid cost basis");
  const cost = a.estimated_cost_cents === null ? null : researchInteger(a.estimated_cost_cents, RESEARCH_LIMITS.researchHorizonCents);
  if ((cost === null) !== (a.cost_basis === "UNKNOWN")) throw new Error("Cost uncertainty mismatch");
  if (a.cost_basis === "SOURCE_ESTIMATE") {
    const amounts = [...quote.matchAll(/\b(\d+(?:[.,]\d{1,2})?)\s*(?:EUR|euros?|€)/gi)]
      .map(match => Math.round(Number(match[1].replace(",", ".")) * 100));
    if (!(cost === 0 && /gratuit|free|sans investissement/i.test(quote)) && !amounts.includes(cost!)) throw new Error("Exact cost quotation required");
  }
  if (!Array.isArray(c.risks) || !c.risks.length || c.risks.length > 3) throw new Error("Invalid risks");
  const miniPossible = researchBoolean(c.mini_test_possible);
  const miniCost = c.mini_test_cost_cents === null ? null : researchInteger(c.mini_test_cost_cents, RESEARCH_LIMITS.executionBudgetCents);
  if (miniPossible && miniCost === null || !miniPossible && miniCost !== null) throw new Error("Invalid smaller test");
  const minutes = researchInteger(a.human_minutes_daily, 480);
  const classification = cost === null ? "COST_UNCONFIRMED" : cost > RESEARCH_LIMITS.executionBudgetCents ? "OUT_OF_BUDGET_OPPORTUNITY" : "IN_BUDGET_CANDIDATE";
  return { opportunity_id: `research-opportunity-${index + 1}`, name: researchText(candidate.name, 80), kind: candidate.kind, classification,
    estimated_cost_cents: cost, cost_basis: a.cost_basis, budget_excess_cents: cost === null ? null : Math.max(0, cost - RESEARCH_LIMITS.executionBudgetCents),
    summary: researchText(a.summary), human_minutes_daily: minutes, account_required: researchBoolean(a.account_required),
    market: researchText(b.market), platform: researchText(b.platform), fees: researchText(b.fees),
    evidence: { source_id: source.source_id, url: source.url, quote }, risks: c.risks.map(v => researchText(v, 160)), reason_surfaced: researchText(c.reason_surfaced),
    mini_test: { possible: miniPossible, estimated_cost_cents: miniCost, description: researchText(c.mini_test_description) },
    first_question: "Peut-on tester cette opportunité avec ≤10 EUR avant d’augmenter le capital ?",
    execution_authorized: false,
    // Equal evidence/cost: less supervision ranks first. No prediction of income.
    score: Math.max(0, 80 - Math.min(40, minutes) - (cost === null ? 20 : cost > 1000 ? 10 : 0) - (a.cost_basis === "ASSUMPTION" ? 10 : 0)) };
}
/** Even in-budget research is never an executable plan or approval. */
export function assertResearchExecutable(_candidate: ResearchOpportunity): never { throw new Error("Research grants no execution authority"); }
