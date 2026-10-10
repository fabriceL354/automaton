import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const [root, operation = "plan"] = process.argv.slice(2);
process.env.SCOUT_MODE = "operational-planning";
if (operation.startsWith("crash-") || operation === "halt-before-rename") {
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (path.basename(to) === "state.json") {
      if (operation === "crash-before-rename") process.exit(31);
      if (operation === "halt-before-rename") {
        const { haltPilot } = await import("../../../dist/agent/pilot-stop.js");
        await haltPilot(root, "operator-stop", new Date().toISOString());
      }
      await rename(from, to);
      if (operation === "crash-after-rename") process.exit(32);
      return;
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
}
try {
  const { runOperationalPlanning, stopOperationalPlanning } = await import("../../../dist/agent/operational-planning.js");
  if (operation === "halt") await stopOperationalPlanning({ root, command: { kind: "halt", reason: "operator-stop" } });
  else await runOperationalPlanning({ root, command: { kind: operation.startsWith("crash-") || operation === "halt-before-rename" ? "plan" : operation } });
  console.log("PLANNING_OK_NO_EXECUTION");
} catch (e) { console.error(e.message); process.exitCode = 2; }
