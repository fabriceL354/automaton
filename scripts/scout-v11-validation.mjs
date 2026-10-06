#!/usr/bin/env node
/** Fictitious local accounting only. Always a new isolated temp workspace. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { initializeLedger, parseEconomicLedger } from "../dist/agent/economic-ledger.js";
import { runProjectScout, parseProjectCommand } from "../dist/agent/project-manager.js";
import { runMonitoringScout, parseMonitoringCommand } from "../dist/agent/experiment-monitor.js";
import { runLearningScout, parseLearningCommand } from "../dist/agent/economic-learning.js";
const NativeDate = Date, originalFetch = globalThis.fetch, previousMode = process.env.SCOUT_MODE;
const start = NativeDate.parse("2026-10-06T12:00:00.000Z"); let fixtureNow = start;
class FixtureDate extends NativeDate {
  constructor(...args) { if (args.length) super(...args); else super(fixtureNow); }
  static now() { return fixtureNow; }
}
globalThis.Date = FixtureDate;
globalThis.fetch = () => { throw new Error("No network/Ollama in V11 fixture"); };
try {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v11-validation-")), root = path.join(directory, "workspace");
  await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(initializeLedger(10000)), { mode: 0o600 });
  const v9 = async (...args) => {
    process.env.SCOUT_MODE = args[0] === "--approve-project" ? "approval" : "projects";
    return JSON.parse(await runProjectScout({ root, command: parseProjectCommand(args) }));
  };
  const v10 = async (...args) => { process.env.SCOUT_MODE = "monitoring"; return runMonitoringScout({ root, command: parseMonitoringCommand(args) }); };
  const v11 = async (...args) => { process.env.SCOUT_MODE = "learning"; return runLearningScout({ root, command: parseLearningCommand(args) }); };
  const target = p => [p.plan.project_id, "--experiment-id", p.experiment_id];
  const inspect = async p => (await v9("--inspect-project", p.plan.project_id)).projects[0];
  const batchId = (await v9("--create-batch")).batch.batch_id;
  const active = async name => {
    let p = (await v9("--create-project", batchId, "--name", name, "--hypothesis", "Tester une rentabilité fictive sous sept jours", "--budget-cents", "1000", "--duration-days", "7")).projects.at(-1);
    await v9("--reserve-project", ...target(p)); p = await inspect(p);
    await v9("--approve-project", ...target(p), "--request-id", p.approval.request.request_id);
    await v9("--start-project", ...target(p), "--request-id", p.approval.request.request_id); return inspect(p);
  };
  let a = await active("A fictif"), b = await active("B fictif");
  await v9("--create-asset", ...target(a)); a = await inspect(a);
  fixtureNow = start + 3 * 86400000;
  for (const [p, views, inquiries] of [[a,45,4],[b,20,2]]) {
    await v10("--record-observation", ...target(p), "--type", "traffic", "--metric", "views", "--value", String(views));
    await v10("--record-observation", ...target(p), "--type", "inquiry", "--metric", "inquiries", "--value", String(inquiries));
  }
  const claim = (await v10("--record-observation", ...target(a), "--type", "sale_claim", "--amount-cents", "400")).event;
  await v10("--record-observation", ...target(b), "--type", "sale_claim", "--amount-cents", "99999");
  fixtureNow = start + 7 * 86400000;
  for (const [p, expense, revenue, policy] of [[a,600,400,"keep"],[b,500,900,"retire"]]) {
    await v9("--close-experiment", ...target(p), "--request-id", p.approval.request.request_id,
      "--expense-cents", String(expense), "--revenue-cents", String(revenue), "--classification", expense > revenue ? "failed" : "successful", "--asset-policy", policy);
  }
  a = await inspect(a); b = await inspect(b);
  const ledger = parseEconomicLedger(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8"));
  const entry = ledger.entries.find(e => a.result.ledger_entry_ids.includes(e.id) && e.type === "revenue");
  await v10("--reconcile-observation", ...target(a), "--observation-id", claim.event_id, "--ledger-entry-id", entry.id);
  const atDeadline = (await v11("--analyze-project", ...target(a))).evidence[0];
  assert.equal(atDeadline.derived_metrics.deadline_net_cents, -200); assert.equal(atDeadline.derived_metrics.lifetime_net_cents, -200);
  const hypothesisId = `hypothesis-${randomUUID()}`;
  await v11("--create-hypothesis", hypothesisId, "--batch-id", batchId, "--statement", "Un niveau plus élevé d'inquiries peut être associé à une meilleure performance lifetime.", "--rule", "inquiries_lifetime", "--min-inquiries", "3");
  fixtureNow = start + 30 * 86400000;
  await v9("--record-passive-revenue", ...target(a), "--asset-id", a.asset.asset_id, "--receipt-id", `receipt-${randomUUID()}`, "--revenue-cents", "1300");
  const before = await Promise.all((await fs.readdir(root)).filter(n => !n.startsWith("learning-")).sort().map(async n => [n, await fs.readFile(path.join(root,n), "utf8")]));
  await v11("--refresh-hypothesis", hypothesisId);
  const output = await v11("--analyze-batch", batchId), comparison = await v11("--compare", a.plan.project_id, b.plan.project_id);
  const [ea, eb] = output.evidence;
  assert.equal(ea.facts.experiment_expense_cents, 600); assert.equal(ea.facts.experiment_revenue_cents, 400);
  assert.equal(ea.derived_metrics.deadline_net_cents, -200); assert.equal(ea.facts.post_experiment_revenue_cents, 1300);
  assert.equal(ea.derived_metrics.lifetime_revenue_cents, 1700); assert.equal(ea.derived_metrics.lifetime_net_cents, 1100);
  assert.equal(eb.derived_metrics.deadline_net_cents, 400); assert.equal(eb.derived_metrics.lifetime_net_cents, 400);
  assert.equal(output.confidence, "very_low"); assert.equal(comparison.comparison.winner, null);
  assert.equal(output.hypotheses[0].status, "mixed"); assert.equal(output.hypotheses[0].confidence, "very_low");
  assert(output.hypotheses[0].evidence_for.length && output.hypotheses[0].evidence_against.length);
  assert.equal(output.action_authorized, false);
  assert.deepEqual(await Promise.all(before.map(async ([n]) => [n, await fs.readFile(path.join(root,n), "utf8")])), before);
  console.log(JSON.stringify({ result: "PASS", notice: output.notice, fixture_directory: directory,
    project_a: { experiment_net_cents: -200, post_experiment_revenue_cents: 1300, lifetime_revenue_cents: 1700, lifetime_net_cents: 1100 },
    project_b: { experiment_net_cents: 400, lifetime_net_cents: 400 }, confidence: output.confidence, hypothesis_status: output.hypotheses[0].status,
    contradictory_evidence_preserved: true, winner: comparison.comparison.winner, action_authorized: false, source_files_unchanged_by_V11: true }, null, 2));
} finally {
  globalThis.Date = NativeDate; globalThis.fetch = originalFetch;
  if (previousMode === undefined) delete process.env.SCOUT_MODE; else process.env.SCOUT_MODE = previousMode;
}
