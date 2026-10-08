/** In-memory V8 transport: no DNS, socket, HTTP, subprocess, publication or payment. */
import { PILOT_ENDPOINT, pilotContext } from "./pilot-context.js";
import { fixedWebhookPayload, type WebhookTransport } from "./webhook-ping.js";
export class DryRunExternalTransport implements WebhookTransport {
  async resolve(host: string) {
    if (!pilotContext() || host !== new URL(PILOT_ENDPOINT).hostname) throw new Error("Dry-run endpoint required");
    return [{ address: "93.184.216.34", family: 4 }]; // Test address passed through V8's real admission checks; never resolved.
  }
  async ping(url: URL, pinned: { address: string; family: number }, actionId: string, signal: AbortSignal) {
    if (!pilotContext() || url.href !== PILOT_ENDPOINT || pinned.address !== "93.184.216.34" || pinned.family !== 4) throw new Error("Dry-run transport scope mismatch");
    signal.throwIfAborted(); fixedWebhookPayload(actionId);
    const body = Buffer.from(JSON.stringify({ mode: "DRY_RUN_ONLY", action_id: actionId, result: "ACTION_SIMULATED" }));
    return { status: 200, headers: { "content-length": String(body.length) }, body: (async function* () { yield body; })(), close() {} };
  }
}
