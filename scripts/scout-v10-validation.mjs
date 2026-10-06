#!/usr/bin/env node
/** Deterministic fictitious scenario only, always in a new private temp workspace. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeLedger, parseEconomicLedger } from "../dist/agent/economic-ledger.js";
import { runProjectScout, parseProjectCommand } from "../dist/agent/project-manager.js";
import { runMonitoringScout, parseMonitoringCommand } from "../dist/agent/experiment-monitor.js";
import { observationStoreRoot } from "../dist/agent/observation-store.js";
const NativeDate = Date, start = NativeDate.parse("2026-10-06T12:00:00.000Z");
let fixtureNow = start;
// V9 retains its production clock API. This Date substitution is fixture-only;
// V10 uses its explicit trusted-host clock injection. No sleep/timer/scheduler.
class FixtureDate extends NativeDate {
  constructor(...args) { if (args.length) super(...args); else super(fixtureNow); }
  static now() { return fixtureNow; }
}
globalThis.Date = FixtureDate;
globalThis.fetch = () => { throw new Error("Network forbidden in V10 fixture"); };
try {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v10-validation-")), root = path.join(directory, "workspace");
  await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(initializeLedger(10000)), { mode: 0o600 });
  const v9 = async (...args) => {
    process.env.SCOUT_MODE = args[0] === "--approve-project" ? "approval" : "projects";
    return JSON.parse(await runProjectScout({ root, command: parseProjectCommand(args) }));
  };
  const v10 = async (...args) => {
    process.env.SCOUT_MODE = "monitoring";
    return runMonitoringScout({ root, command: parseMonitoringCommand(args), now: () => new NativeDate(fixtureNow).toISOString() });
  };
  const target = p => [p.plan.project_id, "--experiment-id", p.experiment_id];
  const inspect = async p => (await v9("--inspect-project", p.plan.project_id)).projects[0];
  const batchId = (await v9("--create-batch")).batch.batch_id;
  const active = async name => {
    let p = (await v9("--create-project", batchId, "--name", name, "--hypothesis", "Fixture fictive V10", "--budget-cents", "1000", "--duration-days", "7")).projects.at(-1);
    await v9("--reserve-project", ...target(p)); p = await inspect(p);
    await v9("--approve-project", ...target(p), "--request-id", p.approval.request.request_id);
    await v9("--start-project", ...target(p), "--request-id", p.approval.request.request_id); return inspect(p);
  };
  let a = await active("A fictif"), b = await active("B fictif");
  await v9("--create-asset", ...target(a)); a = await inspect(a);
  const ledgerBytes = () => fs.readFile(path.join(root, "economic-ledger.json"), "utf8");
  const beforeSignals = await ledgerBytes(), bOriginal = await inspect(b);
  const metric = (p, type, name, value) => v10("--record-observation", ...target(p), "--type", type, "--metric", name, "--value", String(value));
  for (const p of [a, b]) await v10("--checkpoint", ...target(p), "--checkpoint", "start");
  fixtureNow = start + 86400000;
  await metric(a, "traffic", "views", 20); await metric(a, "inquiry", "inquiries", 2);
  await v10("--checkpoint", ...target(a), "--checkpoint", "day_1");
  await metric(b, "traffic", "views", 9);
  fixtureNow = start + 3 * 86400000;
  await metric(a, "traffic", "views", 45); await metric(a, "inquiry", "inquiries", 4);
  await v10("--checkpoint", ...target(a), "--checkpoint", "day_3");
  const claim = (await v10("--record-observation", ...target(a), "--type", "sale_claim", "--amount-cents", "800")).event;
  assert.equal(await ledgerBytes(), beforeSignals);
  assert.equal(parseEconomicLedger(await ledgerBytes()).total_recorded_revenue_cents, 0);
  assert.equal((await v10("--status", ...target(a))).status.confirmed_financial_data.lifetime_net_result_cents, 0);
  fixtureNow = start + 7 * 86400000;
  const due = await v10("--status", ...target(a)); assert.equal(due.status.temporal_state, "deadline_reached");
  assert(due.status.alerts.includes("PENDING_HUMAN_RESULT")); assert.equal((await inspect(a)).status, "active");
  assert.equal(await ledgerBytes(), beforeSignals);
  // V9 records experiment income at explicit closure using the existing V5/V7
  // financial primitives. V10 must not introduce an earlier financial path.
  await v9("--close-experiment", ...target(a), "--request-id", a.approval.request.request_id,
    "--expense-cents", "0", "--revenue-cents", "800", "--classification", "inconclusive", "--asset-policy", "keep");
  a = await inspect(a);
  const entry = parseEconomicLedger(await ledgerBytes()).entries.find(e => a.result.ledger_entry_ids.includes(e.id) && e.type === "revenue");
  const afterConfirmed = await ledgerBytes();
  const reconcile = ["--reconcile-observation", ...target(a), "--observation-id", claim.event_id, "--ledger-entry-id", entry.id];
  await v10(...reconcile, "--preview"); await v10(...reconcile);
  await assert.rejects(() => v10(...reconcile), /duplicate/);
  assert.equal(await ledgerBytes(), afterConfirmed);
  fixtureNow = start + 8 * 86400000;
  await v10("--asset-observation", ...target(a), "--asset-id", a.asset.asset_id, "--type", "traffic", "--metric", "views", "--value", "60");
  const result = await v10("--status", ...target(a)), other = await v10("--status", ...target(b));
  assert.equal(result.status.temporal_state, "closed"); assert.equal(result.status.asset.status, "passive_monitoring");
  assert(result.status.observed_unconfirmed_signals.claims[0].reconciled);
  assert.deepEqual(result.status.observed_unconfirmed_signals.experiment_metrics, { views: 45, inquiries: 4 });
  assert.equal(other.status.observed_unconfirmed_signals.experiment_metrics.views, 9);
  const { timing: originalTiming, ...originalB } = bOriginal;
  const { timing: finalTiming, ...finalB } = await inspect(b);
  assert.deepEqual(finalB, originalB); assert.equal(finalTiming.activity, "expired");
  assert.equal(await ledgerBytes(), afterConfirmed);
  console.log(JSON.stringify({ result: "PASS", notice: "NO REAL MONEY OR EXTERNAL ACTION IS PERFORMED BY V10",
    fixture_directory: directory, monitoring_history: observationStoreRoot(root), project_a: a.plan.project_id, project_b: b.plan.project_id,
    experiment_metrics: result.status.observed_unconfirmed_signals.experiment_metrics,
    asset_metrics: result.status.observed_unconfirmed_signals.asset_metrics, claim_reconciled: true,
    confirmed_revenue_cents: 800, confirmed_expense_cents: 0, deadline_did_not_auto_close: true }, null, 2));
} finally { globalThis.Date = NativeDate; }
