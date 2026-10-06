/** V8 fixed ping only; no generic HTTP client or model tool. */
import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { isIP, type TcpNetConnectOpts } from "node:net";
import { createHash } from "node:crypto";
import { publicAddress, publicHttpsUrl, type ResolvedAddress, type HttpReply } from "../scout-web/network.js";

export const WEBHOOK_LIMITS = Object.freeze({ timeoutMs: 10_000, payloadBytes: 2048, responseBytes: 16 * 1024, headerBytes: 8192 });
export const WEBHOOK_ERRORS = ["interrupted", "dns_error", "dns_denied", "timeout", "tls_or_network_error", "response_limit", "redirect_denied", "http_error", "invalid_response"] as const;
export type WebhookErrorClass = typeof WEBHOOK_ERRORS[number];
export interface PingOutcome {
  status: "executed" | "failed" | "failed-after-send" | "uncertain";
  http_status: number | null; response_size: number | null; response_sha256: string | null; network_error_class: WebhookErrorClass | null;
}
/** Test injection is host-code only; no CLI/env/module path can select a transport. */
export interface WebhookTransport {
  resolve(host: string): Promise<ResolvedAddress[]>;
  ping(url: URL, pinned: ResolvedAddress, actionId: string, signal: AbortSignal): Promise<HttpReply>;
}
export function webhookEndpoint(raw: unknown): URL {
  try {
    if (typeof raw !== "string" || !/^https:\/\//i.test(raw) || raw.includes("?") || raw.includes("#") || /^https:\/\/[^/]*@/i.test(raw)) throw new Error();
    return publicHttpsUrl(raw);
  } catch { throw new Error("Invalid SCOUT_V8_WEBHOOK_URL: public HTTPS:443 only; no credentials, query or fragment"); }
}
export function fixedWebhookPayload(actionId: string): string {
  if (!/^action-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(actionId)) throw new Error("Exact runtime action_id required");
  const payload = JSON.stringify({ version: 8, action: "webhook_ping", action_id: actionId, message: "Scout V8 external action test" });
  if (Buffer.byteLength(payload) > WEBHOOK_LIMITS.payloadBytes) throw new Error("Fixed ping payload exceeds limit");
  return payload;
}

export const nativeWebhookTransport: WebhookTransport = {
  resolve: host => lookup(host, { all: true, verbatim: true }),
  ping: (inputUrl, pinned, actionId, signal) => new Promise((resolve, reject) => {
    const url = webhookEndpoint(inputUrl.href), host = url.hostname.replace(/^\[|\]$/g, "");
    if (!publicAddress(pinned.address) || isIP(pinned.address) !== pinned.family || (isIP(host) && host !== pinned.address)) throw new Error("Invalid pinned address");
    signal.throwIfAborted();
    const payload = fixedWebhookPayload(actionId);
    const options: RequestOptions & Pick<TcpNetConnectOpts, "autoSelectFamily"> = {
      method: "POST", agent: false, family: pinned.family, autoSelectFamily: false, signal,
      rejectUnauthorized: true, minVersion: "TLSv1.2", maxHeaderSize: WEBHOOK_LIMITS.headerBytes,
      headers: { "Content-Type": "application/json", Accept: "application/json", "Content-Length": Buffer.byteLength(payload) },
      // No second DNS resolution, proxy, shared agent, cookie jar or authentication.
      lookup: ((hostname: string, _options: unknown, callback: Function) => {
        if (hostname !== host) { callback(new Error("Pinned host mismatch")); return; }
        callback(null, pinned.address, pinned.family);
      }) as any,
    };
    const req = request(url, options, res => {
      res.on("error", () => {});
      const headers: Record<string, string | undefined> = {};
      if (typeof res.headers["content-length"] === "string") headers["content-length"] = res.headers["content-length"];
      // Location, Set-Cookie, authentication challenges and arbitrary headers are ignored.
      resolve({ status: res.statusCode ?? 0, headers, body: res, close: () => res.destroy() });
    });
    req.on("error", reject);
    req.end(payload); // Exactly one fixed POST. No redirect/retry branch exists.
  }),
};
class PingError extends Error { constructor(readonly category: WebhookErrorClass) { super(category); } }
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new PingError("timeout"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new PingError("timeout"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
/** Caller MUST persist the one-shot intent before entering this function. */
export async function sendWebhookPing(raw: string, actionId: string, transport: WebhookTransport = nativeWebhookTransport): Promise<PingOutcome> {
  const url = webhookEndpoint(raw); fixedWebhookPayload(actionId);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), WEBHOOK_LIMITS.timeoutMs);
  let postMayHaveStarted = false, phase: "dns" | "post" | "body" = "dns", response: HttpReply | undefined;
  let httpStatus: number | null = null;
  try {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(transport.resolve(host), controller.signal);
    if (!addresses.length || addresses.length > 64 || addresses.some(a => !publicAddress(a.address) || isIP(a.address) !== a.family)) throw new PingError("dns_denied");
    controller.signal.throwIfAborted();
    phase = "post"; postMayHaveStarted = true;
    const pending = transport.ping(url, addresses[0], actionId, controller.signal);
    pending.then(reply => { if (controller.signal.aborted) reply.close(); }, () => {});
    response = await abortable(pending, controller.signal);
    phase = "body";
    if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) throw new PingError("invalid_response");
    httpStatus = response.status;
    if (httpStatus >= 300 && httpStatus <= 399) return { status: "failed-after-send", http_status: httpStatus, response_size: null, response_sha256: null, network_error_class: "redirect_denied" };
    const announced = response.headers["content-length"];
    if (announced !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(announced) || Number(announced) > WEBHOOK_LIMITS.responseBytes)) throw new PingError("response_limit");
    const hash = createHash("sha256"), iterator = response.body[Symbol.asyncIterator](); let size = 0;
    while (true) {
      const next = await abortable(iterator.next(), controller.signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new PingError("invalid_response");
      size += next.value.byteLength;
      if (size > WEBHOOK_LIMITS.responseBytes) throw new PingError("response_limit");
      hash.update(next.value); // Never decode, persist, execute or parse the response body.
    }
    if (announced !== undefined && Number(announced) !== size) throw new PingError("invalid_response");
    return { status: httpStatus < 300 ? "executed" : "failed-after-send", http_status: httpStatus, response_size: size,
      response_sha256: hash.digest("hex"), network_error_class: httpStatus < 300 ? null : "http_error" };
  } catch (error) {
    return { status: postMayHaveStarted ? "uncertain" : "failed", http_status: httpStatus, response_size: null, response_sha256: null,
      network_error_class: controller.signal.aborted ? "timeout" : error instanceof PingError ? error.category : phase === "dns" ? "dns_error" : "tls_or_network_error" };
  } finally { clearTimeout(timer); controller.abort(); response?.close(); }
}
