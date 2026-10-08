/** Fixed offline research replay; all costs are unconfirmed source estimates. */
import { parseOpportunityPhases } from "./research-model.js";
import { buildAttentionItems } from "./tool-discovery.js";
import { researchCandidates } from "./allocation-sources.js";
export function pilotResearchFixture() {
  const specs = [{ name: "A", cost: 1000, minutes: 25 }, { name: "B", cost: 1000, minutes: 30 }, { name: "C", cost: 3500, minutes: 0 }];
  const evidence = specs.map((s, i) => ({ source_id: `research-source-${i + 1}`, url: `https://example.com/${i}`, text: `Coût estimé ${s.cost / 100} EUR, demande inconnue.`, query_id: "research-query-1", round: 1 }));
  const opportunities = specs.map((s, i) => parseOpportunityPhases({ name: s.name, kind: i === 1 ? "DURABLE_ASSET" : "QUICK_SERVICE", source_index: i },
    JSON.stringify({ summary: "Étude fictive", estimated_cost_cents: s.cost, cost_basis: "SOURCE_ESTIMATE", human_minutes_daily: s.minutes, account_required: false }),
    JSON.stringify({ market: "Marché inconnu", platform: "Plateforme inconnue", fees: "Frais inconnus", quote: evidence[i].text }),
    JSON.stringify({ risks: ["Demande inconnue"], reason_surfaced: "Une proposition informative à évaluer sans aucune exécution autorisée.", mini_test_possible: false, mini_test_cost_cents: null, mini_test_description: "À définir" }), evidence, i));
  const result = { version: "11.1", status: "PASS", reason: "SOURCED_RESEARCH_ONLY_COSTS_AND_REVENUE_UNCONFIRMED", execution_budget_cents: 1000, research_horizon_cents: 10000,
    queries: [], evidence, opportunities, tool_requests: [], capabilities: [], operator_attention: buildAttentionItems(opportunities, [], false), metrics: {},
    security: { project_created: false, approval_created: false, external_action_executed: false, money_spent: false, capability_granted: false, installation_performed: false } };
  researchCandidates(JSON.stringify(result)); return result;
}
