import * as fs from "node:fs/promises";
import path from "node:path";
import { initializeLedger, reserveExperiment } from "../agent/economic-ledger.js";
import { runApprovalScout } from "../agent/approval-gate.js";
import { runAllocationScout } from "../agent/allocation-runner.js";
import { parseOpportunityPhases } from "../agent/research-model.js";
import { buildAttentionItems, parseToolRequest } from "../agent/tool-discovery.js";
import { runProjectScout, parseProjectCommand } from "../agent/project-manager.js";
import type { ExperimentPlan } from "../agent/experiment-runner.js";
export const TOKEN = "validationOnly_0123456789abcdef0123456789abcdef";
export const write = (root: string, name: string, value: unknown) => fs.writeFile(path.join(root, name), JSON.stringify(value));
export const read = (root: string, name: string) => fs.readFile(path.join(root, name), "utf8");
export async function inMode<T>(mode: string, operation: () => Promise<T>) {
  const before = process.env.SCOUT_MODE; process.env.SCOUT_MODE = mode;
  try { return await operation(); } finally { if (before === undefined) delete process.env.SCOUT_MODE; else process.env.SCOUT_MODE = before; }
}
export async function base(root: string) { await fs.mkdir(root); await write(root, "economic-ledger.json", initializeLedger(10000)); }
export const plan: ExperimentPlan = { version: 4, status: "planned", opportunity_name: "SECRET_FREEFORM_NAME", opportunity_score: 82,
  hypothesis: "Test fictif local", experiment_budget_eur: 0, duration_days: 3, actions: ["SECRET_FREEFORM_ACTION"],
  success_metrics: ["Trois retours"], stop_conditions: ["Après trois jours"], expected_learning: "Demande inconnue",
  requires_real_spending: false, requires_external_account: false, requires_publication: false, requires_human_approval: true };
export async function approvalFixture(root: string, cost = 0) {
  const p = { ...plan, experiment_budget_eur: cost, requires_real_spending: cost > 0 };
  await write(root, "experiment.json", p); await write(root, "economic-ledger.json", reserveExperiment(initializeLedger(10000), p));
  return inMode("approval", () => runApprovalScout({ root }));
}
export async function researchFixture(root: string, tools = false) {
  const specs = [{ name: "A", cost: 1000, minutes: 25 }, { name: "B", cost: 1000, minutes: 30 }, { name: "C", cost: 3500, minutes: 0 }];
  const evidence = specs.map((s, i) => ({ source_id: `research-source-${i + 1}`, url: `https://example.com/${i}`, text: `Coût estimé ${s.cost / 100} EUR, demande inconnue.`, query_id: "research-query-1", round: 1 }));
  const opportunities = specs.map((s, i) => parseOpportunityPhases({ name: s.name, kind: "QUICK_SERVICE", source_index: i },
    JSON.stringify({ summary: "Étude fictive", estimated_cost_cents: s.cost, cost_basis: "SOURCE_ESTIMATE", human_minutes_daily: s.minutes, account_required: false }),
    JSON.stringify({ market: "Marché inconnu", platform: "Plateforme inconnue", fees: "Frais inconnus", quote: evidence[i].text }),
    JSON.stringify({ risks: ["Demande inconnue"], reason_surfaced: "Une proposition informative à évaluer sans aucune exécution autorisée.", mini_test_possible: false, mini_test_cost_cents: null, mini_test_description: "À définir" }), evidence, i));
  const toolRequests = tools ? [parseToolRequest(JSON.stringify({ capability_needed: "pdf_processing", suggested_tool: "Outil fictif", purpose: "Lire", project_relevance: "Document public", required: true, account_required: false, credential_required: false,
    estimated_cost_cents: null, paid_tool: false, data_sent: ["public page text"], risk_level: "medium", expected_benefit: "Comparer" }), 0)] : [];
  const output = { version: "11.1", status: "PASS", reason: "SOURCED_RESEARCH_ONLY_COSTS_AND_REVENUE_UNCONFIRMED", execution_budget_cents: 1000, research_horizon_cents: 10000,
    queries: [], evidence, opportunities, tool_requests: toolRequests, capabilities: [], operator_attention: buildAttentionItems(opportunities, toolRequests, false), metrics: {},
    security: { project_created: false, approval_created: false, external_action_executed: false, money_spent: false, capability_granted: false, installation_performed: false } };
  await write(root, "research.json", output); return output;
}
export async function allocationFixture(root: string) { await researchFixture(root); return inMode("allocation", () => runAllocationScout({ root, command: { kind: "calculate", input: "research.json" } })); }
export async function projectCommand(root: string, ...args: string[]) {
  return inMode(args[0].includes("approve") || args[0].includes("deny") ? "approval" : "projects", async () => JSON.parse(await runProjectScout({ root, command: parseProjectCommand(args) })));
}
export async function projectFixture(root: string) {
  const b = (await projectCommand(root, "--create-batch")).batch.batch_id;
  let p = (await projectCommand(root, "--create-project", b, "--name", "SECRET_PROJECT_NAME", "--hypothesis", "Test", "--budget-cents", "1000", "--duration-days", "7")).projects[0];
  p = (await projectCommand(root, "--reserve-project", p.plan.project_id, "--experiment-id", p.experiment_id)).projects[0]; return p;
}
