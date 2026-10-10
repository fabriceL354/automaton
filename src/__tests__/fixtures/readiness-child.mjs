import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const [root, operation = "prepare-handover"] = process.argv.slice(2);
process.env.SCOUT_MODE = "pilot-readiness";
if (operation === "crash-before-rename" || operation === "crash-after-rename") {
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (path.basename(to) === "state.json") {
      if (operation === "crash-before-rename") process.exit(31);
      await rename(from, to); process.exit(32);
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
}
try {
  const { runPilotReadiness, stopPilotReadiness } = await import("../../../dist/agent/pilot-readiness.js");
  if (operation === "hold-lock") {
    const { locked } = await import("../../../dist/agent/ledger-runner.js");
    const { assertPilotNotStopped } = await import("../../../dist/agent/pilot-stop.js");
    await locked(root, async () => {
      process.send?.("LOCK_HELD");
      await new Promise(resolve => process.once("message", resolve));
      await assertPilotNotStopped(root);
    }, "readiness");
  } else if (operation === "halt") await stopPilotReadiness({ root, command: { kind: "halt", reason: "operator-stop" } });
  else await runPilotReadiness({ root, command: { kind: operation.startsWith("crash-") ? "prepare-handover" : operation } });
  console.log("READINESS_OK_NO_EXECUTION");
} catch (e) { console.error(e.message); process.exitCode = 2; }
