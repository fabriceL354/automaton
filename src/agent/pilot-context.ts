/** Trusted V12.6 host context. Never exposed as a model tool or normal clock flag. */
import { AsyncLocalStorage } from "node:async_hooks";
export interface PilotContext { root: string; mode: string; now: string; lockHeld: boolean; guard: { attempts: number; port: number | null } }
const scope = new AsyncLocalStorage<PilotContext>();
export const PILOT_ENDPOINT = "https://scout-pilot.invalid/ping";
export const pilotContext = () => scope.getStore();
export const domainNow = () => scope.getStore()?.now ?? new Date().toISOString();
export function inPilotContext<T>(context: PilotContext, operation: () => T): T { return scope.run(context, operation); }
export function pilotService<T>(mode: string, operation: () => T): T {
  const current = scope.getStore();
  if (!current || process.env.SCOUT_MODE !== "pilot-dry-run") throw new Error("Explicit isolated pilot host required");
  return scope.run({ ...current, mode }, operation);
}
