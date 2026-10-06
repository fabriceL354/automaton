import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as https from "node:https";
import * as dns from "node:dns/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runProjectScout, parseProjectCommand, readProjectContext } from "../agent/project-manager.js";
import { projectStoreRoot } from "../agent/project-store.js";
import { type Project } from "../agent/project-model.js";
import { runMonitoringScout, parseMonitoringCommand, auditObservations } from "../agent/experiment-monitor.js";
import { MONITORING_LIMITS, parseObservationData, boundedInteger, checkpointSchedule, validateMonitoringCommand, type ObservationEvent } from "../agent/monitoring-model.js";
import { observationStoreRoot, MONITORING_FILES, loadObservationState } from "../agent/observation-store.js";
import { initializeLedger, parseEconomicLedger, recordAuthorizedEvent } from "../agent/economic-ledger.js";
import { runExternalScout, runExternalApprovalScout } from "../agent/external-gateway.js";
import { createLocalWorkspaceTools } from "../agent/local-tools.js";
vi.mock("node:fs/promises", async original => { const actual = await original<typeof import("node:fs/promises")>(); return { ...actual, rename: vi.fn(actual.rename) }; });
vi.mock("node:https", async original => ({ ...await original<typeof import("node:https")>(), request: vi.fn(() => { throw new Error("Real network prohibited"); }) }));
vi.mock("node:dns/promises", async original => ({ ...await original<typeof import("node:dns/promises")>(), lookup: vi.fn(() => { throw new Error("Real DNS prohibited"); }) }));
let temp: string, root: string, a: Project, b: Project, fetchMock: ReturnType<typeof vi.fn>;
const startTime = "2026-10-06T12:00:00.000Z", day = 86400000;
const setDay = (n: number) => vi.setSystemTime(Date.parse(startTime) + n * day);
const read = (name: string) => fs.readFile(path.join(root, name), "utf8");
const ledger = async () => parseEconomicLedger(await read("economic-ledger.json"));
const target = (p: Project) => [p.plan.project_id, "--experiment-id", p.experiment_id];
async function project(...args: string[]) {
  vi.stubEnv("SCOUT_MODE", ["--approve-project", "--deny-project"].includes(args[0]) ? "approval" : "projects");
  try { return JSON.parse(await runProjectScout({ root, command: parseProjectCommand(args) })); } finally { vi.stubEnv("SCOUT_MODE", "monitoring"); }
}
const inspect = async (p: Project) => (await project("--inspect-project", p.plan.project_id)).projects[0] as Project;
const run = async (...args: string[]) => runMonitoringScout({ root, command: parseMonitoringCommand(args) });
const status = (p = a) => run("--status", ...target(p));
const observe = (p: Project, type: string, ...fields: string[]) => run("--record-observation", ...target(p), "--type", type, ...fields);
const claim = (p = a, type = "sale_claim", amount = "800") => observe(p, type, "--amount-cents", amount);
const checkpoint = (p: Project, name: string, preview = false) => run("--checkpoint", ...target(p), "--checkpoint", name, ...(preview ? ["--preview"] : []));
const note = (p = a, value = "Observation humaine") => observe(p, "note", "--note", value);
const assetObservation = (p: Project, type: string, ...fields: string[]) => run("--asset-observation", ...target(p), "--asset-id", p.asset!.asset_id, "--type", type, ...fields);
const reconcile = (p: Project, observation: string, entry: string, preview = false) => run("--reconcile-observation", ...target(p), "--observation-id", observation, "--ledger-entry-id", entry, ...(preview ? ["--preview"] : []));
async function close(p = a, expense = "0", revenue = "800", keep = true) {
  await project("--close-experiment", ...target(p), "--request-id", p.approval!.request.request_id, "--expense-cents", expense, "--revenue-cents", revenue,
    "--classification", "inconclusive", "--asset-policy", keep ? "keep" : "retire"); return inspect(p);
}
async function financialEntry(p: Project, type: "revenue" | "expense") { return (await ledger()).entries.find(e => p.result?.ledger_entry_ids.includes(e.id) && e.type === type)!; }
async function tree(directory: string): Promise<unknown> {
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  return Promise.all(names.map(async n => { const full = path.join(directory, n), stat = await fs.lstat(full); return [n, stat.isDirectory() ? await tree(full) : await fs.readFile(full, "utf8")]; }));
}
async function authorities() {
  return { public: await Promise.all(["economic-ledger.json", "projects.json", "assets.json", "project-batch.json", "project-report.txt"].map(read)), private: await tree(projectStoreRoot(root)) };
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(startTime));
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v10-")); root = path.join(temp, "workspace"); await fs.mkdir(root);
  await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(initializeLedger(10000)));
  vi.stubEnv("SCOUT_MODE", "monitoring"); vi.stubEnv("OLLAMA_BASE_URL", "invalid"); vi.stubEnv("SCOUT_V8_WEBHOOK_URL", "https://hook.example/test");
  fetchMock = vi.fn(() => { throw new Error("Network/Ollama forbidden"); }); vi.stubGlobal("fetch", fetchMock);
  vi.mocked(fs.rename).mockClear(); vi.mocked(https.request).mockClear(); vi.mocked(dns.lookup).mockClear();
  const batchId = (await project("--create-batch")).batch.batch_id;
  const active = async (name: string) => {
    const created = (await project("--create-project", batchId, "--name", name, "--hypothesis", "Fixture fictive", "--budget-cents", "1000", "--duration-days", "7")).projects.at(-1);
    await project("--reserve-project", ...target(created)); const reserved = await inspect(created);
    await project("--approve-project", ...target(reserved), "--request-id", reserved.approval!.request.request_id);
    await project("--start-project", ...target(reserved), "--request-id", reserved.approval!.request.request_id); return inspect(reserved);
  };
  a = await active("A"); b = await active("B"); await project("--create-asset", ...target(a)); a = await inspect(a);
});
afterEach(async () => {
  expect(fetchMock).not.toHaveBeenCalled(); expect(https.request).not.toHaveBeenCalled(); expect(dns.lookup).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); await fs.rm(temp, { recursive: true, force: true });
});

