/** Offline V12 smoke validation against the compiled runtime. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeLedger } from "../dist/agent/economic-ledger.js";
import { parseOpportunityPhases } from "../dist/agent/research-model.js";
import { runAllocationScout } from "../dist/agent/allocation-runner.js";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v12-validation-"));
const root = path.join(temp, "workspace"), previousMode = process.env.SCOUT_MODE;
const previousFetch = globalThis.fetch;
try {
  await fs.mkdir(root); process.env.SCOUT_MODE = "allocation";
  globalThis.fetch = () => { throw new Error("Network forbidden during allocation validation"); };
  const ledger = JSON.stringify(initializeLedger(10000));
  await fs.writeFile(path.join(root, "economic-ledger.json"), ledger);
  const specs = [{ name: "Test A", cost: 1000, minutes: 25 }, { name: "Test B", cost: 1000, minutes: 30 }, { name: "Test remarquable", cost: 3500, minutes: 0 }];
  const evidence = specs.map((s, i) => ({ source_id: `research-source-${i + 1}`, url: `https://example.com/${i}`,
    text: `Le coût de création est estimé à ${s.cost / 100} EUR. Aucun revenu garanti.`, query_id: "research-query-1", round: 1 }));
  const opportunities = specs.map((s, i) => parseOpportunityPhases({ name: s.name, kind: i === 1 ? "DURABLE_ASSET" : "QUICK_SERVICE", source_index: i },
    JSON.stringify({ summary: "Test synthétique pour validation locale", estimated_cost_cents: s.cost, cost_basis: "SOURCE_ESTIMATE", human_minutes_daily: s.minutes, account_required: false }),
    JSON.stringify({ market: "Marché inconnu", platform: "Distribution inconnue", fees: "Frais inconnus", quote: evidence[i].text }),
    JSON.stringify({ risks: ["Demande incertaine"], reason_surfaced: "Score déterministe favorable mais validation humaine indispensable.", mini_test_possible: false, mini_test_cost_cents: null, mini_test_description: "Mini-test à définir" }), evidence, i));
  await fs.writeFile(path.join(root, "research.json"), JSON.stringify({ version: "11.1", status: "PASS", reason: "SOURCED_RESEARCH_ONLY_COSTS_AND_REVENUE_UNCONFIRMED", execution_budget_cents: 1000, research_horizon_cents: 10000,
    queries: [], evidence, opportunities, tool_requests: [], capabilities: [], operator_attention: [], metrics: {},
    security: { project_created: false, approval_created: false, external_action_executed: false, money_spent: false, capability_granted: false, installation_performed: false } }));
  const command = { kind: "calculate", input: "research.json" };
  const first = await runAllocationScout({ root, command });
  assert.equal(first.proposal.total_proposed_cents, 2000); assert.equal(first.proposal.actually_spent_by_v12_cents, 0);
  assert.equal(first.proposal.status, "PROPOSAL_ONLY"); assert.equal(first.new_attention_items.length, 1);
  assert.equal(first.new_attention_items[0].category, "OUT_OF_BUDGET_OPPORTUNITY");
  const second = await runAllocationScout({ root, command }); assert.deepEqual(second.proposal, first.proposal); assert.equal(second.new_attention_items.length, 0);
  assert.equal((await runAllocationScout({ root, command: { kind: "inspect" } })).stale, false);
  assert.equal(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8"), ledger);
  assert.deepEqual((await fs.readdir(root)).sort(), ["capital-allocation.json", "economic-ledger.json", "research.json"]);
  console.log("V12 PASS: 100 EUR confirmed, 20 EUR proposed, zero spend/reservation/approval; one deduplicated non-blocking 35 EUR alert.");
} finally {
  globalThis.fetch = previousFetch;
  if (previousMode === undefined) delete process.env.SCOUT_MODE; else process.env.SCOUT_MODE = previousMode;
  await fs.rm(temp, { recursive: true, force: true });
}
