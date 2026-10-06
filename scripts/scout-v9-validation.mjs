#!/usr/bin/env node
/** Fictitious Chromebook scenario in a fresh temp directory. No real workspace,
 * model, external action or payment. Uses the same V9 grammar and runtime. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { initializeLedger, parseEconomicLedger } from "../dist/agent/economic-ledger.js";
import { runProjectScout, parseProjectCommand } from "../dist/agent/project-manager.js";
import { projectStoreRoot } from "../dist/agent/project-store.js";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v9-validation-"));
const root = path.join(directory, "workspace"); await fs.mkdir(root, { mode: 0o700 });
await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(initializeLedger(10000)), { mode: 0o600 });
globalThis.fetch = () => { throw new Error("Network forbidden in fictitious V9 validation"); };
const run = async (...args) => {
  process.env.SCOUT_MODE = ["--approve-project", "--deny-project"].includes(args[0]) ? "approval" : "projects";
  return JSON.parse(await runProjectScout({ root, command: parseProjectCommand(args) }));
};
const inspect = async p => (await run("--inspect-project", p.plan.project_id)).projects[0];
const target = p => [p.plan.project_id, "--experiment-id", p.experiment_id];
const batch = (await run("--create-batch")).batch.batch_id;
const create = async name => (await run("--create-project", batch, "--name", name, "--hypothesis", "Validation fictive sans argent réel", "--budget-cents", "1000", "--duration-days", "7")).projects.at(-1);
let a = await create("Projet A fictif"), b = await create("Projet B fictif");
await assert.rejects(() => create("Projet C fictif"), /two projects/);
for (const p of [a, b]) {
  const before = await fs.readFile(path.join(root, "economic-ledger.json"), "utf8");
  await run("--reserve-project", ...target(p), "--preview");
  assert.equal(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8"), before);
  await run("--reserve-project", ...target(p));
}
a = await inspect(a); b = await inspect(b);
let ledger = parseEconomicLedger(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8"));
assert.equal(ledger.available_balance_cents, 8000); assert.equal(ledger.reserved_balance_cents, 2000);
const bBefore = await inspect(b);
await assert.rejects(() => run("--approve-project", ...target(b), "--request-id", a.approval.request.request_id), /Exact pending/);
await run("--approve-project", ...target(a), "--request-id", a.approval.request.request_id);
await run("--start-project", ...target(a), "--request-id", a.approval.request.request_id);
await run("--create-asset", ...target(a)); a = await inspect(a);
const close = ["--close-experiment", ...target(a), "--request-id", a.approval.request.request_id,
  "--expense-cents", "600", "--revenue-cents", "400", "--classification", "inconclusive", "--asset-policy", "keep"];
await run(...close, "--preview"); await run(...close); await assert.rejects(() => run(...close));
a = await inspect(a); const snapshot = JSON.stringify(a.result);
const receipt = `receipt-${randomUUID()}`;
const revenue = ["--record-passive-revenue", ...target(a), "--asset-id", a.asset.asset_id, "--receipt-id", receipt, "--revenue-cents", "1300"];
await run(...revenue, "--preview"); await run(...revenue); await assert.rejects(() => run(...revenue), /Duplicate/);
a = await inspect(a); assert.equal(JSON.stringify(a.result), snapshot); assert.equal(a.metrics.lifetime_net_result_cents, 1100);
assert.deepEqual(await inspect(b), bBefore);
ledger = parseEconomicLedger(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8"));
assert.equal(ledger.available_balance_cents, 10100); assert.equal(ledger.reserved_balance_cents, 1000);
await run("--list-projects"); // Authenticates history and verifies all ledger links.
console.log(JSON.stringify({ result: "PASS", notice: "NO REAL MONEY IS SPENT BY V9", fixture_directory: directory,
  private_history: projectStoreRoot(root), project_a: a.plan.project_id, project_b: b.plan.project_id,
  experiment_result_cents: a.result.experiment_net_result_cents, metrics: a.metrics,
  available_cents: ledger.available_balance_cents, reserved_cents: ledger.reserved_balance_cents }, null, 2));
