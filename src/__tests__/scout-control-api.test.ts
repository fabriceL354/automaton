import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import http from "node:http";
import * as https from "node:https";
import * as dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { startControlApi, controlConfig } from "../agent/control-api.js";
import { readVerifiedApprovalRecords, runApprovalScout, approvalStoreRoot } from "../agent/approval-gate.js";
import { locked } from "../agent/ledger-runner.js";
import { PROJECT_LIMITS } from "../agent/asset-lifecycle.js";
import { runExternalScout, readVerifiedExternalRecords } from "../agent/external-gateway.js";
import { runRevenueScout } from "../agent/revenue-runner.js";
import { controlEventStoreRoot } from "../agent/control-events.js";
import { TOKEN, base, read, write, inMode, approvalFixture, allocationFixture, projectFixture, projectCommand } from "./scout-control-fixtures.js";
vi.mock("node:https", async original => ({ ...await original<typeof import("node:https")>(), request: vi.fn(() => { throw new Error("No outgoing HTTPS"); }) }));
vi.mock("node:dns/promises", async original => ({ ...await original<typeof import("node:dns/promises")>(), lookup: vi.fn(() => { throw new Error("No DNS"); }) }));
let temp: string, root: string, api: Awaited<ReturnType<typeof startControlApi>>, fetchMock: ReturnType<typeof vi.fn>;
const id = (prefix: string) => `${prefix}-${randomUUID()}`;
async function start() { api = await startControlApi({ root, env: { SCOUT_CONTROL_API_TOKEN: TOKEN, SCOUT_CONTROL_API_PORT: "0" } }); }
function request(url: string, options: { method?: string; token?: string | null; body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const headers = { ...(options.token === null ? {} : { Authorization: `Bearer ${options.token ?? TOKEN}` }), ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}), ...options.headers };
    const r = http.request({ hostname: "127.0.0.1", port: api.port, path: url, method: options.method ?? "GET", headers, agent: false }, response => {
      let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text), text, headers: response.headers }));
    }); r.on("error", reject); r.end(options.body);
  });
}
const decide = (requestId: string, kind = "approve", token: string | null = TOKEN, body = "{}") => request(`/v1/approvals/${requestId}/${kind}`, { method: "POST", body, token });
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-control-test-")); root = path.join(temp, "workspace"); await base(root);
  vi.stubEnv("SCOUT_MODE", "control-api"); vi.stubEnv("OLLAMA_BASE_URL", "invalid-ollama");
  fetchMock = vi.fn(() => { throw new Error("No fetch or Ollama"); }); vi.stubGlobal("fetch", fetchMock);
  await start();
});
afterEach(async () => {
  await api?.close(); expect(fetchMock).not.toHaveBeenCalled(); expect(https.request).not.toHaveBeenCalled(); expect(dns.lookup).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await fs.rm(temp, { recursive: true, force: true });
});
describe("V12.5 HTTP boundary", () => {
  it.each(["0.0.0.0", "::", "::1", "localhost", "127.0.0.2", "", "example.com"])("rejects non-supported bind %j", host => {
    expect(() => controlConfig({ SCOUT_CONTROL_API_HOST: host, SCOUT_CONTROL_API_TOKEN: TOKEN })).toThrow();
  });
  it.each([undefined, "", "short", "x".repeat(257), " x".repeat(32), "é".repeat(40), "x".repeat(32) + "\n"])("requires explicit valid token %j", token => {
    expect(() => controlConfig({ SCOUT_CONTROL_API_TOKEN: token })).toThrow();
  });
  it.each(["-1", "65536", "01", "1.1", "Infinity", "NaN", "1e3", "", "+80"])("rejects port %j", port => expect(() => controlConfig({ SCOUT_CONTROL_API_TOKEN: TOKEN, SCOUT_CONTROL_API_PORT: port })).toThrow());
  it("binds literal loopback with public minimal health and secure headers", async () => {
    expect(api.host).toBe("127.0.0.1"); const r = await request("/v1/health", { token: null }); expect(r.status).toBe(200);
    expect(r.body).toEqual({ schema_version: 1, status: "ok", mode: "local", can_spend: false });
    expect(r.headers["cache-control"]).toBe("no-store"); expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-type"]).toContain("application/json"); expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });
  it("health creates no ledger on empty workspace; state returns safe unavailable", async () => {
    await fs.unlink(path.join(root, "economic-ledger.json")); expect((await request("/v1/health")).status).toBe(200);
    const r = await request("/v1/summary"); expect(r.status).toBe(503); expect(r.text).not.toContain(root); expect(await fs.readdir(root)).toEqual([]);
  });
  it.each(["/v1/summary", "/v1/projects", "/v1/attention", "/v1/approvals", "/v1/events", "/v1/allocation"])("protects read %s", async url => {
    expect((await request(url, { token: null })).status).toBe(401); expect((await request(url, { token: "w".repeat(40) })).status).toBe(401);
  });
  it("returns safe summary, null missing proposal and unknown financial outcomes", async () => {
    const p = await projectFixture(root); const before = await read(root, "economic-ledger.json");
    const r = await request("/v1/summary"); expect(r.status).toBe(200); expect(r.body).toMatchObject({ confirmed_available_cents: 9000, reserved_cents: 1000, confirmed_spent_cents: 0, total_proposed_cents: null, pending_approval_count: 1 });
    const project = (await request(`/v1/projects/${p.plan.project_id}`)).body.project;
    expect(project.confirmed_expense_cents).toBeNull(); expect(project.confirmed_revenue_cents).toBeNull();
    expect((await request("/v1/projects")).body.items).toEqual([project]); expect((await request(`/v1/projects/${id("project")}`)).status).toBe(404);
    expect(JSON.stringify([r.body, project])).not.toMatch(/SECRET_PROJECT_NAME|integrity-key|workspace|stack/);
    expect(await read(root, "economic-ledger.json")).toBe(before);
  });
  it("exposes V12 strictly as proposal and never changes it or V9 limits", async () => {
    await allocationFixture(root); const before = await read(root, "capital-allocation.json"), ledger = await read(root, "economic-ledger.json");
    const r = await request("/v1/allocation"); expect(r.status).toBe(200); expect(r.body.allocation).toMatchObject({ status: "PROPOSAL_ONLY", stale: false, total_proposed_cents: 2000, notice: "NO REAL MONEY WAS SPENT BY V12", approval_created: false });
    expect(r.body.allocation.out_of_budget_candidates[0].estimated_cost_cents).toBe(3500);
    expect((await request("/v1/attention")).body.items[0].event_type).toBe("OUT_OF_BUDGET_OPPORTUNITY");
    expect((await request("/v1/approvals")).body.items).toEqual([]); expect(await read(root, "capital-allocation.json")).toBe(before); expect(await read(root, "economic-ledger.json")).toBe(ledger);
    expect(PROJECT_LIMITS).toMatchObject({ MAX_ACTIVE_PROJECTS: 2, MAX_PROJECT_BUDGET_CENTS: 1000, MAX_BATCH_BUDGET_CENTS: 2000, MAX_EXPERIMENT_DURATION_DAYS: 7 });
  });
  it.each(["pay", "execute", "publish", "shell", "spend", "reserve", "capability", "tool/install"])("has no %s route", async name => {
    expect((await request(`/v1/${name}`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await request(`/${name}`, { method: "POST", body: "{}" })).status).toBeGreaterThanOrEqual(400);
  });
  it.each(["/v1/../economic-ledger.json", "/v1/projects/%2e%2e", "/v1/projects/..", "/v1//projects", "/v1/summary?token=secret", "/v1/summary?", "/v1/summary?x=1?y=2"])("rejects target %s", async url => expect((await request(url)).status).toBeGreaterThanOrEqual(400));
  it.each(["0", "101", "1000000000", "-1", "NaN", "Infinity", "1.5", "01", "1e2", ""]) ("rejects limit %j", async limit => expect((await request(`/v1/events?limit=${limit}`)).status).toBe(400));
  it.each(["after=1&after=1", "after=-1", "after=1.2", "after=9007199254740992", "limit=2&extra=1", "__proto__=x", "offset=1001"])("rejects query %s", async query => expect((await request(`/v1/events?${query}`)).status).toBe(400));
  it("rejects methods, cross-origin, rebinding Host, unexpected GET body", async () => {
    expect((await request("/v1/summary", { method: "DELETE" })).status).toBe(405);
    expect((await request("/v1/summary", { method: "POST" })).status).toBe(405);
    expect((await request("/v1/summary", { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await request("/v1/health", { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await request("/v1/summary", { body: "{}", headers: { "Content-Length": "2" } })).status).toBe(400);
  });
  it("rejects oversized ID and URL without reflecting them", async () => {
    const r = await request(`/v1/approvals/${"x".repeat(150)}/approve`, { method: "POST", body: "{}" }); expect(r.status).toBe(400); expect(r.text).not.toContain("x".repeat(30));
    expect((await request(`/v1/events?after=${"1".repeat(600)}`)).status).toBe(400);
  });
  it("honors the financial lock without stealing it or leaking filesystem errors", async () => {
    await fs.writeFile(path.join(root, ".economic-ledger.lock"), "held"); const r = await request("/v1/summary"); expect(r.status).toBe(503);
    expect(r.text).not.toMatch(/stack|Error:|\.ts:|workspace|scout-control-test/); expect(await read(root, ".economic-ledger.lock")).toBe("held");
  });
  it("paginates events deterministically, bounds cursors and lists", async () => {
    await projectFixture(root);
    const one = (await request("/v1/events?after=0&limit=1")).body;
    expect(one.items).toHaveLength(1); expect(one.next_after).toBe(1); expect(one.has_more).toBe(true);
    const two = (await request("/v1/events?after=1&limit=100")).body;
    expect(two.items.map((e: any) => e.sequence)).toEqual([2, 3]); expect(two.has_more).toBe(false);
    expect((await request("/v1/events?after=3")).body.items).toEqual([]);
    expect((await request("/v1/events?after=4")).status).toBe(409);
    expect((await request("/v1/projects?offset=1&limit=1")).body.items).toEqual([]);
  });
  it("simultaneous event polls lose no events or sequences", async () => {
    await projectFixture(root); const results = await Promise.all(Array.from({ length: 6 }, () => request("/v1/events")));
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(new Set(results.map(r => r.text)).size).toBe(1);
    expect(new Set(results[0].body.items.map((e: any) => e.sequence)).size).toBe(3);
  });
  it("two API instances share the financial lock and matching retry", async () => {
    const a = await approvalFixture(root), other = await startControlApi({ root, env: { SCOUT_CONTROL_API_TOKEN: TOKEN, SCOUT_CONTROL_API_PORT: "0" } });
    const first = api;
    try {
      const pendingFirst = decide(a.request_id); api = other; const pendingOther = decide(a.request_id);
      const results = await Promise.all([pendingFirst, pendingOther]);
      expect(results.some(r => r.status === 200)).toBe(true); expect(results.every(r => [200, 503].includes(r.status))).toBe(true);
      expect((await decide(a.request_id)).status).toBe(200);
      expect((await locked(root, () => readVerifiedApprovalRecords(root)))!).toHaveLength(1);
    } finally { api = first; await other.close(); }
  });
  it("shuts down, closes its port and restarts with unchanged cursors", async () => {
    await projectFixture(root); const first = (await request("/v1/events")).body; await api.close(); await api.close();
    await expect(new Promise((resolve, reject) => { const s = net.connect(api.port, "127.0.0.1"); s.on("connect", () => { s.destroy(); resolve(true); }); s.on("error", reject); })).rejects.toThrow();
    await start(); expect((await request("/v1/events")).body).toEqual(first);
  });
});
describe("V12.5 human decisions through V6", () => {
  it("lists safe V6 scope and requires correct token", async () => {
    const a = await approvalFixture(root); const listing = await request("/v1/approvals"); expect(listing.body.items[0]).toMatchObject({ request_id: a.request_id, status: "pending", scope: "experiment" });
    expect(listing.text).not.toMatch(/SECRET_FREEFORM|local-cli|experiment_hash|ledger_hash/);
    expect((await decide(a.request_id, "approve", null)).status).toBe(401); expect((await decide(a.request_id, "approve", "x".repeat(40))).status).toBe(401);
    expect((await locked(root, () => readVerifiedApprovalRecords(root)))![0].request.status).toBe("pending");
  });
  it.each(["approve", "deny"])("%s is idempotent and opposite decision conflicts", async kind => {
    const a = await approvalFixture(root, 10), ledger = await read(root, "economic-ledger.json");
    const first = await decide(a.request_id, kind); expect(first.status).toBe(200);
    const anchor = await fs.readFile(path.join(approvalStoreRoot(root), "state.json"), "utf8"), events = (await request("/v1/events")).text;
    const second = await decide(a.request_id, kind); expect(second).toMatchObject({ status: 200, body: first.body });
    expect(await fs.readFile(path.join(approvalStoreRoot(root), "state.json"), "utf8")).toBe(anchor); expect((await request("/v1/events")).text).toBe(events);
    expect((await decide(a.request_id, kind === "approve" ? "deny" : "approve")).status).toBe(409);
    expect(await read(root, "economic-ledger.json")).toBe(ledger); expect(first.body).toMatchObject({ action_executed: false, money_spent_cents: 0 });
  });
  it("simultaneous matching retries produce one V6 decision", async () => {
    const a = await approvalFixture(root); const results = await Promise.all(Array.from({ length: 4 }, () => decide(a.request_id)));
    expect(results.every(r => r.status === 200)).toBe(true); expect(new Set(results.map(r => JSON.stringify(r.body))).size).toBe(1);
    expect((await locked(root, () => readVerifiedApprovalRecords(root)))!.filter(r => r.decision).length).toBe(1);
  });
  it("concurrent approve/deny cannot create contradictory states", async () => {
    const a = await approvalFixture(root); const results = await Promise.all([decide(a.request_id), decide(a.request_id, "deny")]); expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  });
  it.each(["{", "null", "[]", "", '{"amount_cents":0.5}', '{"amount_cents":NaN}', '{"amount_cents":Infinity}', '{"capability":"shell"}', '{"__proto__":{"admin":true}}', '{"confirm":true,"confirm":false}', '{"token":"secret"}'])("rejects invalid body %j", async body => {
    const a = await approvalFixture(root); expect((await decide(a.request_id, "approve", TOKEN, body)).status).toBe(400);
    expect((await locked(root, () => readVerifiedApprovalRecords(root)))![0].request.status).toBe("pending");
  });
  it("rejects excessive and encoded bodies and wrong content type", async () => {
    const a = await approvalFixture(root), url = `/v1/approvals/${a.request_id}/approve`;
    expect((await decide(a.request_id, "approve", TOKEN, " ".repeat(1025))).status).toBe(413);
    expect((await request(url, { method: "POST", body: "{}", headers: { "Content-Type": "text/plain" } })).status).toBe(415);
    expect((await request(url, { method: "POST", body: "{}", headers: { "Content-Encoding": "gzip" } })).status).toBe(415);
  });
  it("unknown approval is a safe 404", async () => expect((await decide(id("request"))).body.error.code).toBe("APPROVAL_NOT_FOUND"));
  it("stale binding and superseded IDs remain rejected", async () => {
    const a = await approvalFixture(root); await inMode("approval", () => runApprovalScout({ root, command: { kind: "new-request" } })); expect((await decide(a.request_id)).status).toBe(409);
    const current = (await request("/v1/approvals")).body.items.at(-1);
    const p = JSON.parse(await read(root, "experiment.json")); p.actions = ["Different plan"]; await write(root, "experiment.json", p);
    expect((await decide(current.request_id)).status).toBe(409);
  });
  it.each(["approve", "deny"])("project %s uses canonical V9/V6 history once", async kind => {
    const p = await projectFixture(root), before = await read(root, "economic-ledger.json"); const requestId = p.approval.request.request_id;
    expect((await decide(requestId, kind)).status).toBe(200); expect((await decide(requestId, kind)).status).toBe(200);
    const project = (await request(`/v1/projects/${p.plan.project_id}`)).body.project; expect(project.status).toBe(kind === "approve" ? "approved" : "reserved");
    expect((await decide(requestId, kind === "approve" ? "deny" : "approve")).status).toBe(409); expect(await read(root, "economic-ledger.json")).toBe(before);
  });
  it("consumed project approval cannot be replayed", async () => {
    const p = await projectFixture(root), requestId = p.approval.request.request_id; await decide(requestId);
    await projectCommand(root, "--start-project", p.plan.project_id, "--experiment-id", p.experiment_id, "--request-id", requestId);
    expect((await decide(requestId)).status).toBe(409);
  });
  it("external approval uses V6 with endpoint binding, no gateway dispatch", async () => {
    vi.stubEnv("SCOUT_V8_WEBHOOK_URL", "https://hook.example/validation");
    await inMode("external", () => runExternalScout({ root, command: { kind: "prepare" } }));
    const r = (await request("/v1/approvals")).body.items[0], ledger = await read(root, "economic-ledger.json");
    expect(r.scope).toBe("external"); expect((await decide(r.request_id)).status).toBe(200); expect((await decide(r.request_id)).status).toBe(200);
    expect((await locked(root, () => readVerifiedExternalRecords(root)))[0].execution).toBeNull();
    vi.stubEnv("SCOUT_V8_WEBHOOK_URL", "https://other.example/validation"); expect((await decide(r.request_id)).status).toBe(409);
    expect(await read(root, "economic-ledger.json")).toBe(ledger);
  });
  it("a closed standalone V7 approval is consumed even with zero financial delta", async () => {
    const a = await approvalFixture(root); expect((await decide(a.request_id)).status).toBe(200);
    await inMode("revenue", () => runRevenueScout({ root, command: { experiment_id: a.experiment_id,
      expense_cents: 0, revenue_cents: 0, outcome: "cancelled", approval_request_id: null, preview: false } }));
    expect((await decide(a.request_id)).status).toBe(409);
  });
  it("CLI starts with no arguments, redacts token and exits cleanly on SIGTERM", async () => {
    const child = spawn(process.execPath, ["dist/index.js"], { cwd: process.cwd(), env: { ...process.env,
      SCOUT_MODE: "control-api", SCOUT_CONTROL_API_PORT: "0", SCOUT_CONTROL_API_TOKEN: TOKEN, OLLAMA_BASE_URL: "invalid" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stderr.on("data", s => { output += s; });
    const exit = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("CLI startup timeout")), 5000);
        child.stdout.on("data", s => { output += s; if (output.includes("Scout Control API listening on http://127.0.0.1:")) { clearTimeout(timer); resolve(); } });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("CLI exited before listening")); });
      });
      expect(output).not.toContain(TOKEN); expect(output).toContain("No spending or execution");
      child.kill("SIGTERM"); expect(await exit).toBe(0);
    } finally { if (child.exitCode === null) child.kill("SIGKILL"); }
  });
  it("tampered approval anchor leaks no keys in errors", async () => {
    await approvalFixture(root); const key = await fs.readFile(path.join(approvalStoreRoot(root), "integrity-key"), "utf8");
    await fs.writeFile(path.join(approvalStoreRoot(root), "state.json"), '{"private":"SECRET"}');
    const r = await request("/v1/summary"); expect(r.status).toBe(503); for (const secret of [key.trim(), TOKEN, root, "SECRET", "stack"]) expect(r.text).not.toContain(secret);
  });
});