describe("V10 observations, exact scope and strict input", () => {
  it("isolates A/B and treats metric snapshots as 20 then 45, never 65", async () => {
    const before = await authorities(); setDay(1); await observe(a, "traffic", "--metric", "views", "--value", "20"); await observe(a, "inquiry", "--metric", "inquiries", "--value", "2");
    await observe(b, "traffic", "--metric", "views", "--value", "7"); const bBefore = (await status(b)).timeline;
    setDay(3); await observe(a, "traffic", "--metric", "views", "--value", "45"); await observe(a, "inquiry", "--metric", "inquiries", "--value", "4");
    const output = await status(); expect(output.status.observed_unconfirmed_signals.experiment_metrics).toEqual({ views: 45, inquiries: 4 });
    expect((await status(b)).status.observed_unconfirmed_signals.experiment_metrics).toEqual({ views: 7 }); expect((await status(b)).timeline).toEqual(bBefore);
    expect(await authorities()).toEqual(before); expect(output.report).toContain("CONFIRMED FINANCIAL DATA"); expect(output.report).toContain("OBSERVED / UNCONFIRMED SIGNALS");
  });
  it("late entered snapshots use effective_at and preserve append order", async () => {
    setDay(3); const first = await observe(a, "traffic", "--metric", "views", "--value", "45");
    const late = await observe(a, "traffic", "--metric", "views", "--value", "20", "--effective-at", new Date(Date.parse(startTime) + day).toISOString());
    expect(late.timeline[0]).toEqual(first.event); expect(late.timeline[1].effective_at < late.timeline[0].effective_at).toBe(true);
    expect(late.status.observed_unconfirmed_signals.experiment_metrics.views).toBe(45);
  });
  it.each(["latest", "current", "all", "*", "yes", "", "../a", "project-123"])("refuses project alias %j", value => {
    expect(() => parseMonitoringCommand(["--status", value, "--experiment-id", a.experiment_id])).toThrow();
  });
  it("rejects another project's experiment and unknown IDs without mutation", async () => {
    const before = await tree(temp);
    await expect(run("--record-observation", a.plan.project_id, "--experiment-id", b.experiment_id, "--type", "note", "--note", "x")).rejects.toThrow("matching");
    await expect(run("--status", `project-${randomUUID()}`, "--experiment-id", a.experiment_id)).rejects.toThrow(); expect(await tree(temp)).toEqual(before);
  });
  it.each(["1.5", "-1", "-0", "+1", "NaN", "Infinity", "1e3", "0x10", "01", "1000001", "999999999999999999", "1 ", ""])("refuses metric/claim integer %j", value => {
    for (const args of [["traffic", "--metric", "views", "--value", value], ["sale_claim", "--amount-cents", value]]) expect(() => parseMonitoringCommand(["--record-observation", ...target(a), "--type", ...args])).toThrow();
  });
  it.each([NaN, Infinity, -Infinity, -1, -0, 1.2, Number.MAX_SAFE_INTEGER, "1", null])("host integer rejects %j", value => {
    expect(() => boundedInteger(value, MONITORING_LIMITS.MAX_METRIC_VALUE)).toThrow();
  });
  it("accepts bounded category-specific metrics, zero counters and exact maximum", async () => {
    for (const [type, metric] of [["traffic", "clicks"], ["traffic", "visitors"], ["lead", "leads"], ["conversion_signal", "orders_claimed"], ["inventory", "units_remaining"], ["effort", "hours_spent_minutes"]]) {
      await observe(a, type, "--metric", metric, "--value", "0");
    }
    await observe(a, "traffic", "--metric", "views", "--value", String(MONITORING_LIMITS.MAX_METRIC_VALUE));
    expect((await ledger()).total_recorded_revenue_cents).toBe(0);
  });
  it("refuses unknown category, unknown/mismatched metric, free JSON and unknown fields", async () => {
    await expect(observe(a, "payment", "--amount-cents", "1")).rejects.toThrow();
    for (const metric of ["revenue", "sales", "__proto__", "inquiries"]) await expect(observe(a, "traffic", "--metric", metric, "--value", "1")).rejects.toThrow();
    await expect(observe(a, "note", "--note", "x", "--json", "{}")).rejects.toThrow();
    await expect(observe(a, "note", "--note", "x", "--note", "y")).rejects.toThrow();
    const command = parseMonitoringCommand(["--record-observation", ...target(a), "--type", "note", "--note", "x"]);
    expect(() => validateMonitoringCommand({ ...command, financial: true } as any)).toThrow();
    expect(() => validateMonitoringCommand({ ...command, preview: "yes" } as any)).toThrow();
    expect(() => parseObservationData("note", { note: "x", url: "https://x.example" })).toThrow();
  });
  it.each(["", " ", "x".repeat(501), "line\nbreak", "escape\u001b"])("rejects unsafe/oversized note", async text => { await expect(note(a, text)).rejects.toThrow(); });
  it("records risk/blocker and reported asset status without changing V9 lifecycle", async () => {
    const before = await authorities(); await observe(a, "risk", "--note", "Faible demande"); await observe(a, "blocker", "--note", "Stock indisponible");
    await observe(a, "asset_status", "--reported-status", "unavailable"); expect(await authorities()).toEqual(before);
    expect((await inspect(a)).asset!.status).toBe("created");
  });
});

