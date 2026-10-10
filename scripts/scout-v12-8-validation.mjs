import "./scout-offline-test-guard.mjs";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createReadinessExample } from "./scout-v12-8-example.mjs";
import { runPilotReadiness, stopPilotReadiness, renderReadinessReport } from "../dist/agent/pilot-readiness.js";
import { preparationStoreRoot } from "../dist/agent/pilot-preparation-store.js";
import { workspaceFingerprint } from "../dist/agent/pilot-workspace-proof.js";
import { scoutWorkspaceRoot } from "../dist/agent/local-tools.js";
const normal = scoutWorkspaceRoot(), before = await workspaceFingerprint(normal), old = process.env.SCOUT_MODE, nativeFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error("V12.8 simulation permits no fetch, including Ollama"); };
const parent = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v12-8-validation-")), root = path.join(parent, "workspace");
try {
  const example = await createReadinessExample(root), r = example.report;
  process.env.SCOUT_MODE = "pilot-readiness";
  assert.equal(r.projects.length, 2); assert.equal(r.handover.current_total_exposure_cents, 2000);
  assert.equal(r.handover.financial_transfer_performed, false); assert.equal(r.handover.capital_is_bank_balance, false);
  assert(r.projects.every(p => p.blockers.includes("FICTIONAL_PROJECT") && p.blockers.includes("ATOMIC_HANDOVER_NOT_IMPLEMENTED")));
  const ledger = await fs.readFile(path.join(root, "economic-ledger.json"), "utf8");
  assert.equal(JSON.parse(ledger).entries.length, 1); // simulated initialization only
  const file = path.join(preparationStoreRoot(root), "state.json"), canonical = await fs.readFile(file, "utf8");
  await runPilotReadiness({ root, command: { kind: "prepare-handover" } });
  assert.equal(await fs.readFile(file, "utf8"), canonical);
  const p = r.projects[0], request = p.exact_authorizations[0];
  await assert.rejects(runPilotReadiness({ root, command: { kind: "check-action", scope: { project_id: p.project_id, dossier_hash: p.dossier_hash, action_id: request.action_id, request_id: request.request_id, fingerprint: request.fingerprint } } }), /DOSSIER_BLOCKED/);
  for (const p of r.projects) {
    assert.equal(p.economics.expense_really_verified_cents, null); assert.equal(p.economics.revenue_really_confirmed_cents, null);
    assert.equal(p.experiment.started_at, null); assert.equal(p.manual_launch_status, "NOT_RECORDED");
  }
  assert.equal(p.economics.declared_expense_cents, 200); assert.equal(p.economics.experiment_declared_revenue_cents, 300); assert.equal(p.economics.post_experiment_declared_revenue_cents, 100);
  await stopPilotReadiness({ root, command: { kind: "halt", reason: "operator-stop" } });
  await assert.rejects(runPilotReadiness({ root, command: { kind: "prepare-handover" } }), /EMERGENCY_STOP/);
  const stopped = await runPilotReadiness({ root, command: { kind: "report" } });
  assert(stopped.projects.every(p => p.blockers.includes("EMERGENCY_STOP")));
  assert.equal(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8"), ledger); assert.equal(await workspaceFingerprint(normal), before); assert.equal(fetchCalls, 0);
  await fs.writeFile(path.join(parent, "readiness-report.md"), renderReadinessReport(stopped), { mode: 0o600 });
  await fs.writeFile(path.join(parent, "validation-proof.json"), JSON.stringify({ version: "12.8", status: "PASS", projects: 2, earmarked_cents: 2000, financial_transfer_performed: false, real_pilot_started: false, bank_verification: null, emergency_stop_persisted: true, public_network_calls: 0, ollama_calls: 0, real_workspace_unchanged: true }, null, 2) + "\n", { mode: 0o600 });
  console.log(`Artifacts: ${parent}`); console.log("V12.8 PASS: offline fictitious preparation, no double accounting, exact checks, durable stop, unverified economics, no real launch.");
} finally {
  globalThis.fetch = nativeFetch;
  if (old === undefined) delete process.env.SCOUT_MODE; else process.env.SCOUT_MODE = old;
  assert.equal(await workspaceFingerprint(normal), before);
}
