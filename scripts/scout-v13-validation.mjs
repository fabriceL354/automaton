import "./scout-offline-test-guard.mjs";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createPlanningExample } from "./scout-v13-example.mjs";
import { runOperationalPlanning, stopOperationalPlanning } from "../dist/agent/operational-planning.js";
import { preparationStoreRoot } from "../dist/agent/pilot-preparation-store.js";
import { validateOperationalPlan } from "../dist/agent/operational-planning-model.js";
import { workspaceFingerprint } from "../dist/agent/pilot-workspace-proof.js";
import { scoutWorkspaceRoot } from "../dist/agent/local-tools.js";
const normal = scoutWorkspaceRoot(), before = await workspaceFingerprint(normal), old = process.env.SCOUT_MODE, nativeFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error("V13 permits no fetch, including Ollama"); };
const parent = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v13-validation-")), root = path.join(parent, "workspace");
try {
  const { report } = await createPlanningExample(root);
  process.env.SCOUT_MODE = "operational-planning";
  validateOperationalPlan(report.plan);
  assert.equal(report.plan.projects.length, 2); assert.equal(report.execution_allowed, false);
  const ledger = await fs.readFile(path.join(root, "economic-ledger.json"), "utf8");
  const file = path.join(preparationStoreRoot(root), "state.json"), canonical = await fs.readFile(file, "utf8");
  const replay = await runOperationalPlanning({ root, command: { kind: "plan" } });
  assert.equal(replay.plan.plan_id, report.plan.plan_id); assert.equal(await fs.readFile(file, "utf8"), canonical);
  for (const p of report.plan.projects) {
    assert.deepEqual(p.economics.scenarios.map(s => [s.estimated_cost_cents, s.hypothetical_revenue_cents, s.projected_result_cents]), [[1000, 0, -1000], [1000, 1500, 500], [800, 2250, 1450]]);
    assert(p.actions.every(a => !a.executable && a.proposed_only));
    assert(p.economics.scenarios.every(s => !s.revenue_is_acquired && s.revenue_added_to_available_funds_cents === 0));
    assert.equal(p.started_at, null); assert.equal(p.economics.confirmed_revenue_cents, null);
  }
  const p = report.decision_dossiers[0], r = p.exact_authorizations[0];
  await assert.rejects(runOperationalPlanning({ root, command: { kind: "check-action", plan_id: report.plan.plan_id,
    scope: { project_id: p.project_id, dossier_hash: p.dossier_hash, action_id: r.action_id, request_id: r.request_id, fingerprint: r.fingerprint } } }), /DOSSIER_BLOCKED/);
  await stopOperationalPlanning({ root, command: { kind: "halt", reason: "operator-stop" } });
  await assert.rejects(runOperationalPlanning({ root, command: { kind: "plan" } }), /EMERGENCY_STOP/);
  const stopped = await runOperationalPlanning({ root, command: { kind: "report" } });
  assert(stopped.decision_dossiers.every(p => p.blockers.includes("EMERGENCY_STOP")));
  assert.equal(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8"), ledger);
  assert.equal(await workspaceFingerprint(normal), before); assert.equal(fetchCalls, 0);
  await fs.writeFile(path.join(parent, "validation-proof.json"), JSON.stringify({ version: "13", status: "PASS", plan_id: report.plan.plan_id,
    projects: 2, scenarios_per_project: 3, idempotent: true, emergency_stop_persisted: true,
    financial_transfer_performed: false, money_moved_cents: 0, real_pilot_started: false,
    public_network_calls: 0, ollama_calls: 0, real_workspace_unchanged: true, chromebook_hardware_validated: false }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(`Artifacts: ${parent}`);
  console.log("V13 PASS: authenticated reproducible proposals, integer scenarios, exact scope, durable stop, no economic execution.");
} finally {
  globalThis.fetch = nativeFetch;
  if (old === undefined) delete process.env.SCOUT_MODE; else process.env.SCOUT_MODE = old;
  assert.equal(await workspaceFingerprint(normal), before);
}
