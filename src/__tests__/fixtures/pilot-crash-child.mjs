// Subprocess test harness only: explicit simulated human decisions, then SIGKILL.
import { runPilotDryRun } from "../../../dist/agent/pilot-dry-run.js";
const [root, point] = process.argv.slice(2);
const fault = key => { if (key.startsWith(point)) process.kill(process.pid, "SIGKILL"); };
for (let i = 0; i < 10; i++) {
  const result = await runPilotDryRun({ root, command: i === 0 && point === "after-effect:allocation" ? "run" : "resume", fault });
  if (result.manifest.current_stage === "COMPLETED") throw new Error("Crash point not reached");
  for (const a of result.approvals) await runPilotDryRun({ root, command: "resume", decision: { requestId: a.request_id, subjectId: a.subject_id, decision: "approve" }, fault });
}
throw new Error("Bounded crash harness exhausted");
