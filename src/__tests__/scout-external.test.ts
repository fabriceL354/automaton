import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as https from "node:https";
import * as dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runExternalScout, runExternalApprovalScout, parseExternalCommand, externalStoreRoot, type ExternalCommand } from "../agent/external-gateway.js";
import { fixedWebhookPayload, webhookEndpoint, sendWebhookPing, nativeWebhookTransport, WEBHOOK_LIMITS, type WebhookTransport } from "../agent/webhook-ping.js";
import { createWebhookApproval, parseWebhookAction, parseWebhookApproval, decideWebhookApproval } from "../agent/approval-gate.js";
import { createLocalWorkspaceTools } from "../agent/local-tools.js";
import type { HttpReply } from "../scout-web/network.js";

vi.mock("node:fs/promises", async importOriginal => { const actual = await importOriginal<typeof import("node:fs/promises")>(); return { ...actual, rename: vi.fn(actual.rename) }; });
vi.mock("node:https", async importOriginal => ({ ...await importOriginal<typeof import("node:https")>(), request: vi.fn(() => { throw new Error("Real network forbidden in tests"); }) }));
vi.mock("node:dns/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:dns/promises")>(), lookup: vi.fn(() => { throw new Error("Real DNS forbidden in tests"); }) }));
const publicIp = { address: "93.184.216.34", family: 4 };
const actionId = "action-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const endpoint = "https://hook.example/operator-private-path";
function reply(text = "{}", status = 200, headers: Record<string, string | undefined> = {}): HttpReply {
  return { status, headers, body: (async function* () { yield Buffer.from(text); })(), close: vi.fn() };
}
function fake(response = reply()): WebhookTransport & { resolve: ReturnType<typeof vi.fn>; ping: ReturnType<typeof vi.fn> } {
  return { resolve: vi.fn().mockResolvedValue([publicIp]), ping: vi.fn().mockResolvedValue(response) };
}
let temp: string, root: string, transport: ReturnType<typeof fake>;
let fetchMock: ReturnType<typeof vi.fn>;
const read = (name: string) => fs.readFile(path.join(root, name), "utf8");
const write = (name: string, value: unknown) => fs.writeFile(path.join(root, name), JSON.stringify(value));
const run = (command: ExternalCommand) => runExternalScout({ root, command, transport });
async function prepare() { await run({ kind: "prepare" }); return { action: JSON.parse(await read("external-action.json")), request: JSON.parse(await read("external-approval-request.json")) }; }
async function decide(requestId: string, kind = "approve") {
  vi.stubEnv("SCOUT_MODE", "approval");
  try { return await runExternalApprovalScout({ root, args: [`--${kind}-external`, requestId] }); }
  finally { vi.stubEnv("SCOUT_MODE", "external"); }
}
async function approved() { const r = await prepare(); await decide(r.request.request_id); return r; }
const execute = (value: Awaited<ReturnType<typeof prepare>>, preview = false) => run({ kind: "execute", actionId: value.action.action_id, requestId: value.request.request_id, preview });
async function absent(name: string) { await expect(fs.stat(path.join(root, name))).rejects.toThrow(); }
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-external-")); root = path.join(temp, "workspace"); transport = fake();
  vi.stubEnv("SCOUT_MODE", "external"); vi.stubEnv("SCOUT_V8_WEBHOOK_URL", endpoint); vi.stubEnv("OLLAMA_BASE_URL", "invalid");
  fetchMock = vi.fn(() => { throw new Error("No fetch/Ollama allowed"); }); vi.stubGlobal("fetch", fetchMock);
  vi.mocked(fs.rename).mockClear(); vi.mocked(https.request).mockClear(); vi.mocked(dns.lookup).mockClear();
});
afterEach(async () => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers();
  await fs.rm(temp, { recursive: true, force: true });
});