describe("V10 deterministic time, checkpoints and passive assets", () => {
  it("start/day1/day3/day5/deadline checkpoints are explicit and never close automatically", async () => {
    expect((await status()).status.alerts).toContain("NO_OBSERVATION_YET");
    await checkpoint(a, "start"); expect((await status()).status.temporal_state).toBe("active");
    for (const n of [1, 3, 5]) {
      setDay(n); expect((await status()).status.alerts).toContain("CHECKPOINT_DUE");
      const r = await checkpoint(a, `day_${n}`); expect(r.event!.effective_at).toBe(new Date(Date.parse(startTime) + n * day).toISOString());
      expect(r.status.temporal_state).toBe("active"); await expect(checkpoint(a, `day_${n}`)).rejects.toThrow("duplicate");
    }
    const before = await authorities(); setDay(7); const expired = await status();
    expect(expired.status.temporal_state).toBe("deadline_reached"); expect(expired.status.alerts).toContain("PENDING_HUMAN_RESULT");
    expect(expired.report).toContain("DEADLINE_REACHED — HUMAN CLOSE REQUIRED"); await checkpoint(a, "deadline");
    expect((await inspect(a)).status).toBe("active"); expect(await authorities()).toEqual(before);
  });
  it("shorter experiments have no checkpoints beyond their actual deadline", () => {
    for (const days of [1, 2, 3, 5]) {
      const p = { ...a, plan: { ...a.plan, duration_days: days }, experiment_deadline: new Date(Date.parse(startTime) + days * day).toISOString() };
      const schedule = checkpointSchedule(p); expect(schedule.at(-1)!.at).toBe(p.experiment_deadline);
      expect(schedule.every(c => c.at <= p.experiment_deadline)).toBe(true); expect(new Set(schedule.map(c => c.at)).size).toBe(schedule.length);
    }
  });
  it("refuses premature checkpoint and unknown checkpoint aliases", async () => {
    await expect(checkpoint(a, "day_1")).rejects.toThrow("not due"); await expect(checkpoint(a, "latest")).rejects.toThrow();
    await expect(checkpoint(a, "day_7")).rejects.toThrow();
  });
  it.each(["invalid", "2026-02-30T00:00:00.000Z", "2026-10-06", "2026-10-06T12:00:00+00:00", "+999999-01-01T00:00:00.000Z", "1999-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z"])("refuses timestamp %j", async timestamp => {
    await expect(observe(a, "note", "--note", "x", "--effective-at", timestamp)).rejects.toThrow();
  });
  it("rejects before-start/future effective time and clock rollback without sleeping", async () => {
    await expect(observe(a, "note", "--note", "x", "--effective-at", "2026-10-05T12:00:00.000Z")).rejects.toThrow("Incoherent");
    await expect(observe(a, "note", "--note", "x", "--effective-at", "2026-10-07T12:00:00.000Z")).rejects.toThrow("Incoherent");
    setDay(3); await note(); setDay(2); await expect(status()).rejects.toThrow("clock moved backwards");
  });
  it("expired experiment accepts late historical notes only within its seven-day window", async () => {
    setDay(8); await expect(note()).rejects.toThrow("exceeds experiment deadline");
    await observe(a, "note", "--note", "Relevé tardif J3", "--effective-at", new Date(Date.parse(startTime) + 3 * day).toISOString());
    expect((await status()).status.temporal_state).toBe("deadline_reached");
  });
  it("closed experiments require exact passive asset IDs and separate metric series", async () => {
    setDay(1); await observe(a, "traffic", "--metric", "views", "--value", "20"); setDay(7); a = await close();
    const before = await authorities(); setDay(8); await expect(note()).rejects.toThrow("unclosed active");
    await assetObservation(a, "traffic", "--metric", "views", "--value", "45");
    await assetObservation(a, "sale_claim", "--amount-cents", "500"); await assetObservation(a, "inventory", "--metric", "units_remaining", "--value", "2");
    await expect(assetObservation(a, "expense_claim", "--amount-cents", "1")).rejects.toThrow("forbidden in passive");
    await expect(run("--asset-observation", ...target(a), "--asset-id", `asset-${randomUUID()}`, "--type", "note", "--note", "x")).rejects.toThrow("Exact passive");
    await expect(run("--asset-observation", ...target(b), "--asset-id", a.asset!.asset_id, "--type", "note", "--note", "x")).rejects.toThrow("Exact passive");
    const output = await status(); expect(output.status.temporal_state).toBe("closed"); expect(output.status.alerts).toContain("ASSET_PASSIVE_MONITORING");
    expect(output.status.observed_unconfirmed_signals.experiment_metrics.views).toBe(20); expect(output.status.observed_unconfirmed_signals.asset_metrics.views).toBe(45);
    expect(await authorities()).toEqual(before);
  });
  it("fully closed/no asset rejects new observations, but historical status remains readable", async () => {
    await note(); await close(a, "0", "0", false); await expect(note()).rejects.toThrow(); await expect(assetObservation(a, "note", "--note", "x")).rejects.toThrow();
    expect((await status()).timeline).toHaveLength(1);
    await close(b, "0", "0", false); await expect(observe(b, "note", "--note", "x")).rejects.toThrow();
  });
  it("uses an explicit host test clock; CLI cannot override recorded_at", async () => {
    const result = await runMonitoringScout({ root, command: parseMonitoringCommand(["--record-observation", ...target(a), "--type", "note", "--note", "x"]), now: () => "2026-10-07T12:00:00.000Z" });
    expect(result.event!.recorded_at).toBe("2026-10-07T12:00:00.000Z");
    expect(() => parseMonitoringCommand(["--status", ...target(a), "--now", startTime])).toThrow();
  });
});

