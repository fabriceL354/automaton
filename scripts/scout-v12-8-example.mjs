/** Entirely fictitious; only new temporary workspace destinations are accepted. */
import "./scout-offline-test-guard.mjs";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createPreparationExample } from "./scout-v12-7-example.mjs";
import { runPilotPreparation } from "../dist/agent/pilot-preparation.js";
import { runPilotReadiness, renderReadinessReport } from "../dist/agent/pilot-readiness.js";
export async function createReadinessExample(root) {
  await createPreparationExample(root);
  const old = process.env.SCOUT_MODE;
  try {
    process.env.SCOUT_MODE = "pilot-preparation";
    const prepared = await runPilotPreparation({ root, command: { kind: "prepare" } }), p = prepared.projects[0], r = p.requests[0];
    // A fictional local approval and declarations illustrate the distinctions.
    // No commercial review is accepted for these fictitious dossiers.
    await runPilotPreparation({ root, command: { kind: "approve", project_id: p.project_id, action_id: r.action_id, request_id: r.request_id, fingerprint: r.fingerprint } });
    for (const [declaration_id, economic_kind, amount_cents, phase] of [
      ["fictional-expense", "expense", 200, "experiment"], ["fictional-experiment-revenue", "revenue", 300, "experiment"], ["fictional-later-revenue", "revenue", 100, "post_experiment"],
    ]) await runPilotPreparation({ root, command: { kind: "declare", project_id: p.project_id, declaration_id, economic_kind, amount_cents, phase, proof_id: p.dossier.proofs[0].proof_id } });
    process.env.SCOUT_MODE = "pilot-readiness";
    const report = await runPilotReadiness({ root, command: { kind: "prepare-handover" } });
    return { root, report, markdown: renderReadinessReport(report) };
  } finally { if (old === undefined) delete process.env.SCOUT_MODE; else process.env.SCOUT_MODE = old; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v12-8-example-")), root = path.join(parent, "workspace");
  const example = await createReadinessExample(root);
  await fs.writeFile(path.join(parent, "readiness-report.md"), example.markdown, { flag: "wx", mode: 0o600 });
  await fs.writeFile(path.join(parent, "readiness-report.json"), JSON.stringify(example.report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(`FICTITIOUS OFFLINE EXAMPLE: ${parent}`);
  console.log("Two 1000-cent earmarks; 10000 cents simulated reference; declarations unverified; no transfer, payment or launch.");
}