describe("V8 public HTTPS operator URL and fixed payload", () => {
  it.each([undefined, "", "http://hook.example", "file:///tmp/a", "ftp://hook.example", "https:hook.example", "https://localhost", "https://internal", "https://x.local",
    "https://127.0.0.1", "https://127.1", "https://2130706433", "https://10.0.0.1", "https://172.16.0.1", "https://192.168.1.1", "https://169.254.169.254",
    "https://100.64.0.1", "https://192.0.2.1", "https://198.51.100.1", "https://203.0.113.1", "https://224.0.0.1", "https://240.0.0.1", "https://[::1]", "https://[fc00::1]",
    "https://[fe80::1]", "https://[::ffff:8.8.8.8]", "https://[2001:db8::1]", "https://[ff02::1]", "https://u:p@hook.example", "https://@hook.example",
    "https://hook.example:8443", "https://hook.example/?token=private", "https://hook.example/?", "https://hook.example/#fragment", "https://hook.example/#",
    " https://hook.example", "https://hook.example\\path", "https://hook.example/\nsecret", "https://hook.example/" + "a".repeat(2100)])("refuses URL %j without leaking it or networking", async value => {
    vi.stubEnv("SCOUT_V8_WEBHOOK_URL", value);
    await expect(run({ kind: "prepare" })).rejects.toThrow("Invalid SCOUT_V8_WEBHOOK_URL");
    expect(transport.resolve).not.toHaveBeenCalled(); expect(transport.ping).not.toHaveBeenCalled();
  });

  it("retains operator path, fingerprints exact configuration and never persists raw URL", async () => {
    const r = await prepare();
    expect(webhookEndpoint(endpoint).pathname).toBe("/operator-private-path");
    expect(r.action).toMatchObject({ version: 8, type: "webhook_ping", status: "prepared", endpoint_fingerprint: hash(endpoint), capabilities: ["webhook_ping"] });
    expect(r.action.payload_fingerprint).toBe(hash(fixedWebhookPayload(r.action.action_id)));
    const files = await fs.readdir(root);
    for (const file of files) expect(await read(file)).not.toContain("operator-private-path");
    expect(await fs.readFile(path.join(externalStoreRoot(root), "state.json"), "utf8")).not.toContain(endpoint);
    expect(transport.resolve).not.toHaveBeenCalled(); expect(transport.ping).not.toHaveBeenCalled();
    const old = await read("external-action.json"); await prepare(); expect(await read("external-action.json")).toBe(old);
  });

  it("has exactly four fixed payload fields, bounded size and no user/model text", () => {
    const payload = fixedWebhookPayload(actionId);
    expect(JSON.parse(payload)).toEqual({ version: 8, action: "webhook_ping", action_id: actionId, message: "Scout V8 external action test" });
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(2048);
    expect(() => fixedWebhookPayload("user text")).toThrow();
    expect(() => parseExternalCommand(["--prepare-webhook-ping", "--payload", "hi"])).toThrow();
    expect(() => parseExternalCommand(["--prepare-webhook-ping", "--url", endpoint])).toThrow();
    expect(() => parseExternalCommand(["--prepare-webhook-ping", "--header", "Authorization: secret"])).toThrow();
  });
});

