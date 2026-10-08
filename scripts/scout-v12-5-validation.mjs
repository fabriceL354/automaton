/** Offline compiled-runtime smoke test. Synthetic workspace and operator token. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { initializeLedger } from "../dist/agent/economic-ledger.js";
import { runAllocationScout } from "../dist/agent/allocation-runner.js";
import { runApprovalScout, readVerifiedApprovalRecords } from "../dist/agent/approval-gate.js";
import { parseOpportunityPhases } from "../dist/agent/research-model.js";
import { buildAttentionItems } from "../dist/agent/tool-discovery.js";
import { startControlApi } from "../dist/agent/control-api.js";
import { locked } from "../dist/agent/ledger-runner.js";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v12-5-validation-"));
const root = path.join(temp, "workspace"), previousMode = process.env.SCOUT_MODE;
const token = randomBytes(32).toString("hex");
let api, outgoingAttempts = 0;
const restore = [];
function replace(obj, key, value) { const previous = obj[key]; obj[key] = value; restore.push(() => { obj[key] = previous; }); }
const forbidden = () => { outgoingAttempts++; throw new Error("Validation forbids network/Ollama outside its exact API listener"); };
replace(globalThis, "fetch", forbidden);
for (const key of ["request", "get"]) replace(https, key, forbidden);
for (const obj of [dns, dnsPromises]) for (const key of Object.keys(obj)) if (key === "lookup" || key.startsWith("resolve") || key === "reverse") {
  const original = obj[key];
  // Node invokes lookup even for a literal bind; the literal takes no DNS path.
  replace(obj, key, key === "lookup" ? function (host, ...args) {
    if (host !== "127.0.0.1") return forbidden();
    return original.call(this, host, ...args);
  } : forbidden);
}
const socketConnect = net.Socket.prototype.connect;
replace(net.Socket.prototype, "connect", function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const target = typeof first === "object" ? first : { port: first, host: normalized[1] };
  if (!api || target.path || target.host !== "127.0.0.1" || Number(target.port) !== api.port) return forbidden();
  return socketConnect.apply(this, args);
});
syncBuiltinESMExports();
const write = (name, value) => fs.writeFile(path.join(root, name), JSON.stringify(value));
const read = name => fs.readFile(path.join(root, name), "utf8");
const request = (route, decision = false, authenticated = true) => new Promise((resolve, reject) => {
  const req = http.request(api.url + route, { agent: false, method: decision ? "POST" : "GET",
    headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), ...(decision ? { "Content-Type": "application/json" } : {}) } }, response => {
    let raw = ""; response.setEncoding("utf8"); response.on("data", s => { raw += s; });
    response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(raw) }));
  }); req.on("error", reject); req.end(decision ? "{}" : undefined);
});
try {
  await fs.mkdir(root); await write("economic-ledger.json", initializeLedger(10000));
  // A zero-cost V6 approval fixture: authorization only, no reservation.
  await write("experiment.json", { version: 4, status: "planned", opportunity_name: "Validation fictive", opportunity_score: 82,
    hypothesis: "Mesurer un intérêt fictif", experiment_budget_eur: 0, duration_days: 3,
    actions: ["Préparer un prototype fictif"], success_metrics: ["Trois réponses fictives"], stop_conditions: ["Trois jours"],
    expected_learning: "Demande inconnue", requires_real_spending: false, requires_external_account: false,
    requires_publication: false, requires_human_approval: true });
  process.env.SCOUT_MODE = "approval"; const approval = await runApprovalScout({ root });
  const specs = [{ name: "Test A", cost: 1000, minutes: 25 }, { name: "Test B", cost: 1000, minutes: 30 }, { name: "Test C", cost: 3500, minutes: 0 }];
  const evidence = specs.map((s, i) => ({ source_id: `research-source-${i + 1}`, url: `https://example.com/${i}`,
    text: `Coût estimé ${s.cost / 100} EUR. Aucun revenu garanti.`, query_id: "research-query-1", round: 1 }));
  const opportunities = specs.map((s, i) => parseOpportunityPhases({ name: s.name, kind: "QUICK_SERVICE", source_index: i },
    JSON.stringify({ summary: "Test synthétique local", estimated_cost_cents: s.cost, cost_basis: "SOURCE_ESTIMATE", human_minutes_daily: s.minutes, account_required: false }),
    JSON.stringify({ market: "Marché inconnu", platform: "Distribution inconnue", fees: "Frais inconnus", quote: evidence[i].text }),
    JSON.stringify({ risks: ["Demande inconnue"], reason_surfaced: "Une piste à examiner manuellement, sans aucune action ni dépense automatique.", mini_test_possible: false, mini_test_cost_cents: null, mini_test_description: "À définir" }), evidence, i));
  await write("research.json", { version: "11.1", status: "PASS", reason: "SOURCED_RESEARCH_ONLY_COSTS_AND_REVENUE_UNCONFIRMED", execution_budget_cents: 1000, research_horizon_cents: 10000,
    queries: [], evidence, opportunities, tool_requests: [], capabilities: [], operator_attention: buildAttentionItems(opportunities, [], false), metrics: {},
    security: { project_created: false, approval_created: false, external_action_executed: false, money_spent: false, capability_granted: false, installation_performed: false } });
  process.env.SCOUT_MODE = "allocation"; await runAllocationScout({ root, command: { kind: "calculate", input: "research.json" } });
  const ledgerBefore = await read("economic-ledger.json"), allocationBefore = await read("capital-allocation.json");
  process.env.SCOUT_MODE = "control-api";
  api = await startControlApi({ root, env: { SCOUT_CONTROL_API_HOST: "127.0.0.1", SCOUT_CONTROL_API_PORT: "0", SCOUT_CONTROL_API_TOKEN: token } });
  assert.equal(api.host, "127.0.0.1");
  assert.equal((await request("/v1/health", false, false)).status, 200);
  const summary = await request("/v1/summary"); assert.equal(summary.status, 200); assert.equal(summary.body.confirmed_available_cents, 10000);
  assert.equal(summary.body.reserved_cents, 0); assert.equal(summary.body.confirmed_spent_cents, 0);
  const allocation = await request("/v1/allocation"); assert.equal(allocation.status, 200);
  assert.equal(allocation.body.allocation.status, "PROPOSAL_ONLY"); assert.equal(allocation.body.allocation.total_proposed_cents, 2000);
  assert.equal(allocation.body.allocation.notice, "NO REAL MONEY WAS SPENT BY V12");
  const attention = await request("/v1/attention"); assert.equal(attention.status, 200);
  assert(attention.body.items.some(e => e.event_type === "OUT_OF_BUDGET_OPPORTUNITY"));
  const first = await request("/v1/events?after=0&limit=1"); assert.equal(first.status, 200); assert.equal(first.body.items.length, 1);
  const rest = await request(`/v1/events?after=${first.body.next_after}&limit=100`); assert.equal(rest.status, 200);
  assert(rest.body.items.every(e => e.sequence > first.body.next_after));
  const events = [...first.body.items, ...rest.body.items]; assert(events.some(e => e.event_type === "APPROVAL_REQUIRED"));
  assert(events.some(e => e.event_type === "OUT_OF_BUDGET_OPPORTUNITY"));
  const route = `/v1/approvals/${approval.request_id}/approve`;
  assert.equal((await request(route, true, false)).status, 401);
  assert.equal((await request(route, true)).status, 200); assert.equal((await request(route, true)).status, 200);
  assert.equal((await locked(root, () => readVerifiedApprovalRecords(root))).at(-1).request.status, "approved");
  assert.equal(await read("economic-ledger.json"), ledgerBefore); assert.equal(await read("capital-allocation.json"), allocationBefore);
  const beforeRestart = await request("/v1/events"); await api.close();
  api = await startControlApi({ root, env: { SCOUT_CONTROL_API_PORT: "0", SCOUT_CONTROL_API_TOKEN: token } });
  assert.deepEqual(await request("/v1/events"), beforeRestart); await api.close();
  assert.equal(outgoingAttempts, 0);
  console.log("V12.5 PASS: local control API and event layer validated; zero spend; zero external network; zero Ollama.");
} finally {
  await api?.close(); for (const undo of restore.reverse()) undo(); syncBuiltinESMExports();
  if (previousMode === undefined) delete process.env.SCOUT_MODE; else process.env.SCOUT_MODE = previousMode;
  await fs.rm(temp, { recursive: true, force: true });
}
