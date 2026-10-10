/** Fictitious local example. Accepts only a fresh destination via V12.8. */
import "./scout-offline-test-guard.mjs";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createReadinessExample } from "./scout-v12-8-example.mjs";
import { runOperationalPlanning, renderPlanningReport } from "../dist/agent/operational-planning.js";
export async function createPlanningExample(root) {
  await createReadinessExample(root);
  const old = process.env.SCOUT_MODE;
  try {
    process.env.SCOUT_MODE = "operational-planning";
    const report = await runOperationalPlanning({ root, command: { kind: "plan" } });
    return { root, report, markdown: renderPlanningReport(report) };
  } finally { if (old === undefined) delete process.env.SCOUT_MODE; else process.env.SCOUT_MODE = old; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v13-example-"));
  const example = await createPlanningExample(path.join(parent, "workspace"));
  await fs.writeFile(path.join(parent, "decision-dossier.md"), example.markdown, { flag: "wx", mode: 0o600 });
  await fs.writeFile(path.join(parent, "decision-dossier.json"), JSON.stringify(example.report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(`FICTITIOUS OFFLINE V13 EXAMPLE: ${parent}`);
  console.log(`Stable within this workspace: ${example.report.plan.plan_id}`);
  console.log("Two proposals, three hypotheses each. No acquired revenue, transfer, payment, purchase, account, publication or launch.");
}
