import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as https from "node:https";
import * as dns from "node:dns/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runProjectScout, parseProjectCommand, auditProjects } from "../agent/project-manager.js";
import { projectStoreRoot, PROJECT_FILES } from "../agent/project-store.js";
import { type Project, validateProjectCommand, canonicalHash, type ProjectEvent } from "../agent/project-model.js";
import { PROJECT_LIMITS, assetMetrics, integerCents } from "../agent/asset-lifecycle.js";
import { initializeLedger, parseEconomicLedger, recordAuthorizedEvent, reserveProjectReference, type EconomicLedger } from "../agent/economic-ledger.js";
import { parseProjectApproval } from "../agent/approval-gate.js";
import { runExternalScout, runExternalApprovalScout, parseExternalCommand } from "../agent/external-gateway.js";
import { createLocalWorkspaceTools } from "../agent/local-tools.js";
vi.mock("node:fs/promises", async original => { const actual = await original<typeof import("node:fs/promises")>(); return { ...actual, rename: vi.fn(actual.rename) }; });
vi.mock("node:https", async original => ({ ...await original<typeof import("node:https")>(), request: vi.fn(() => { throw new Error("Real HTTPS prohibited"); }) }));
vi.mock("node:dns/promises", async original => ({ ...await original<typeof import("node:dns/promises")>(), lookup: vi.fn(() => { throw new Error("Real DNS prohibited"); }) }));
let temp: string, root: string, fetchMock: ReturnType<typeof vi.fn>;
const id = (prefix: string) => `${prefix}-${randomUUID()}`;
const read = (name: string) => fs.readFile(path.join(root, name), "utf8");
const ledger = async () => parseEconomicLedger(await read("economic-ledger.json"));
const run = async (...args: string[]) => JSON.parse(await runProjectScout({ root, command: parseProjectCommand(args) }));
const all = () => run("--list-projects");
const inspect = async (p: Project) => (await run("--inspect-project", p.plan.project_id)).projects[0];
const target = (p: Project) => [p.plan.project_id, "--experiment-id", p.experiment_id];
const request = (p: Project) => ["--request-id", p.approval!.request.request_id];
async function batch() { return (await run("--create-batch")).batch.batch_id as string; }
async function create(b: string, name = "A", budget = "1000", days = "7") {
  return (await run("--create-project", b, "--name", name, "--hypothesis", "Test fictif de demande", "--budget-cents", budget, "--duration-days", days)).projects.at(-1) as Project;
}
async function reserve(p: Project) { await run("--reserve-project", ...target(p)); return inspect(p); }
async function decide(p: Project, kind = "approve", req = p.approval!.request.request_id) {
  vi.stubEnv("SCOUT_MODE", "approval");
  try { return await run(`--${kind}-project`, ...target(p), "--request-id", req); }
  finally { vi.stubEnv("SCOUT_MODE", "projects"); }
}
async function start(p: Project) { await decide(p); await run("--start-project", ...target(p), ...request(p)); return inspect(p); }
async function active(name = "A", b?: string) { return start(await reserve(await create(b ?? await batch(), name))); }
async function asset(p: Project) { await run("--create-asset", ...target(p)); return inspect(p); }
const closeArgs = (p: Project, expense = "600", revenue = "400", policy = "keep", classification = "inconclusive") => ["--close-experiment", ...target(p), ...request(p), "--expense-cents", expense, "--revenue-cents", revenue, "--classification", classification, "--asset-policy", policy];
const passiveArgs = (p: Project, receipt = id("receipt"), amount = "1300") => ["--record-passive-revenue", ...target(p), "--asset-id", p.asset!.asset_id, "--receipt-id", receipt, "--revenue-cents", amount];
async function closed() { const p = await asset(await active()); await run(...closeArgs(p)); return inspect(p); }
async function snapshot() {
  const publicFiles = await fs.readdir(root), privateFiles = await fs.readdir(projectStoreRoot(root)).catch(() => []);
  return { public: await Promise.all(publicFiles.map(async n => [n, await read(n)])),
    private: await Promise.all(privateFiles.map(async n => [n, await fs.readFile(path.join(projectStoreRoot(root), n), "utf8")])) };
}
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v9-")); root = path.join(temp, "workspace"); await fs.mkdir(root);
  await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(initializeLedger(10000)));
  vi.stubEnv("SCOUT_MODE", "projects"); vi.stubEnv("OLLAMA_BASE_URL", "invalid");
  vi.stubEnv("SCOUT_V8_WEBHOOK_URL", "https://hook.example/test");
  fetchMock = vi.fn(() => { throw new Error("Network/Ollama forbidden"); }); vi.stubGlobal("fetch", fetchMock);
  vi.mocked(fs.rename).mockClear(); vi.mocked(https.request).mockClear(); vi.mocked(dns.lookup).mockClear();
});
afterEach(async () => {
  expect(fetchMock).not.toHaveBeenCalled(); expect(https.request).not.toHaveBeenCalled(); expect(dns.lookup).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); await fs.rm(temp, { recursive: true, force: true });
});