describe("V10 nonfinancial claims and exact reconciliation", () => {
  it("sale and expense claims never change ledger, lifetime, approvals or reservations", async () => {
    setDay(3); const before = await authorities(); await claim(); await claim(a, "expense_claim", "600");
    const output = await status(); expect(output.status.alerts).toEqual(expect.arrayContaining(["UNRECONCILED_SALE_CLAIM", "UNRECONCILED_EXPENSE_CLAIM"]));
    expect(output.status.confirmed_financial_data).toMatchObject({ experiment_expense_cents: 0, experiment_revenue_cents: 0, lifetime_net_result_cents: 0 });
    expect(await authorities()).toEqual(before); expect(await ledger()).toMatchObject({ available_balance_cents: 8000, reserved_balance_cents: 2000, total_recorded_revenue_cents: 0 });
  });
  it("reconciles to exact existing V9/V5 revenue and expense without another financial write", async () => {
    setDay(3); const sale = (await claim()).event!, expense = (await claim(a, "expense_claim", "600")).event!;
    setDay(7); a = await close(a, "600", "800"); const revenueEntry = await financialEntry(a, "revenue"), expenseEntry = await financialEntry(a, "expense"), before = await authorities();
    const previewBefore = await tree(temp); await reconcile(a, sale.event_id, revenueEntry.id, true); expect(await tree(temp)).toEqual(previewBefore);
    await reconcile(a, sale.event_id, revenueEntry.id); await reconcile(a, expense.event_id, expenseEntry.id);
    expect((await status()).status.observed_unconfirmed_signals.claims.every(c => c.reconciled)).toBe(true); expect(await authorities()).toEqual(before);
    const timeline = (await status()).timeline; expect(timeline[0]).toEqual(sale); expect(timeline[1]).toEqual(expense);
    await expect(reconcile(a, sale.event_id, revenueEntry.id)).rejects.toThrow("duplicate"); expect((await ledger()).total_recorded_revenue_cents).toBe(800);
  });
  it("cannot reconcile another project's claim, ledger entry or wrong amount/type", async () => {
    const ca = (await claim()).event!, cb = (await claim(b)).event!, wrong = (await claim(a, "sale_claim", "799")).event!;
    a = await close(); b = await close(b, "0", "800", false); const ea = await financialEntry(a, "revenue"), eb = await financialEntry(b, "revenue");
    await expect(reconcile(a, cb.event_id, ea.id)).rejects.toThrow("same-project");
    await expect(reconcile(a, ca.event_id, eb.id)).rejects.toThrow("another project");
    await expect(reconcile(a, wrong.event_id, ea.id)).rejects.toThrow("incompatible");
    await expect(reconcile(a, ca.event_id, "entry-999999")).rejects.toThrow("Missing");
    await expect(reconcile(a, ca.event_id, "entry-000002")).rejects.toThrow("incompatible");
    await expect(run("--reconcile-observation", a.plan.project_id, "--experiment-id", b.experiment_id, "--observation-id", ca.event_id, "--ledger-entry-id", ea.id)).rejects.toThrow("matching");
  });
  it("one ledger entry cannot reconcile two claims of the same amount", async () => {
    const first = (await claim()).event!, second = (await claim()).event!; a = await close(); const entry = await financialEntry(a, "revenue");
    await reconcile(a, first.event_id, entry.id); await expect(reconcile(a, second.event_id, entry.id)).rejects.toThrow("reused financial entry");
  });
  it("an unrelated V7-style/V5 revenue entry or edited result file cannot authorize reconciliation", async () => {
    const observation = (await claim()).event!;
    const next = recordAuthorizedEvent(await ledger(), { type: "revenue", amount_cents: 800, description: `claimed ${a.experiment_id}`, authorization: { source: "human", reference: "local-cli:record-result:unrelated" } });
    await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(next));
    await fs.writeFile(path.join(root, "experiment-result.json"), JSON.stringify({ experiment_id: a.experiment_id, revenue_cents: 800, ledger_entry_ids: [next.entries.at(-1)!.id] }));
    await expect(reconcile(a, observation.event_id, next.entries.at(-1)!.id)).rejects.toThrow("another project");
  });
  it("passive claim reconciles only to that asset's confirmed passive receipt", async () => {
    a = await close(); setDay(8); const observation = (await assetObservation(a, "sale_claim", "--amount-cents", "500")).event!;
    await project("--record-passive-revenue", ...target(a), "--asset-id", a.asset!.asset_id, "--receipt-id", `receipt-${randomUUID()}`, "--revenue-cents", "500"); a = await inspect(a);
    const before = await authorities(); await reconcile(a, observation.event_id, a.passive_receipts[0].ledger_entry_ids[0]); expect(await authorities()).toEqual(before);
    expect((await status()).status.confirmed_financial_data.post_experiment_revenue_cents).toBe(500);
  });
});

