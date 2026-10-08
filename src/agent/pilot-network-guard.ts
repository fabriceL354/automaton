/** Context-scoped tripwire. Normal Scout calls pass through unchanged. */
import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pilotContext } from "./pilot-context.js";
let installed = false;
export function installPilotNetworkGuard() {
  if (installed) return; installed = true;
  function wrap(object: any, key: string, permitted?: (args: any[]) => boolean) {
    const original = object[key]; if (typeof original !== "function") return;
    object[key] = function (this: unknown, ...args: any[]) {
      const guard = pilotContext()?.guard;
      if (guard && !permitted?.(args)) { guard.attempts++; throw new Error("DRY_RUN_ONLY forbids network, Ollama and subprocesses"); }
      return original.apply(this, args);
    };
  }
  wrap(net.Socket.prototype, "connect", args => {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    const target = typeof normalized[0] === "object" ? normalized[0] : { port: normalized[0], host: normalized[1] };
    const port = pilotContext()!.guard.port;
    return port !== null && !target.path && target.host === "127.0.0.1" && Number(target.port) === port && port !== 11434;
  });
  for (const object of [dns, dnsPromises]) for (const key of Object.keys(object)) {
    if (key === "lookup" || key.startsWith("resolve") || key === "reverse") wrap(object, key, key === "lookup" ? args => args[0] === "127.0.0.1" : undefined);
  }
  for (const key of ["request", "get"]) wrap(https, key);
  wrap(tls, "connect"); wrap(globalThis, "fetch");
  for (const key of ["connect", "send"]) wrap(dgram.Socket.prototype, key);
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) wrap(childProcess, key);
  syncBuiltinESMExports();
}
