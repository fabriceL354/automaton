/** Informative missing-capability requests. No imports of grants/installers/actions. */
import { capability, RISK_CLASSES } from "./capability-registry.js";
import { exactResearch, researchBoolean, researchInteger, researchText, RESEARCH_LIMITS, type ResearchOpportunity } from "./research-model.js";
export interface ToolRequest {
  tool_request_id: string; capability_needed: string; suggested_tool: string; purpose: string; project_relevance: string;
  required: boolean; account_required: boolean; credential_required: boolean; estimated_cost_cents: number | null;
  paid_tool: boolean; data_sent: string[]; risk_level: "low" | "medium" | "high"; expected_benefit: string;
  current_capability_available: false; capability_granted: false; approval_created: false;
}
export function parseToolRequest(raw: string, index: number): ToolRequest {
  const d = exactResearch(JSON.parse(raw), ["capability_needed", "suggested_tool", "purpose", "project_relevance", "required", "account_required",
    "credential_required", "estimated_cost_cents", "paid_tool", "data_sent", "risk_level", "expected_benefit"]);
  const cap = typeof d.capability_needed === "string" ? capability(d.capability_needed) : undefined;
  if (!cap || cap.status !== "PROPOSABLE" || cap.risk_class === "forbidden") throw new Error("Capability cannot be proposed");
  if (!RISK_CLASSES.includes(d.risk_level as any) || d.risk_level === "forbidden") throw new Error("Invalid tool risk");
  const risk = d.risk_level as ToolRequest["risk_level"];
  if (RISK_CLASSES.indexOf(risk) < RISK_CLASSES.indexOf(cap.risk_class)) throw new Error("Tool risk understated");
  const account = researchBoolean(d.account_required), credential = researchBoolean(d.credential_required), paid = researchBoolean(d.paid_tool);
  const cost = d.estimated_cost_cents === null ? null : researchInteger(d.estimated_cost_cents, RESEARCH_LIMITS.researchHorizonCents);
  if (credential && !account || cost !== null && cost > 0 && !paid || paid && cost === 0) throw new Error("Inconsistent tool cost/account flags");
  if (!Array.isArray(d.data_sent) || d.data_sent.length > 3) throw new Error("Invalid public data declaration");
  const data = d.data_sent.map(x => researchText(x, 100));
  if (data.some(x => !["public keywords", "public page text", "public project description", "no data"].includes(x))) throw new Error("Only public data categories can be proposed");
  return { tool_request_id: `research-tool-${researchInteger(index, RESEARCH_LIMITS.toolRequests - 1) + 1}`,
    capability_needed: cap.capability_id, suggested_tool: researchText(d.suggested_tool, 80), purpose: researchText(d.purpose), project_relevance: researchText(d.project_relevance),
    required: researchBoolean(d.required), account_required: account, credential_required: credential, estimated_cost_cents: cost, paid_tool: paid,
    data_sent: data, risk_level: risk, expected_benefit: researchText(d.expected_benefit), current_capability_available: false, capability_granted: false, approval_created: false };
}
export const ATTENTION_CATEGORIES = Object.freeze(["INFO", "APPROVAL_REQUIRED", "HUMAN_INTERVENTION_REQUIRED", "OUT_OF_BUDGET_OPPORTUNITY", "TOOL_REQUEST"] as const);
export interface OperatorAttentionItem {
  attention_id: string; category: typeof ATTENTION_CATEGORIES[number]; reference_id: string; message: string;
  actionable: boolean; blocks_research: boolean; aggregated: boolean; capability_granted: false; approval_created: false;
}
/** Future display data only; never imports or calls the V6 approval engine. */
export function attentionItem(category: OperatorAttentionItem["category"], reference: string, message: string, actionable = false): OperatorAttentionItem {
  if (!ATTENTION_CATEGORIES.includes(category)) throw new Error("Unknown attention category");
  return { attention_id: `research-attention-${category.toLowerCase()}`, category, reference_id: researchText(reference, 100), message: researchText(message),
    actionable: researchBoolean(actionable), blocks_research: category === "HUMAN_INTERVENTION_REQUIRED" && actionable,
    aggregated: !actionable, capability_granted: false, approval_created: false };
}
export function buildAttentionItems(opportunities: readonly ResearchOpportunity[], tools: readonly ToolRequest[], blocked: boolean): OperatorAttentionItem[] {
  const items: OperatorAttentionItem[] = [];
  if (blocked) items.push(attentionItem("HUMAN_INTERVENTION_REQUIRED", "research-provider", "Recherche bloquée : vérifier le provider explicitement choisi ou sa configuration locale.", true));
  const noteworthy = opportunities.find(o => o.classification === "OUT_OF_BUDGET_OPPORTUNITY" && o.score >= 50 && o.reason_surfaced.length >= 40);
  if (noteworthy) items.push(attentionItem("OUT_OF_BUDGET_OPPORTUNITY", noteworthy.opportunity_id, noteworthy.first_question));
  const missing = tools.find(t => t.required);
  if (missing && items.length < 2) items.push(attentionItem("TOOL_REQUEST", missing.tool_request_id, "Capacité utile manquante : " + missing.capability_needed + ". Proposition à examiner avant tout futur projet."));
  // Ordinary candidates and optional tools stay in the report; no simulated push.
  return items.slice(0, 2);
}