describe("V10 bounded authenticated storage, previews and locks", () => {
  it("record/checkpoint previews leave no anchor, public views or changed source bytes", async () => {
    const before = await tree(temp); await observe(a, "note", "--note", "x", "--preview"); await observe(a, "note", "--note", "x", "--preview"); await checkpoint(a, "start", true);
    expect(await tree(temp)).toEqual(before); await note(); const after = await tree(temp); await observe(a, "note", "--note", "x", "--preview"); expect(await tree(temp)).toEqual(after);
  });
  it("authenticates every append and rejects repeated IDs, excess counts and reconciliation limits", async () => {
    const event = (await note()).event!, current = await readProjectContext(root);
    const events = Array.from({ length: MONITORING_LIMITS.MAX_MONITORING_EVENTS_PER_EXPERIMENT }, () => ({ ...event, event_id: `observation-${randomUUID()}` }));
    await expect(auditObservations(root, events, current)).resolves.toBeDefined();
    await expect(auditObservations(root, [...events, { ...event, event_id: `observation-${randomUUID()}` }], current)).rejects.toThrow("per-experiment event limit");
    await expect(auditObservations(root, Array(257).fill(event), current)).rejects.toThrow("total event limit");
    await expect(auditObservations(root, Array(65).fill({ ...event, type: "reconciliation" }), current)).rejects.toThrow("reconciliation limit");
    await expect(auditObservations(root, [event, event], current)).rejects.toThrow("Duplicate");
  });
  it.each(["project_id", "experiment_id", "asset_id", "event_id", "type", "data", "recorded_at", "effective_at", "ledger_hash", "project_history_hash"])("private tamper %s fails authentication before mutation", async field => {
    await note(); const file = path.join(observationStoreRoot(root), "state.json"), data = JSON.parse(await fs.readFile(file, "utf8")); data.events[0][field] = "forged";
    await fs.writeFile(file, JSON.stringify(data)); await expect(note()).rejects.toThrow("authentication");
  });
  it.each(MONITORING_FILES)("rejects public tamper/orphan/missing view %s", async name => {
    await note(); await fs.appendFile(path.join(root, name), " "); await expect(status()).rejects.toThrow("Modified");
    await fs.unlink(path.join(root, name)); await expect(note()).rejects.toThrow("missing");
  });
  it.each([...MONITORING_FILES, "private:state.json", "private:integrity-key"])("rejects symlink and hardlink %s", async name => {
    await note(); const file = name.startsWith("private:") ? path.join(observationStoreRoot(root), name.slice(8)) : path.join(root, name), outside = path.join(temp, "outside");
    await fs.rename(file, outside); await fs.symlink(outside, file); await expect(note()).rejects.toThrow();
    await fs.unlink(file); await fs.link(outside, file); await expect(note()).rejects.toThrow();
  });
  it.each(["state.json", "integrity-key"])("missing private %s is never regenerated", async name => {
    await note(); await fs.unlink(path.join(observationStoreRoot(root), name)); await expect(note()).rejects.toThrow("Incomplete monitoring anchor");
  });
  it("refuses unsafe directory/permissions and oversized files", async () => {
    await note(); const store = observationStoreRoot(root); await fs.chmod(store, 0o755); await expect(status()).rejects.toThrow("private"); await fs.chmod(store, 0o700);
    await fs.chmod(path.join(store, "integrity-key"), 0o644); await expect(status()).rejects.toThrow("private"); await fs.chmod(path.join(store, "integrity-key"), 0o600);
    await fs.appendFile(path.join(store, "state.json"), " ".repeat(MONITORING_LIMITS.MAX_HISTORY_SIZE)); await expect(status()).rejects.toThrow("oversized");
  });
  it("public orphan files prevent new anchor creation", async () => {
    await fs.writeFile(path.join(root, "monitoring-history.json"), "{}"); await expect(note()).rejects.toThrow("orphan");
    await expect(fs.stat(observationStoreRoot(root))).rejects.toThrow();
  });
  it("first atomic rename failure preserves previous complete state; later failure blocks without touching V9", async () => {
    await note(); const before = await tree(temp); vi.mocked(fs.rename).mockRejectedValueOnce(new Error("disk failure")); await expect(note()).rejects.toThrow("disk failure"); expect(await tree(temp)).toEqual(before);
    const sourceBefore = await authorities(), real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementationOnce(real.rename).mockRejectedValueOnce(new Error("view failure")); await expect(note()).rejects.toThrow();
    await expect(note()).rejects.toThrow("Incomplete monitoring transaction"); expect(await authorities()).toEqual(sourceBefore);
  });
  it("concurrent observations and duplicate checkpoints have one winner; never steals stale shared lock", async () => {
    const result = await Promise.allSettled([note(a), note(b)]); expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const checkpoints = await Promise.allSettled([checkpoint(a, "start"), checkpoint(a, "start")]); expect(checkpoints.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await fs.writeFile(path.join(root, ".economic-ledger.lock"), "stale"); await expect(note()).rejects.toThrow("locked"); expect(await read(".economic-ledger.lock")).toBe("stale");
  });
  it("generic model tools cannot write monitoring views or reach private state", async () => {
    await note(); const tools = createLocalWorkspaceTools(root), write = tools.find(t => t.name === "write_file")!, readTool = tools.find(t => t.name === "read_file")!;
    for (const name of [...MONITORING_FILES, ".monitoring-temp.json", "sub/monitoring-report.txt"]) expect(await (write.execute as any)({ path: name, content: "forged" })).toContain("runtime-controlled");
    for (const tool of [write, readTool]) expect(await (tool.execute as any)({ path: path.relative(root, path.join(observationStoreRoot(root), "integrity-key")), content: "forged" })).toContain("ERROR");
  });
});

describe("V10 observed V8 result and offline CLI", () => {
  async function externalResult() {
    vi.stubEnv("SCOUT_MODE", "external"); await runExternalScout({ root, command: { kind: "prepare" } });
    const action = JSON.parse(await read("external-action.json")), request = JSON.parse(await read("external-approval-request.json"));
    await project("--link-external-action", ...target(a), "--action-id", action.action_id, "--request-id", request.request_id);
    vi.stubEnv("SCOUT_MODE", "approval"); await runExternalApprovalScout({ root, args: ["--approve-external", request.request_id] }); vi.stubEnv("SCOUT_MODE", "external");
    const transport = { resolve: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]), ping: vi.fn().mockResolvedValue({ status: 200, headers: {}, body: (async function* () { yield Buffer.from("{}"); })(), close: vi.fn() }) };
    await runExternalScout({ root, command: { kind: "execute", actionId: action.action_id, requestId: request.request_id, projectId: a.plan.project_id, experimentId: a.experiment_id, preview: false }, transport });
    vi.stubEnv("SCOUT_MODE", "monitoring"); return { execution: JSON.parse(await read("external-execution.json")), transport };
  }
  it("only reads an already authenticated same-project execution; no second V8 call or endpoint config needed", async () => {
    const { execution, transport } = await externalResult(); vi.stubEnv("SCOUT_V8_WEBHOOK_URL", undefined); const before = await authorities();
    await expect(observe(b, "external_action_result", "--execution-id", execution.execution_id)).rejects.toThrow("exact project");
    const event = (await observe(a, "external_action_result", "--execution-id", execution.execution_id)).event!;
    expect(event.data.execution_id).toBe(execution.execution_id); expect(transport.ping).toHaveBeenCalledTimes(1); expect(await authorities()).toEqual(before);
    await expect(observe(a, "external_action_result", "--execution-id", execution.execution_id)).rejects.toThrow("duplicate");
  });
  it("missing or tampered V8 result is refused", async () => {
    await expect(observe(a, "external_action_result", "--execution-id", `execution-${randomUUID()}`)).rejects.toThrow("Authenticated V8");
    const { execution } = await externalResult(); await fs.appendFile(path.join(root, "external-execution.json"), " ");
    await expect(observe(a, "external_action_result", "--execution-id", execution.execution_id)).rejects.toThrow("Modified");
  });
  it("actual CLI runs without Ollama/network and without an implicit command", async () => {
    // V9 anchors are bound to the root. Build the CLI fixture at its actual home path.
    const cliRoot = path.join(temp, ".automaton", "scout-workspace"), oldRoot = root; root = cliRoot; await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(initializeLedger(10000)));
    const batch = (await project("--create-batch")).batch.batch_id;
    let p = (await project("--create-project", batch, "--name", "CLI", "--hypothesis", "Fixture", "--budget-cents", "0", "--duration-days", "1")).projects[0];
    await project("--reserve-project", ...target(p)); p = await inspect(p); await project("--approve-project", ...target(p), "--request-id", p.approval.request.request_id);
    await project("--start-project", ...target(p), "--request-id", p.approval.request.request_id);
    const cli = (args: string[], mode = "monitoring") => promisify(execFile)(process.execPath, ["dist/index.js", ...args], { cwd: process.cwd(),
      env: { ...process.env, HOME: temp, SCOUT_MODE: mode, OLLAMA_BASE_URL: "invalid" }, timeout: 10000 });
    // Explicit historical effective time is allowed if the host date is later.
    expect((await cli(["--status", ...target(p)])).stdout).toContain("CONFIRMED FINANCIAL DATA");
    await cli(["--record-observation", ...target(p), "--type", "note", "--note", "CLI", "--effective-at", startTime, "--preview"]);
    await expect(fs.stat(observationStoreRoot(root))).rejects.toThrow();
    await expect(cli(["--run"])).rejects.toThrow(); await expect(cli(["--status", p.plan.project_id])).rejects.toThrow();
    root = oldRoot;
  });
});
