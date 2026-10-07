#!/usr/bin/env node
/** Default: completely offline fixture. Real Brave ONLY with explicit --brave. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { controlledResearch, localResearchModel, researchReport } from "../dist/agent/research-controller.js";
import { RESEARCH_LIMITS, PUBLIC_RESEARCH_MISSION } from "../dist/agent/research-model.js";
import { SafeWebClient, BRAVE_ENDPOINT } from "../dist/scout-web/network.js";
import { BraveSearchProvider, configuredSearchProvider } from "../dist/scout-web/search.js";
import { CAPABILITY_REGISTRY } from "../dist/agent/capability-registry.js";
import { loadLocalScoutConfig } from "../dist/agent/local-runner.js";

const args = process.argv.slice(2), live = args.length === 1 && args[0] === "--brave";
if (args.length && !live) { console.error("Use no arguments for offline fixtures, or exactly --brave for an operator-run real test."); process.exitCode = 2; }
else {
  const originalFetch = globalThis.fetch, events = [], modelPrompts = [], networkCalls = [];
  const key = "fixture-only-Brave-key-1122334455", quoteA = "Un test de correction peut être gratuit sans investissement.", quoteB = "Le coût de création du template est estimé à 25 EUR.";
  const pages = [
    `En France, une micro-prestation de correction de textes peut être testée par une seule personne. ${quoteA} La demande et les frais restent à vérifier. Distribution directe et compte éventuellement requis.`,
    `Une page business sous 1000 EUR peut évoquer un template de tableur numérique. ${quoteB} Un mini-test gratuit peut vérifier l'intérêt avant la création. Distribution, frais et ventes restent incertains.`,
  ];
  const response = (body, headers) => ({ status: 200, headers, body: (async function* () { yield Buffer.from(body); })(), close() {} });
  const mockTransport = {
    async resolve() { return [{ address: "93.184.216.34", family: 4 }]; },
    async getBrave(url, _pin, _signal, runtimeKey) {
      assert.equal(runtimeKey, key); assert.equal(url.origin + url.pathname, BRAVE_ENDPOINT);
      networkCalls.push({ type: "fixture_search", url: url.href });
      return response(JSON.stringify({ web: { results: pages.map((_, i) => ({ title: `Public source ${i}`, url: `https://example.com/${i}`, description: "Public fixture" })) } }), { "content-type": "application/json" });
    },
    async get(url, ...rest) {
      assert.equal(rest.length, 2); networkCalls.push({ type: "fixture_page", url: url.href });
      return response(gzipSync(Buffer.from(`<p>${pages[Number(url.pathname.slice(1))]}</p>`)), { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
    },
  };
  const mockModel = { async ask(phase, data) {
    assert(!data.includes(key)); modelPrompts.push(data);
    if (phase === "query_proposal") {
      const round = Number(data.match(/Round (\d)/)?.[1]);
      return JSON.stringify({ intents: ["micro_service", "digital_template"].map(family => ({ family, focus: round === 1 ? "explore" : round === 2 ? "market" : "cost", evidence_index: round === 1 ? null : 0 })) });
    }
    if (phase === "candidates") return JSON.stringify({ candidates: [{ name: "Correction", kind: "QUICK_SERVICE", source_index: 0 }, { name: "Template", kind: "DURABLE_ASSET", source_index: 1 }] });
    const asset = data.includes('"name":"Template"');
    if (phase === "economics") return JSON.stringify({ summary: asset ? "Créer un actif réutilisable après validation" : "Tester une prestation de correction", estimated_cost_cents: asset ? 2500 : 0, cost_basis: "SOURCE_ESTIMATE", human_minutes_daily: asset ? 5 : 12, account_required: true });
    if (phase === "evidence") return JSON.stringify({ market: "Demande à vérifier", platform: "Distribution directe", fees: "Frais non confirmés", quote: asset ? quoteB : quoteA });
    if (phase === "risks") return JSON.stringify({ risks: ["Demande non validée"], reason_surfaced: "Un actif réutilisable peut réduire la supervision après un petit test gratuit auprès de clients potentiels.", mini_test_possible: true, mini_test_cost_cents: 0, mini_test_description: "Interroger trois personnes sans dépenser" });
    if (phase === "tool_selection") return '{"capabilities":["trend_analysis"]}';
    if (phase === "tool_request") return JSON.stringify({ capability_needed: "trend_analysis", suggested_tool: "Outil de tendances à évaluer", purpose: "Comparer des mots clés publics", project_relevance: "Vérifier la demande du template", required: false, account_required: false, credential_required: false, estimated_cost_cents: null, paid_tool: false, data_sent: ["public keywords"], risk_level: "medium", expected_benefit: "Choisir une niche plus pertinente" });
    throw new Error("Unexpected fixture phase");
  } };
  let directory;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), "scout-v11-1-validation-"));
    const root = path.join(directory, "workspace"); await mkdir(root, { mode: 0o700 });
    const names = ["economic-ledger.json", "approval-state.json", "project-state.json", "monitoring-private.mac", "learning-state.json", "MISSION.txt"];
    const before = new Map(names.map(name => [name, `PRIVATE_STATE_FIXTURE_${name}`]));
    for (const [name, text] of before) await writeFile(path.join(root, name), text, { mode: 0o600 });
    const registryBefore = JSON.stringify(CAPABILITY_REGISTRY);
    if (!live) globalThis.fetch = () => { throw new Error("Offline validation forbids real network/Ollama"); };
    else if (process.env.SCOUT_SEARCH_PROVIDER !== "brave" || !process.env.BRAVE_SEARCH_API_KEY) throw new Error("Explicit Brave configuration required");
    const config = live ? await loadLocalScoutConfig() : undefined;
    const output = await controlledResearch({ mission: PUBLIC_RESEARCH_MISSION,
      model: live ? localResearchModel(config.baseUrl, config.model) : mockModel,
      provider: live ? configuredSearchProvider() : new BraveSearchProvider(key),
      ...live ? {} : { client: new SafeWebClient(mockTransport, { bytes: RESEARCH_LIMITS.totalCompressedBytes, responseBytes: RESEARCH_LIMITS.responseBytes }) },
      onEvent: message => events.push(message) });
    const report = researchReport(output), structured = JSON.stringify(output, null, 2) + "\n";
    assert(!structured.includes(key)); assert(!report.includes(key)); assert(!events.join("\n").includes(key));
    assert(!modelPrompts.join("\n").includes("PRIVATE_STATE_FIXTURE_"));
    assert.equal(JSON.stringify(CAPABILITY_REGISTRY), registryBefore);
    assert(Object.values(output.security).every(v => v === false));
    assert(output.metrics.queries <= 6 && output.metrics.pages <= 10 && output.metrics.rounds <= 3 && output.metrics.model_calls <= 20);
    if (!live) {
      assert.equal(output.status, "PASS"); assert.equal(output.metrics.queries, 6); assert.equal(output.metrics.gzip_reads, 2);
      assert.equal(output.opportunities.length, 2); assert.equal(output.tool_requests.length, 1);
      const over = output.opportunities.find(o => o.classification === "OUT_OF_BUDGET_OPPORTUNITY");
      assert.equal(over.estimated_cost_cents, 2500); assert.equal(over.budget_excess_cents, 1500); assert.equal(over.mini_test.estimated_cost_cents, 0);
      assert.equal(networkCalls.length, 8); // All eight are local mock functions.
    }
    await writeFile(path.join(root, "research.json"), structured, { mode: 0o600 });
    await writeFile(path.join(root, "rapport.txt"), report, { mode: 0o600 });
    assert.equal(await readFile(path.join(root, "research.json"), "utf8"), structured);
    assert.equal(await readFile(path.join(root, "rapport.txt"), "utf8"), report);
    for (const [name, text] of before) assert.equal(await readFile(path.join(root, name), "utf8"), text);
    assert.deepEqual((await readdir(root)).sort(), [...names, "research.json", "rapport.txt"].sort());
    const pass = output.status === "PASS";
    console.log(JSON.stringify({ result: pass ? "PASS" : "BLOCKED", research_status: output.status, mode: live ? "OPERATOR_REAL_BRAVE" : "OFFLINE_FIXTURE",
      reason: output.reason, fixture_directory: directory, metrics: output.metrics, opportunities: output.opportunities.length,
      tool_requests: output.tool_requests.length, private_state_unchanged: true, registry_unchanged: true,
      gzip_real_observed: live ? output.metrics.gzip_reads > 0 : null, security: output.security }, null, 2));
    if (!pass) process.exitCode = 2;
  } catch {
    console.log(JSON.stringify({ result: "BLOCKED", mode: live ? "OPERATOR_REAL_BRAVE" : "OFFLINE_FIXTURE", reason: "CONFIGURATION_PROVIDER_MODEL_OR_VALIDATION_FAILED", fixture_directory: directory ?? null }));
    process.exitCode = 2;
  } finally { globalThis.fetch = originalFetch; }
}
