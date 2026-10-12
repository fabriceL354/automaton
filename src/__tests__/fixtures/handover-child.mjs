/** Disposable V14.2 process crash fixture, NEVER a runtime recovery mechanism. */
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { runEconomicHandover } from "../../../dist/agent/economic-handover.js";
const [root, command, operation] = process.argv.slice(2);
process.env.SCOUT_MODE = "economic-handover";
if (operation === "pause-ledger") {
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (String(to) === path.join(root, "economic-ledger.json")) {
      process.send?.("PAUSED"); await new Promise(() => {});
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
}
try { console.log(JSON.stringify(await runEconomicHandover({ root, command: JSON.parse(command) }))); }
catch (e) { console.error(e.message); process.exitCode = 1; }