describe("V9 hard runtime bounds and strict commands", () => {
  it("creates one explicit batch, two independent 1000-cent projects and reserves exactly 2000", async () => {
    const b = await batch(), a = await reserve(await create(b)), other = await reserve(await create(b, "B"));
    expect(a.experiment_id).not.toBe(other.experiment_id); expect(a.approval!.request.request_id).not.toBe(other.approval!.request.request_id);
    expect(a.approval_scope!.reservation_reference!.entry_id).not.toBe(other.approval_scope!.reservation_reference!.entry_id);
    expect(await ledger()).toMatchObject({ available_balance_cents: 8000, reserved_balance_cents: 2000, total_recorded_expenses_cents: 0 });
    expect((await all()).batch).toMatchObject({ max_projects: 2, max_total_budget_cents: 2000, status: "prepared" });
    const before = await snapshot(); await expect(create(b, "C")).rejects.toThrow("two projects"); await expect(batch()).rejects.toThrow("already exists"); expect(await snapshot()).toEqual(before);
    expect(PROJECT_LIMITS).toMatchObject({ MAX_ACTIVE_PROJECTS: 2, MAX_PROJECT_BUDGET_CENTS: 1000, MAX_BATCH_BUDGET_CENTS: 2000, MAX_EXPERIMENT_DURATION_DAYS: 7 });
  });
  it("requires existing V5 ledger and explicit batch; creates neither implicitly", async () => {
    await expect(create(id("batch"))).rejects.toThrow("Create batch");
    await fs.unlink(path.join(root, "economic-ledger.json")); await expect(batch()).rejects.toThrow("Initialize existing V5");
  });
  it.each(["1001", "2000", "2001", "1000000001", "999999999999999999", "-1", "-0", "1.2", "1e3", "0x10", "Infinity", "NaN", "01", "+1", "1 ", ""])("rejects budget %j without mutation", async amount => {
    const b = await batch(), before = await snapshot(); await expect(create(b, "A", amount)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
  });
  it.each(["0", "8", "30", "-1", "7.0", "1e0", "NaN", "Infinity"])("refuses duration %j", async days => { await expect(create(await batch(), "A", "1000", days)).rejects.toThrow(); });
  it.each(["latest", "current", "all", "*", "yes", "../outside", "", "project-123"])("requires exact project IDs: %j", value => {
    expect(() => parseProjectCommand(["--cancel-project", value, "--experiment-id", "a".repeat(64)])).toThrow();
  });
  it.each([NaN, Infinity, -Infinity, 1.5, -1, -0, Number.MAX_SAFE_INTEGER, "10", null])("refuses invalid host money %j", v => { expect(() => integerCents(v)).toThrow(); });
  it("rejects unknown/duplicate fields, broad capabilities and runtime limit overrides", async () => {
    const b = await batch();
    for (const extra of [["--max-projects", "3"], ["--max-total-budget-cents", "2001"], ["--url", "https://x.example"], ["--capability", "payment"]]) expect(() => parseProjectCommand(["--create-batch", ...extra])).toThrow();
    expect(() => parseProjectCommand(["--create-project", b, "--name", "A", "--name", "B"])).toThrow();
    expect(() => parseProjectCommand(["--create-batch", "--preview", "--preview"])).toThrow();
    expect(() => validateProjectCommand({ ...parseProjectCommand(["--create-batch"]), amount: 100 } as any)).toThrow();
    expect(() => validateProjectCommand({ ...parseProjectCommand(["--create-batch"]), preview: "yes" } as any)).toThrow();
    vi.stubEnv("MAX_ACTIVE_PROJECTS", "100"); vi.stubEnv("MAX_BATCH_BUDGET_CENTS", "999999");
    await create(b); await create(b, "B"); await expect(create(b, "C")).rejects.toThrow();
  });
  it("refuses duplicate names, reservations, stale exact IDs and unaffordable reservation", async () => {
    const b = await batch(), p = await create(b); await expect(create(b)).rejects.toThrow("Duplicate");
    await expect(run("--reserve-project", p.plan.project_id, "--experiment-id", "0".repeat(64))).rejects.toThrow("matching");
    const r = await reserve(p); await expect(reserve(r)).rejects.toThrow();
    const bProject = await create(b, "B");
    // Genuine unrelated V5 reservation consumes capital, but never grants B funds.
    let l = await ledger();
    for (let n = 0; n < 9; n++) l = reserveProjectReference(l, { id: canonicalHash(n), name: `legacy ${n}`, budget_cents: 1000, requires_real_spending: true, requires_human_approval: true });
    await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(l)); await expect(reserve(bProject)).rejects.toThrow("unaffordable");
  });
  it("supports exact sub-euro cents and zero-cost projects without fake reservations", async () => {
    const b = await batch(), p = await reserve(await create(b, "A", "123")); expect((await ledger()).reserved_balance_cents).toBe(123);
    const zero = await start(await reserve(await create(b, "B", "0"))); expect(zero.approval_scope.reservation_reference).toBeNull();
    await run(...closeArgs(zero, "0", "29", "retire")); expect((await inspect(zero)).metrics.lifetime_net_result_cents).toBe(29);
    expect((await ledger()).reserved_balance_cents).toBe(p.plan.budget_cents);
  });
});

