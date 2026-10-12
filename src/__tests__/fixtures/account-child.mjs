import fs from "node:fs/promises";
import path from "node:path";
import {syncBuiltinESMExports} from "node:module";
import {preparationStoreRoot} from "../../../dist/agent/pilot-preparation-store.js";
import {runSellerAccount} from '../../../dist/agent/seller-account.js';
const [root, command, at, operation] = process.argv.slice(2);
if (operation === "pause-state") {
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (String(to) === path.join(preparationStoreRoot(root), "state.json")) {
      process.send?.("PAUSED"); await new Promise(() => {});
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
}
try { console.log(JSON.stringify(await runSellerAccount({root,command:JSON.parse(command),now:()=>at}))); }
catch {process.exitCode=2;}
