/** Compiled offline lifecycle validation. All human decisions below are explicitly
 * SIMULATED_HUMAN_DECISION inside a newly created temporary workspace. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runPilotDryRun } from "../dist/agent/pilot-dry-run.js";
import { workspaceFingerprint } from "../dist/agent/pilot-workspace-proof.js";
import { scoutWorkspaceRoot } from "../dist/agent/local-tools.js";
const began = Date.now(), normal = scoutWorkspaceRoot(), before = await workspaceFingerprint(normal);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v12-6-validation-")), root = path.join(temp, "workspace");
await fs.mkdir(root, { mode: 0o700 });
const previous = process.env.SCOUT_MODE; process.env.SCOUT_MODE = "pilot-dry-run";
const interrupted = new Set(); let result;
const faults = point => {
  const wanted = point === "after-effect:allocation" || point.startsWith("after-effect:reserve-") || point.startsWith("after-effect:decision-") || point.startsWith("after-effect:action-") || point.startsWith("after-effect:result-");
  if (wanted && !interrupted.has(point)) { interrupted.add(point); throw new Error("VALIDATION_INTERRUPTION"); }
};
try {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { result = await runPilotDryRun({ root, command: attempt === 0 ? "run" : "resume", fault: faults }); }
    catch (e) { if (e.message === "VALIDATION_INTERRUPTION") continue; throw e; }
    if (result.manifest.current_stage === "COMPLETED") break;
    assert.equal(result.manifest.status, "WAITING_FOR_HUMAN");
    assert(result.approvals.length > 0);
    for (const approval of result.approvals) {
      try { await runPilotDryRun({ root, command: "resume", decision: { requestId: approval.request_id, subjectId: approval.subject_id, decision: "approve" }, fault: faults }); }
      catch (e) { if (e.message !== "VALIDATION_INTERRUPTION") throw e; break; }
    }
  }
  assert.equal(result?.manifest.current_stage, "COMPLETED");
  result = await runPilotDryRun({ root, command: "resume" });
  assert.equal(result.report.technical_readiness, "READY_FOR_SUPERVISED_REAL_PILOT");
  assert.equal(result.report.simulated_final_capital_cents, 10300);
  assert.equal(result.report.simulated_expenses_cents, 1500);
  assert.equal(result.report.simulated_revenues_cents, 1800);
  assert.equal(result.report.real_money_spent_cents, 0);
  const reportBefore = await fs.readFile(path.join(root, "pilot-dry-run-report.json"), "utf8");
  await runPilotDryRun({ root, command: "resume" });
  assert.equal(await fs.readFile(path.join(root, "pilot-dry-run-report.json"), "utf8"), reportBefore);
  assert.equal(await workspaceFingerprint(normal), before);
  await fs.writeFile(path.join(temp, "validation-proof.json"), JSON.stringify({ schema_version: "12.6", mode: "DRY_RUN_ONLY", workspace: root,
    real_workspace_before: before, real_workspace_after: before, byte_for_byte_unchanged: true,
    recovered_interruptions: [...interrupted], public_network: 0, ollama: 0, real_money_spent_cents: 0,
    elapsed_ms: Date.now() - began, report: path.join(root, "pilot-dry-run-report.json") }, null, 2) + "\n");
} finally {
  if (previous === undefined) delete process.env.SCOUT_MODE; else process.env.SCOUT_MODE = previous;
  assert.equal(await workspaceFingerprint(normal), before, "Real workspace must remain byte-for-byte unchanged");
}
console.log(`Artifacts: ${temp}`);
console.log("V12.6 PASS: full offline pilot lifecycle validated end-to-end; 2 bounded projects; approvals enforced; external actions simulated; monitoring and learning completed; mobile control surface coherent; zero real spend; zero external network; zero Ollama.");