describe("V8 offline preparation/preview and scoped V6 approvals", () => {
  it("previews pending action offline, then approved execution offline, without writing attempt state", async () => {
    const r = await prepare(), before = await read("external-action.json"), privateBefore = await fs.readFile(path.join(externalStoreRoot(root), "state.json"), "utf8");
    const preview = await run({ kind: "preview", actionId: r.action.action_id });
    expect(preview).toContain("APERÇU"); expect(preview).toContain("Approbation humaine : requise"); expect(preview).toContain(fixedWebhookPayload(r.action.action_id));
    expect(await fs.readFile(path.join(externalStoreRoot(root), "state.json"), "utf8")).toBe(privateBefore);
    await expect(execute(r, true)).rejects.toThrow("approved V6");
    await decide(r.request.request_id);
    expect(await read("external-action-report.txt")).toContain("APPROUVÉE MAIS NON EXÉCUTÉE");
    const approvedBefore = await fs.readFile(path.join(externalStoreRoot(root), "state.json"), "utf8");
    expect(await execute(r, true)).toContain("APERÇU"); expect(await read("external-action.json")).toBe(before);
    expect(await fs.readFile(path.join(externalStoreRoot(root), "state.json"), "utf8")).toBe(approvedBefore);
    await absent("external-execution.json"); expect(transport.resolve).not.toHaveBeenCalled(); expect(transport.ping).not.toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled(); expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("requires exact approved V6 request; no execution with pending or denial", async () => {
    const r = await prepare(); await expect(execute(r)).rejects.toThrow("approved V6");
    await decide(r.request.request_id, "deny"); await expect(execute(r)).rejects.toThrow("approved V6");
    await expect(decide(r.request.request_id)).rejects.toThrow("pending");
    expect(await read("external-action-report.txt")).toContain("REFUSÉE");
    const fresh = await prepare(); expect(fresh.action.action_id).not.toBe(r.action.action_id); expect(fresh.request.request_id).not.toBe(r.request.request_id);
    expect(transport.resolve).not.toHaveBeenCalled();
  });

  it.each(["latest", "all", "*", "yes", "true", "approve-all", ""])("rejects implicit id %j", async value => {
    await prepare(); await expect(decide(value)).rejects.toThrow();
    expect(() => parseExternalCommand(["--execute", value, "--approval-request-id", value])).toThrow();
    expect(transport.resolve).not.toHaveBeenCalled();
  });

  it("rejects a different action id/request id and added host command fields", async () => {
    const r = await approved();
    await expect(run({ kind: "execute", actionId, requestId: r.request.request_id, preview: false })).rejects.toThrow("action_id");
    await expect(run({ kind: "execute", actionId: r.action.action_id, requestId: "request-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", preview: false })).rejects.toThrow("request_id");
    await expect(run({ kind: "prepare", url: endpoint } as any)).rejects.toThrow("fields");
    expect(transport.resolve).not.toHaveBeenCalled();
  });

  it("isolates V6 economic capabilities and rejects all generic capabilities", async () => {
    const r = await prepare();
    for (const cap of ["real_spending", "publication", "external_account", "http_request", "web_request", "post", "network", "arbitrary_url"]) {
      expect(() => parseWebhookAction({ ...r.action, capabilities: [cap] })).toThrow();
      const entry = createWebhookApproval(r.action); entry.request.requested_capabilities = [cap] as any;
      expect(() => parseWebhookApproval(entry, r.action)).toThrow();
    }
    const record = createWebhookApproval(r.action);
    const valid = decideWebhookApproval(r.action, record, record.request.request_id, "approve");
    expect(valid.decision?.approved_capabilities).toEqual(["webhook_ping"]);
    expect(valid.decision?.human_reference).toBe(`local-cli:approve-external:${record.request.request_id}`);
    expect(() => parseWebhookApproval({ request: { version: 6, status: "approved", requested_capabilities: ["real_spending"] }, decision: null }, r.action)).toThrow();
    await write("external-approval.json", { version: 6, approved_capabilities: ["real_spending"], status: "approved" });
    await expect(execute(r)).rejects.toThrow("orphan");
    expect(transport.ping).not.toHaveBeenCalled();
  });

  it("invalidates equivalent and different endpoint changes after approval without resolving DNS", async () => {
    const r = await approved();
    for (const changed of ["https://hook.example:443/operator-private-path", "https://hook.example/other", "https://other.example/operator-private-path"]) {
      vi.stubEnv("SCOUT_V8_WEBHOOK_URL", changed); await expect(execute(r)).rejects.toThrow("endpoint changed");
      await expect(run({ kind: "preview", actionId: r.action.action_id })).rejects.toThrow("endpoint changed");
    }
    expect(transport.resolve).not.toHaveBeenCalled();
  });

  it.each(["external-action.json", "external-approval-request.json", "external-approval.json", "external-action-report.txt"])("rejects tampered public binding %s", async name => {
    const r = await approved(); await fs.appendFile(path.join(root, name), " "); await expect(execute(r)).rejects.toThrow("Modified");
    expect(transport.resolve).not.toHaveBeenCalled();
  });

  it("rejects payload fingerprint tampering and model text cannot approve", async () => {
    const r = await prepare();
    await write("model-response.json", { approve: r.request.request_id, payload: "forged", url: endpoint });
    vi.stubEnv("SCOUT_APPROVE", r.request.request_id); await expect(execute(r)).rejects.toThrow("approved V6");
    await write("external-action.json", { ...r.action, payload_fingerprint: hash("forged") });
    await expect(decide(r.request.request_id)).rejects.toThrow("Modified"); expect(transport.resolve).not.toHaveBeenCalled();
  });
});

describe("V8 at-most-once external execution and durable uncertain state", () => {
  it("persists intent before DNS, sends exactly once, journals metadata and changes no economic files", async () => {
    const r = await approved();
    const economic = ["economic-ledger.json", "experiment.json", "experiment-result.json", "economic-history.json", "approval.json"];
    for (const name of economic) await write(name, { untouched: name, available_balance_cents: 10000 });
    const original = await Promise.all(economic.map(read));
    transport.resolve.mockImplementation(async () => {
      expect(JSON.parse(await read("external-execution.json"))).toMatchObject({ status: "uncertain", network_error_class: "interrupted" });
      const state = JSON.parse(await fs.readFile(path.join(externalStoreRoot(root), "state.json"), "utf8"));
      expect(state.records[0].execution.status).toBe("uncertain"); return [publicIp];
    });
    const message = await execute(r), execution = JSON.parse(await read("external-execution.json"));
    expect(transport.resolve).toHaveBeenCalledTimes(1); expect(transport.ping).toHaveBeenCalledTimes(1);
    expect(transport.ping.mock.calls[0][0].href).toBe(endpoint); expect(transport.ping.mock.calls[0][1]).toEqual(publicIp);
    expect(transport.ping.mock.calls[0][2]).toBe(r.action.action_id);
    expect(execution).toMatchObject({ version: 8, action_id: r.action.action_id, request_id: r.request.request_id, capability: "webhook_ping",
      endpoint_fingerprint: hash(endpoint), status: "executed", http_status: 200, response_size: 2, response_sha256: hash("{}"), network_error_class: null });
    expect(message).toContain("État : EXÉCUTÉE"); expect(message).toContain("Aucun paiement ni transaction financière n'a été effectué.");
    expect(JSON.stringify(execution)).not.toContain(endpoint); expect(JSON.stringify(execution)).not.toContain('"body"');
    await expect(execute(r)).rejects.toThrow("replay prohibited"); await expect(execute(r, true)).rejects.toThrow("replay prohibited");
    expect(transport.ping).toHaveBeenCalledTimes(1); expect(await Promise.all(economic.map(read))).toEqual(original);
    expect(await run({ kind: "inspect" })).toContain("EXÉCUTÉE");
  });

  it("does not execute a new action implicitly; explicit prepare creates a new pending request", async () => {
    const r = await approved(); await execute(r); const next = await prepare();
    expect(next.action.action_id).not.toBe(r.action.action_id); expect(next.request.status).toBe("pending");
    await expect(execute(next)).rejects.toThrow("approved V6"); await expect(execute(r)).rejects.toThrow("action_id");
    expect(transport.ping).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(path.join(externalStoreRoot(root), "state.json"), "utf8")).records).toHaveLength(2);
  });

  it("lost connection after possible send is uncertain and never retried or prepared again", async () => {
    const r = await approved(); transport.ping.mockRejectedValue(new Error("Secret endpoint connection reset: " + endpoint));
    expect(await execute(r)).toContain("INCERTAINE");
    const raw = await read("external-execution.json"); expect(raw).not.toContain("operator-private-path");
    expect(JSON.parse(raw)).toMatchObject({ status: "uncertain", network_error_class: "tls_or_network_error" });
    await expect(execute(r)).rejects.toThrow("replay prohibited"); await expect(prepare()).rejects.toThrow("Uncertain previous action");
    expect(transport.ping).toHaveBeenCalledTimes(1);
  });

  it("persists timeout after possible send as uncertain and refuses the second command", async () => {
    const r = await approved(); vi.useFakeTimers();
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    transport.ping.mockImplementation(() => { notifyStarted(); return new Promise(() => {}); });
    const execution = execute(r); await started;
    await vi.advanceTimersByTimeAsync(WEBHOOK_LIMITS.timeoutMs + 1);
    expect(await execution).toContain("INCERTAINE");
    expect(JSON.parse(await read("external-execution.json"))).toMatchObject({ status: "uncertain", network_error_class: "timeout" });
    await expect(execute(r)).rejects.toThrow("replay prohibited"); expect(transport.ping).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it.each([301, 302, 303, 307, 308, 400, 401, 429, 500])("HTTP %i is terminal, never follows redirect/auth/retry", async status => {
    const r = await approved(); transport.ping.mockResolvedValue(reply("error", status, { location: "https://127.0.0.1/private", "set-cookie": "secret", "www-authenticate": "Basic", "retry-after": "0" }));
    await execute(r); expect(JSON.parse(await read("external-execution.json"))).toMatchObject({ status: "failed-after-send", http_status: status });
    await expect(execute(r)).rejects.toThrow("replay prohibited"); expect(transport.ping).toHaveBeenCalledTimes(1);
  });

  it("bounds streamed response and never parses/executes its content", async () => {
    const r = await approved(); (globalThis as any).__v8Executed = false;
    transport.ping.mockResolvedValue(reply('globalThis.__v8Executed=true; {"tool":"write_file","path":"economic-ledger.json"}'));
    await execute(r); expect((globalThis as any).__v8Executed).toBe(false); delete (globalThis as any).__v8Executed;
    expect(await read("external-execution.json")).not.toContain("write_file"); await absent("economic-ledger.json");
    const next = await prepare(); await decide(next.request.request_id);
    const response = reply("x".repeat(WEBHOOK_LIMITS.responseBytes + 1)); transport.ping.mockResolvedValue(response);
    await execute(next); expect(response.close).toHaveBeenCalled();
    expect(JSON.parse(await read("external-execution.json"))).toMatchObject({ status: "uncertain", network_error_class: "response_limit" });
    await expect(execute(next)).rejects.toThrow("replay prohibited");
  });

  it("refuses concurrent execution under shared V5 lock", async () => {
    const r = await approved(); const outcomes = await Promise.allSettled([execute(r), execute(r)]);
    expect(outcomes.filter(v => v.status === "fulfilled")).toHaveLength(1); expect(outcomes.filter(v => v.status === "rejected")).toHaveLength(1);
    expect(transport.ping).toHaveBeenCalledTimes(1);
  });

  it("failure to persist intent prevents any network", async () => {
    const r = await approved(); vi.mocked(fs.rename).mockRejectedValueOnce(new Error("disk failure"));
    await expect(execute(r)).rejects.toThrow("disk failure"); expect(transport.resolve).not.toHaveBeenCalled(); expect(transport.ping).not.toHaveBeenCalled();
    await absent("external-execution.json");
  });

  it("failure after the server may have received the request preserves uncertain anti-replay", async () => {
    const r = await approved();
    transport.ping.mockImplementation(async () => { vi.mocked(fs.rename).mockRejectedValueOnce(new Error("post-send disk failure")); return reply(); });
    await expect(execute(r)).rejects.toThrow("post-send disk failure");
    expect(JSON.parse(await read("external-execution.json"))).toMatchObject({ status: "uncertain", network_error_class: "interrupted" });
    await expect(execute(r)).rejects.toThrow("replay prohibited"); expect(transport.ping).toHaveBeenCalledTimes(1);
  });

  it("never silently overwrites a journal changed during network activity", async () => {
    const r = await approved(); transport.ping.mockImplementation(async () => { await fs.appendFile(path.join(root, "external-execution.json"), " "); return reply(); });
    await expect(execute(r)).rejects.toThrow("Modified"); await expect(execute(r)).rejects.toThrow("Modified"); expect(transport.ping).toHaveBeenCalledTimes(1);
  });

  it("failed view write after durable intent fails closed without initiating a connection", async () => {
    const r = await approved(); const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementationOnce(actual.rename).mockRejectedValueOnce(new Error("view failure"));
    await expect(execute(r)).rejects.toThrow("view failure"); await expect(execute(r)).rejects.toThrow("missing"); expect(transport.resolve).not.toHaveBeenCalled();
  });
});

describe("V8 DNS pinning, TLS, timeout and fixed native request", () => {
  it.each([[], [{ address: "10.0.0.1", family: 4 }], [publicIp, { address: "127.0.0.1", family: 4 }], [{ address: "8.8.8.8", family: 6 }], [{ address: "fe80::1", family: 6 }]].map(answers => ({ answers })))("rejects every unsafe/mixed DNS set $answers", async ({ answers }) => {
    transport.resolve.mockResolvedValue(answers); const outcome = await sendWebhookPing(endpoint, actionId, transport);
    expect(outcome).toMatchObject({ status: "failed", network_error_class: "dns_denied" }); expect(transport.ping).not.toHaveBeenCalled();
  });

  it("DNS failure exposes only a class, and re-resolves for each distinct action", async () => {
    transport.resolve.mockRejectedValueOnce(new Error("Sensitive hostname: " + endpoint));
    expect(await sendWebhookPing(endpoint, actionId, transport)).toMatchObject({ status: "failed", network_error_class: "dns_error" });
    expect(transport.ping).not.toHaveBeenCalled();
    transport.resolve.mockResolvedValueOnce([publicIp]).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    expect((await sendWebhookPing(endpoint, actionId, transport)).status).toBe("executed");
    expect((await sendWebhookPing(endpoint, "action-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", transport)).status).toBe("failed");
    expect(transport.ping).toHaveBeenCalledTimes(1);
  });

  it.each(["dns", "post", "body"])("enforces one 10-second deadline through %s with no retry", async stage => {
    vi.useFakeTimers();
    if (stage === "dns") transport.resolve.mockImplementation(() => new Promise(() => {}));
    if (stage === "post") transport.ping.mockImplementation(() => new Promise(() => {}));
    if (stage === "body") transport.ping.mockResolvedValue({ ...reply(), body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) } });
    const pending = sendWebhookPing(endpoint, actionId, transport);
    await vi.advanceTimersByTimeAsync(WEBHOOK_LIMITS.timeoutMs + 1);
    expect(await pending).toMatchObject({ status: stage === "dns" ? "failed" : "uncertain", network_error_class: "timeout" });
    expect(transport.ping).toHaveBeenCalledTimes(stage === "dns" ? 0 : 1);
  });

  it.each(["999999", "NaN", "-1", "1.5"])("refuses content-length %s and discards the body", async length => {
    const response = reply("data", 200, { "content-length": length }); transport.ping.mockResolvedValue(response);
    expect(await sendWebhookPing(endpoint, actionId, transport)).toMatchObject({ status: "uncertain", network_error_class: "response_limit" }); expect(response.close).toHaveBeenCalled();
  });

  it("native transport fixes POST/body/headers/TLS/address and never sends cookies/auth/custom fields", async () => {
    const req = Object.assign(new EventEmitter(), { end: vi.fn() });
    const res = Object.assign(new EventEmitter(), reply("{}"), { headers: { "content-length": "2", "set-cookie": "secret", location: endpoint }, statusCode: 200, destroy: vi.fn() });
    vi.mocked(https.request).mockImplementation(((_url: unknown, _opts: unknown, callback: Function) => { queueMicrotask(() => callback(res)); return req; }) as any);
    const response = await nativeWebhookTransport.ping(new URL(endpoint), publicIp, actionId, new AbortController().signal);
    const options = vi.mocked(https.request).mock.calls[0][1] as any;
    expect(options).toMatchObject({ method: "POST", agent: false, family: 4, autoSelectFamily: false, rejectUnauthorized: true, minVersion: "TLSv1.2", maxHeaderSize: WEBHOOK_LIMITS.headerBytes });
    expect(options.headers).toEqual({ "Content-Type": "application/json", Accept: "application/json", "Content-Length": Buffer.byteLength(fixedWebhookPayload(actionId)) });
    const cb = vi.fn(); options.lookup("hook.example", {}, cb); expect(cb).toHaveBeenCalledWith(null, publicIp.address, 4);
    const wrong = vi.fn(); options.lookup("other.example", {}, wrong); expect(wrong.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(req.end).toHaveBeenCalledTimes(1); expect(req.end).toHaveBeenCalledWith(fixedWebhookPayload(actionId));
    expect(response.headers).toEqual({ "content-length": "2" }); expect(dns.lookup).not.toHaveBeenCalled();
    response.close(); expect(res.destroy).toHaveBeenCalled();
  });
});

describe("V8 storage integrity, confinement and CLI", () => {
  it.each(["external-action.json", "external-approval-request.json", "external-approval.json", "external-execution.json", "external-action-report.txt"])("rejects symlink/hardlink %s", async name => {
    const r = await approved(), outside = path.join(temp, "outside"); await fs.writeFile(outside, "untouched");
    await fs.rm(path.join(root, name), { force: true }); await fs.symlink(outside, path.join(root, name)); await expect(execute(r)).rejects.toThrow();
    await fs.unlink(path.join(root, name)); await fs.link(outside, path.join(root, name)); await expect(execute(r)).rejects.toThrow();
    expect(await fs.readFile(outside, "utf8")).toBe("untouched"); expect(transport.resolve).not.toHaveBeenCalled();
  });

  it.each(["state.json", "integrity-key"])("rejects private anchor link/missing file %s", async name => {
    const r = await approved(), target = path.join(externalStoreRoot(root), name), outside = path.join(temp, "outside");
    await fs.rename(target, outside); await fs.symlink(outside, target); await expect(execute(r)).rejects.toThrow();
    await fs.unlink(target); await fs.link(outside, target); await expect(execute(r)).rejects.toThrow();
    await fs.unlink(target); await expect(execute(r)).rejects.toThrow("Incomplete external anchor"); expect(transport.resolve).not.toHaveBeenCalled();
  });

  it("authenticates private history and rejects modified execution metadata", async () => {
    const r = await approved(); await execute(r);
    await fs.appendFile(path.join(root, "external-execution.json"), " "); await expect(run({ kind: "inspect" })).rejects.toThrow("Modified");
    const file = path.join(externalStoreRoot(root), "state.json"), state = JSON.parse(await fs.readFile(file, "utf8"));
    state.records[0].execution = null; await fs.writeFile(file, JSON.stringify(state));
    await expect(execute(r)).rejects.toThrow("authentication"); expect(transport.ping).toHaveBeenCalledTimes(1);
  });

  it("blocks symlink workspace and stale lock without a connection", async () => {
    await fs.mkdir(path.join(temp, "real")); await fs.symlink(path.join(temp, "real"), root); await expect(prepare()).rejects.toThrow("unsafe");
    await fs.unlink(root); await fs.mkdir(root); await fs.writeFile(path.join(root, ".economic-ledger.lock"), "stale");
    await expect(prepare()).rejects.toThrow("locked"); expect(transport.resolve).not.toHaveBeenCalled();
  });

  it("blocks generic writes and private-anchor reads without introducing model tools", async () => {
    await prepare(); const tools = createLocalWorkspaceTools(root); expect(tools.map(t => t.name)).toEqual(["list_files", "read_file", "write_file"]);
    const writeTool = tools.find(t => t.name === "write_file")!, readTool = tools.find(t => t.name === "read_file")!;
    for (const name of ["external-action.json", "external-execution.json", "external-action-report.txt", "external-approval.json", "external-approval-request.json", "./external-action.json", "sub/external-execution.json", ".external.lock"]) {
      expect(await (writeTool.execute as any)({ path: name, content: "forged" })).toContain("runtime-controlled");
    }
    const outside = path.relative(root, path.join(externalStoreRoot(root), "integrity-key")); expect(await (readTool.execute as any)({ path: outside })).toContain("ERROR");
  });

  it("actual CLI prepares/previews/approves offline without Ollama and rejects implicit commands", async () => {
    const cliRoot = path.join(temp, ".automaton", "scout-workspace");
    const cli = (args: string[], mode = "external") => promisify(execFile)(process.execPath, ["dist/index.js", ...args], {
      cwd: process.cwd(), env: { ...process.env, HOME: temp, SCOUT_MODE: mode, OLLAMA_BASE_URL: "invalid", SCOUT_V8_WEBHOOK_URL: endpoint }, timeout: 10000 });
    expect((await cli(["--prepare-webhook-ping"])).stdout).toContain("PRÉPARÉE");
    const r = JSON.parse(await fs.readFile(path.join(cliRoot, "external-approval-request.json"), "utf8"));
    expect((await cli(["--preview", r.action_id])).stdout).toContain("APERÇU");
    await expect(cli(["--approve-external", "latest"], "approval")).rejects.toThrow();
    await expect(cli(["--approve-external", r.request_id])).rejects.toThrow();
    expect((await cli(["--approve-external", r.request_id], "approval")).stdout).toContain("APPROUVÉE MAIS NON EXÉCUTÉE");
    expect((await cli(["--execute", r.action_id, "--approval-request-id", r.request_id, "--preview"])).stdout).toContain("APERÇU");
    await expect(fs.stat(path.join(cliRoot, "external-execution.json"))).rejects.toThrow();
    await expect(fs.stat(path.join(cliRoot, "economic-ledger.json"))).rejects.toThrow();
  });
});
