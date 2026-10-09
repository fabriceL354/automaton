import { runPilotPreparation } from "../../../dist/agent/pilot-preparation.js";
import { locked } from "../../../dist/agent/ledger-runner.js";
const [root, operation = "prepare"] = process.argv.slice(2);
process.env.SCOUT_MODE = "pilot-preparation";
try {
  if (operation === "crash") await locked(root, async () => process.exit(23));
  else { const r = await runPilotPreparation({ root, command: { kind: operation } }); console.log(JSON.stringify({ reserved: r.total_preparation_reserved_cents, projects: r.projects.length })); }
} catch { console.error("PREPARATION_BLOCKED"); process.exitCode = 2; }