describe("V9 V6 isolation, time and lifecycle", () => {
  it("approval A never authorizes B; B reservation does not stale A approval", async () => {
    const b = await batch(), a = await reserve(await create(b)); await decide(a);
    const other = await reserve(await create(b, "B"));
    await expect(decide(other, "approve", a.approval.request.request_id)).rejects.toThrow("Exact pending");
    await expect(run("--start-project", ...target(other), ...request(a))).rejects.toThrow();
    expect(() => parseProjectApproval(a.approval, other.approval_scope)).toThrow("scope mismatch");
    await run("--start-project", ...target(a), ...request(a)); expect((await inspect(a)).status).toBe("active");
    await expect(run("--approve-project", ...target(other), ...request(other))).rejects.toThrow("SCOUT_MODE=approval");
  });
  it("denial blocks start, explicit cancellation releases only its reservation", async () => {
    const b = await batch(), a = await reserve(await create(b)), other = await reserve(await create(b, "B")); await decide(a, "deny");
    await expect(run("--start-project", ...target(a), ...request(a))).rejects.toThrow();
    await expect(decide(a)).rejects.toThrow(); await run("--cancel-project", ...target(a));
    expect((await ledger()).reserved_balance_cents).toBe(1000); expect((await inspect(other)).status).toBe("reserved");
    await expect(reserve(a)).rejects.toThrow(); await expect(run("--cancel-project", ...target(a))).rejects.toThrow();
  });
  it("refuses invalid transitions and does not interpret model approval text", async () => {
    const p = await create(await batch()); await fs.writeFile(path.join(root, "model-response.json"), JSON.stringify({ approved: true, project_id: p.plan.project_id }));
    await expect(run("--create-asset", ...target(p))).rejects.toThrow("not active");
    await expect(run("--start-project", ...target(p), "--request-id", id("request"))).rejects.toThrow();
    await expect(run(...closeArgs({ ...p, approval: { request: { request_id: id("request") } } } as any, "0", "0", "retire"))).rejects.toThrow();
  });
  it("expires at exactly seven days, blocks activity, permits explicit close and preserves asset", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date());
    const p = await asset(await active()), started = Date.parse(p.started_at!);
    expect(Date.parse(p.experiment_deadline!) - started).toBe(7 * 86400000);
    vi.setSystemTime(started + 7 * 86400000 - 1); expect((await inspect(p)).timing.activity).toBe("active");
    vi.setSystemTime(started + 7 * 86400000); const expired = await inspect(p); expect(expired.timing).toEqual({ activity: "expired", closable: true });
    await expect(run("--activate-asset", ...target(p), "--asset-id", p.asset!.asset_id)).rejects.toThrow("expired");
    await run(...closeArgs(p)); expect((await inspect(p)).asset.status).toBe("passive_monitoring");
  });
  it("refuses a backwards runtime clock", async () => {
    const p = await active(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(p.started_at!) - 1000);
    await expect(inspect(p)).rejects.toThrow("Clock moved backwards");
  });
  it("creates at most one exact asset; unknown/cross-project asset IDs are refused", async () => {
    const p = await asset(await active()); await expect(asset(p)).rejects.toThrow("one initial asset");
    await expect(run("--activate-asset", ...target(p), "--asset-id", id("asset"))).rejects.toThrow("Exact created");
    await run("--activate-asset", ...target(p), "--asset-id", p.asset!.asset_id); expect((await inspect(p)).asset.status).toBe("active");
    await expect(run("--activate-asset", ...target(p), "--asset-id", p.asset!.asset_id)).rejects.toThrow();
  });
  it.each(["successful", "failed", "inconclusive", "cancelled"])("classification %s does not destroy the asset", async classification => {
    const p = await asset(await active()); await run(...closeArgs(p, "600", "400", "keep", classification));
    expect((await inspect(p))).toMatchObject({ status: "experiment_closed", asset: { status: "passive_monitoring" }, result: { classification } });
  });
  it("keeps J+7 result immutable while J+30 passive income produces +1100 lifetime and B stays independent", async () => {
    const b = await batch(), a = await asset(await active("A", b)), other = await active("B", b), bBefore = await inspect(other);
    await fs.writeFile(path.join(root, "experiment-result.json"), "existing V7 snapshot");
    await run(...closeArgs(a)); const closedA = await inspect(a), result = JSON.stringify(closedA.result);
    expect(closedA.metrics).toMatchObject({ experiment_expense_cents: 600, experiment_revenue_cents: 400, lifetime_net_result_cents: -200 });
    await run(...passiveArgs(closedA)); const later = await inspect(a);
    expect(JSON.stringify(later.result)).toBe(result); expect(later.metrics).toEqual({ experiment_expense_cents: 600, experiment_revenue_cents: 400, post_experiment_revenue_cents: 1300, lifetime_revenue_cents: 1700, lifetime_net_result_cents: 1100 });
    expect(await inspect(other)).toEqual(bBefore); expect(await read("experiment-result.json")).toBe("existing V7 snapshot");
    expect(await ledger()).toMatchObject({ available_balance_cents: 10100, reserved_balance_cents: 1000, total_recorded_expenses_cents: 600, total_recorded_revenue_cents: 1700 });
    await expect(run(...closeArgs(other).map(v => v === other.experiment_id ? a.experiment_id : v))).rejects.toThrow("matching");
    await expect(run(...closeArgs(a))).rejects.toThrow(); await expect(reserve(a)).rejects.toThrow();
    await expect(run("--start-project", ...target(a), ...request(a))).rejects.toThrow();
  });
  it("explicit retirement stops passive income and never reopens/spends", async () => {
    const p = await closed(), before = await read("economic-ledger.json");
    await run("--retire-asset", ...target(p), "--asset-id", p.asset.asset_id);
    expect((await inspect(p))).toMatchObject({ status: "fully_closed", asset: { status: "retired" } }); expect(await read("economic-ledger.json")).toBe(before);
    await expect(run(...passiveArgs(p))).rejects.toThrow("passive asset"); await expect(asset(p)).rejects.toThrow();
  });
  it("zero assets can close explicitly; keep is refused without an asset", async () => {
    const p = await active(); await expect(run(...closeArgs(p, "0", "0", "keep"))).rejects.toThrow("No asset");
    await run(...closeArgs(p, "0", "0", "retire")); expect((await inspect(p))).toMatchObject({ status: "fully_closed", asset: null });
  });
  it("rejects overflow, expense over budget and passive receipt reuse globally", async () => {
    expect(() => assetMetrics(0, 1000000000, 1)).toThrow();
    const b = await batch(), a = await asset(await active("A", b)), other = await asset(await active("B", b));
    await expect(run(...closeArgs(a, "1001"))).rejects.toThrow("exceeds");
    await run(...closeArgs(a)); await run(...closeArgs(other)); const receipt = id("receipt");
    await run(...passiveArgs(a, receipt)); await expect(run(...passiveArgs(a, receipt))).rejects.toThrow("Duplicate");
    await expect(run(...passiveArgs(other, receipt))).rejects.toThrow("Duplicate");
    await expect(run(...passiveArgs(a, id("receipt"), "1000000000"))).rejects.toThrow();
  });
});

describe("V9 preview, integrity and concurrency", () => {
  it("all economic previews preserve public/private bytes and generate no reusable approval", async () => {
    let before = await snapshot(); await run("--create-batch", "--preview"); expect(await snapshot()).toEqual(before);
    const p = await create(await batch()); before = await snapshot(); await run("--reserve-project", ...target(p), "--preview"); expect(await snapshot()).toEqual(before);
    const r = await reserve(p); before = await snapshot(); vi.stubEnv("SCOUT_MODE", "approval");
    await run("--approve-project", ...target(r), ...request(r), "--preview"); vi.stubEnv("SCOUT_MODE", "projects"); expect(await snapshot()).toEqual(before);
    const a = await asset(await start(r)); before = await snapshot(); await run(...closeArgs(a), "--preview"); expect(await snapshot()).toEqual(before);
    await run(...closeArgs(a)); before = await snapshot(); await run(...passiveArgs(a), "--preview"); expect(await snapshot()).toEqual(before);
  });
  it.each(PROJECT_FILES)("refuses altered public view %s", async name => {
    await batch(); await fs.appendFile(path.join(root, name), " "); await expect(all()).rejects.toThrow("Modified");
  });
  it.each(["project_id", "experiment_id", "budget_cents", "approval", "asset", "status"])("manual %s edit cannot authorize any mutation", async field => {
    const p = await asset(await active()), raw = JSON.parse(await read("projects.json")); raw.projects[0][field] = "forged";
    await fs.writeFile(path.join(root, "projects.json"), JSON.stringify(raw)); await expect(run(...closeArgs(p))).rejects.toThrow("Modified");
  });
  it("authenticates history and detects rehashed financial history changes", async () => {
    const p = await reserve(await create(await batch())), l = await ledger();
    l.entries[1].description = "tampered"; const { hash, ...payload } = l.entries[1]; l.entries[1].hash = canonicalHash(payload);
    await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(l)); await expect(inspect(p)).rejects.toThrow("prefix mismatch");
  });
  it("rejects an otherwise valid untracked V5 spend of another project's reservation", async () => {
    const p = await reserve(await create(await batch())), l = recordAuthorizedEvent(await ledger(), { type: "expense", amount_cents: 1,
      experiment_id: p.experiment_id, description: "Out of band", authorization: { source: "human", reference: "manual-out-of-band" } });
    await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(l)); await expect(inspect(p)).rejects.toThrow("Untracked mutation");
  });
  it.each(["state.json", "integrity-key"])("missing private %s is never regenerated", async name => {
    await batch(); await fs.unlink(path.join(projectStoreRoot(root), name)); await expect(all()).rejects.toThrow("Incomplete project anchor");
  });
  it("rejects private HMAC tampering, repeated events and unknown event fields", async () => {
    await batch(); const file = path.join(projectStoreRoot(root), "state.json"), raw = JSON.parse(await fs.readFile(file, "utf8"));
    const l = await ledger(); expect(() => auditProjects([...raw.events, ...raw.events], l)).toThrow("Duplicate");
    expect(() => auditProjects([{ ...raw.events[0], forged: true }], l)).toThrow("fields");
    raw.events[0].new_id = id("batch"); await fs.writeFile(file, JSON.stringify(raw)); await expect(all()).rejects.toThrow("authentication");
  });
  it.each([...PROJECT_FILES, "economic-ledger.json", "economic-report.txt"])("rejects public symlink/hardlink %s", async name => {
    const p = await create(await batch()), outside = path.join(temp, "outside"); await fs.writeFile(outside, "untouched");
    await fs.rm(path.join(root, name), { force: true }); await fs.symlink(outside, path.join(root, name)); await expect(reserve(p)).rejects.toThrow();
    await fs.unlink(path.join(root, name)); await fs.link(outside, path.join(root, name)); await expect(reserve(p)).rejects.toThrow(); expect(await fs.readFile(outside, "utf8")).toBe("untouched");
  });
  it.each(["state.json", "integrity-key"])("rejects private symlink/hardlink %s", async name => {
    await batch(); const file = path.join(projectStoreRoot(root), name), outside = path.join(temp, "outside"); await fs.rename(file, outside);
    await fs.symlink(outside, file); await expect(all()).rejects.toThrow(); await fs.unlink(file); await fs.link(outside, file); await expect(all()).rejects.toThrow();
  });
  it("generic writes cannot alter any V9 artifact or access private anchor", async () => {
    await batch(); const tools = createLocalWorkspaceTools(root), writeTool = tools.find(t => t.name === "write_file")!, readTool = tools.find(t => t.name === "read_file")!;
    for (const name of [...PROJECT_FILES, ".project-temp.json", "sub/assets.json"]) expect(await (writeTool.execute as any)({ path: name, content: "forged" })).toContain("runtime-controlled");
    for (const op of [readTool, writeTool]) expect(await (op.execute as any)({ path: path.relative(root, path.join(projectStoreRoot(root), "integrity-key")), content: "forged" })).toContain("ERROR");
  });
  it("intent atomic rename failure preserves prior bytes", async () => {
    const p = await create(await batch()), before = await snapshot(); vi.mocked(fs.rename).mockRejectedValueOnce(new Error("disk failure"));
    await expect(reserve(p)).rejects.toThrow("disk failure"); expect(await snapshot()).toEqual(before);
  });
  it("failure after intent leaves ledger unchanged and blocks replay", async () => {
    const p = await create(await batch()), before = await read("economic-ledger.json"), real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementationOnce(real.rename).mockRejectedValueOnce(new Error("ledger rename failure"));
    await expect(reserve(p)).rejects.toThrow(); expect(await read("economic-ledger.json")).toBe(before); await expect(reserve(p)).rejects.toThrow("Incomplete project transaction");
  });
  it("failure after ledger commit never repeats expense/revenue", async () => {
    const p = await asset(await active()), real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementationOnce(real.rename).mockImplementationOnce(real.rename).mockRejectedValueOnce(new Error("view failure"));
    await expect(run(...closeArgs(p))).rejects.toThrow(); const before = await read("economic-ledger.json");
    expect((await ledger()).total_recorded_expenses_cents).toBe(600); await expect(run(...closeArgs(p))).rejects.toThrow("Incomplete project transaction"); expect(await read("economic-ledger.json")).toBe(before);
  });
  it("concurrent project creation: one wins; retry explicitly then reject third", async () => {
    const b = await batch(), results = await Promise.allSettled([create(b, "A"), create(b, "B")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    await create(b, "second"); await expect(create(b, "third")).rejects.toThrow("two projects");
  });
  it("concurrent closure, same-project mutation and double passive revenue have one winner each", async () => {
    const p = await active(), creations = await Promise.allSettled([asset(p), asset(p)]); expect(creations.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const a = await inspect(p), closes = await Promise.allSettled([run(...closeArgs(a)), run(...closeArgs(a))]); expect(closes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const args = passiveArgs(a), revenues = await Promise.allSettled([run(...args), run(...args)]); expect(revenues.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await expect(run(...args)).rejects.toThrow("Duplicate"); expect((await inspect(p)).metrics.post_experiment_revenue_cents).toBe(1300);
  });
  it("never steals shared V5/V6/V7/V8 stale lock", async () => {
    await fs.writeFile(path.join(root, ".economic-ledger.lock"), "stale"); await expect(batch()).rejects.toThrow("locked"); expect(await read(".economic-ledger.lock")).toBe("stale");
  });
});

describe("V9 additional fail-closed boundaries", () => {
  it.each(["1.2", "-1", "-0", "1e3", "NaN", "Infinity", "1000000001", "01"])("rejects close/passive amount %j", async value => {
    const p = await closed(), before = await snapshot();
    await expect(run(...closeArgs(p, value))).rejects.toThrow();
    await expect(run(...passiveArgs(p, id("receipt"), value))).rejects.toThrow(); expect(await snapshot()).toEqual(before);
  });
  it("passive receipts cannot target another project's experiment or asset", async () => {
    const b = await batch(), a = await asset(await active("A", b)), other = await asset(await active("B", b));
    await run(...closeArgs(a)); await run(...closeArgs(other));
    await expect(run(...passiveArgs(a).map(v => v === a.plan.project_id ? other.plan.project_id : v))).rejects.toThrow("matching");
    await expect(run(...passiveArgs(other).map(v => v === other.asset.asset_id ? a.asset.asset_id : v))).rejects.toThrow("passive asset");
    expect((await inspect(other)).metrics.post_experiment_revenue_cents).toBe(0);
  });
  it("cancel preview does not release funds and closed projects never free a batch slot", async () => {
    const b = await batch(), a = await reserve(await create(b)), other = await create(b, "B"), before = await snapshot();
    await run("--cancel-project", ...target(a), "--preview"); expect(await snapshot()).toEqual(before);
    await run("--cancel-project", ...target(a)); await run("--cancel-project", ...target(other));
    await expect(create(b, "C")).rejects.toThrow("two projects"); expect((await ledger()).available_balance_cents).toBe(10000);
  });
  it("refuses nonprivate anchor permissions and missing state directory with orphan views", async () => {
    await batch(); const store = projectStoreRoot(root); await fs.chmod(store, 0o755); await expect(all()).rejects.toThrow("private");
    await fs.chmod(store, 0o700); await fs.chmod(path.join(store, "integrity-key"), 0o644); await expect(all()).rejects.toThrow("private");
    await fs.chmod(path.join(store, "integrity-key"), 0o600); await fs.rename(store, path.join(temp, "saved-anchor")); await expect(all()).rejects.toThrow("orphan");
    await expect(batch()).rejects.toThrow("orphan");
  });
  it("refuses symlink workspace/anchor directories and oversized history", async () => {
    await batch(); const store = projectStoreRoot(root), moved = path.join(temp, "saved-anchor"); await fs.rename(store, moved); await fs.symlink(moved, store);
    await expect(all()).rejects.toThrow("unsafe"); await fs.unlink(store); await fs.rename(moved, store);
    const raw = JSON.parse(await fs.readFile(path.join(store, "state.json"), "utf8"));
    expect(() => auditProjects(Array(PROJECT_LIMITS.MAX_EVENTS + 1).fill(raw.events[0]), initializeLedger(10000))).toThrow("event limit");
    await fs.appendFile(path.join(store, "state.json"), " ".repeat(PROJECT_LIMITS.MAX_BYTES)); await expect(all()).rejects.toThrow("oversized");
    await fs.rename(root, path.join(temp, "saved-workspace")); await fs.symlink(path.join(temp, "saved-workspace"), root); await expect(all()).rejects.toThrow("unsafe");
  });
  it("preview never overrides an invalid ledger even for metadata-only commands", async () => {
    const b = await batch(), l = await ledger(); l.available_balance_cents = 999999;
    await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(l));
    await expect(run("--create-project", b, "--name", "A", "--hypothesis", "Test", "--budget-cents", "0", "--duration-days", "1", "--preview")).rejects.toThrow("total mismatch");
  });
});

describe("V9 exact optional V8 linkage and offline CLI", () => {
  const transport = () => ({ resolve: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
    ping: vi.fn().mockImplementation(async () => ({ status: 200, headers: {}, body: (async function* () { yield Buffer.from("{}"); })(), close: vi.fn() })) });
  async function prepareExternal() {
    vi.stubEnv("SCOUT_MODE", "external"); await runExternalScout({ root, command: { kind: "prepare" } }); vi.stubEnv("SCOUT_MODE", "projects");
    return { action: JSON.parse(await read("external-action.json")), request: JSON.parse(await read("external-approval-request.json")) };
  }
  async function approveExternal(r: any) {
    vi.stubEnv("SCOUT_MODE", "approval"); await runExternalApprovalScout({ root, args: ["--approve-external", r.request.request_id] }); vi.stubEnv("SCOUT_MODE", "projects");
  }
  it("binds A's pending action once; cannot relink B or execute with B/unscoped authorization", async () => {
    const b = await batch(), a = await active("A", b), other = await active("B", b), r = await prepareExternal();
    const link = ["--action-id", r.action.action_id, "--request-id", r.request.request_id];
    await run("--link-external-action", ...target(a), ...link); await expect(run("--link-external-action", ...target(other), ...link)).rejects.toThrow("already bound");
    await approveExternal(r); vi.stubEnv("SCOUT_MODE", "external"); const t = transport();
    const base = { kind: "execute" as const, actionId: r.action.action_id, requestId: r.request.request_id, preview: false };
    await expect(runExternalScout({ root, command: base, transport: t })).rejects.toThrow("binding required");
    await expect(runExternalScout({ root, command: { ...base, projectId: other.plan.project_id, experimentId: other.experiment_id }, transport: t })).rejects.toThrow("binding required");
    expect(t.resolve).not.toHaveBeenCalled();
    await runExternalScout({ root, command: { ...base, projectId: a.plan.project_id, experimentId: a.experiment_id }, transport: t }); expect(t.ping).toHaveBeenCalledTimes(1);
    await expect(runExternalScout({ root, command: { ...base, projectId: a.plan.project_id, experimentId: a.experiment_id }, transport: t })).rejects.toThrow("replay");
  });
  it.each(["expired", "closed"])("blocks linked V8 action when project is %s without network", async state => {
    const a = await active(), r = await prepareExternal(); await run("--link-external-action", ...target(a), "--action-id", r.action.action_id, "--request-id", r.request.request_id); await approveExternal(r);
    if (state === "closed") await run(...closeArgs(a, "0", "0", "retire"));
    else { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(a.experiment_deadline)); }
    vi.stubEnv("SCOUT_MODE", "external"); const t = transport();
    await expect(runExternalScout({ root, transport: t, command: { kind: "execute", actionId: r.action.action_id, requestId: r.request.request_id, projectId: a.plan.project_id, experimentId: a.experiment_id, preview: false } })).rejects.toThrow("not active or expired");
    expect(t.resolve).not.toHaveBeenCalled(); expect(t.ping).not.toHaveBeenCalled(); await expect(fs.stat(path.join(root, "external-execution.json"))).rejects.toThrow();
  });
  it("rejects wrong V8 request and refuses economic approval as V8 approval", async () => {
    const a = await active(), r = await prepareExternal();
    await expect(run("--link-external-action", ...target(a), "--action-id", r.action.action_id, ...request(a))).rejects.toThrow("pending unattempted");
    vi.stubEnv("SCOUT_MODE", "external"); const t = transport();
    await expect(runExternalScout({ root, transport: t, command: { kind: "execute", actionId: r.action.action_id, requestId: a.approval.request.request_id, preview: false } })).rejects.toThrow("approved V6"); expect(t.ping).not.toHaveBeenCalled();
    expect(() => parseExternalCommand(["--execute", r.action.action_id, "--approval-request-id", r.request.request_id, "--project-id", "latest", "--experiment-id", a.experiment_id])).toThrow();
  });
  it("actual V9 CLI builds metadata offline without Ollama and refuses implicit modes", async () => {
    const cliRoot = path.join(temp, ".automaton", "scout-workspace"); await fs.mkdir(cliRoot, { recursive: true });
    await fs.writeFile(path.join(cliRoot, "economic-ledger.json"), JSON.stringify(initializeLedger(10000)));
    const cli = (args: string[], mode = "projects") => promisify(execFile)(process.execPath, ["dist/index.js", ...args], {
      cwd: process.cwd(), env: { ...process.env, HOME: temp, SCOUT_MODE: mode, OLLAMA_BASE_URL: "invalid" }, timeout: 10000 });
    const b = JSON.parse((await cli(["--create-batch"])).stdout).batch.batch_id;
    const p = JSON.parse((await cli(["--create-project", b, "--name", "CLI", "--hypothesis", "Fiction", "--budget-cents", "1000", "--duration-days", "7"])).stdout).projects[0];
    const r = JSON.parse((await cli(["--reserve-project", ...target(p)])).stdout).projects[0];
    await expect(cli(["--approve-project", ...target(r), ...request(r)])).rejects.toThrow();
    await cli(["--approve-project", ...target(r), ...request(r)], "approval");
    expect(JSON.parse((await cli(["--inspect-project", p.plan.project_id])).stdout).projects[0].status).toBe("approved");
    await expect(cli(["--run"])).rejects.toThrow(); await expect(cli(["--list-projects", "all"])).rejects.toThrow();
    expect((await cli(["--help"])).stdout).toContain("NO REAL MONEY IS SPENT BY V9");
  });
});
