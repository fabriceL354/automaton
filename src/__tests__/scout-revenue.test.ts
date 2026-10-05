import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { initializeLedger, reserveExperiment, experimentReference, parseEconomicLedger, recordAuthorizedEvent, type EconomicLedger } from "../agent/economic-ledger.js";
import { runLedgerScout } from "../agent/ledger-runner.js";
import { runApprovalScout, approvalStoreRoot } from "../agent/approval-gate.js";
import { runRevenueScout, revenueStoreRoot, parseRevenueCommand, type RevenueCommand } from "../agent/revenue-runner.js";
import { createLocalWorkspaceTools } from "../agent/local-tools.js";
import type { ExperimentPlan } from "../agent/experiment-runner.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const plan: ExperimentPlan = {
  version: 4, status: "planned", opportunity_name: "Service local", opportunity_score: 82,
  hypothesis: "Tester la demande pour un service local.", experiment_budget_eur: 10, duration_days: 3,
  actions: ["Préparer un prototype"], success_metrics: ["Obtenir trois réponses"], stop_conditions: ["Arrêter après trois jours"],
  expected_learning: "Mesurer la demande locale.", requires_real_spending: true, requires_external_account: false,
  requires_publication: false, requires_human_approval: true,
};
let temp: string, root: string;
let fetchMock: ReturnType<typeof vi.fn>;
const read = (name: string) => fs.readFile(path.join(root, name), "utf8");
const write = (name: string, value: unknown) => fs.writeFile(path.join(root, name), JSON.stringify(value));
const command = (change: Partial<RevenueCommand> = {}): RevenueCommand => ({ experiment_id: experimentReference(plan).id,
  expense_cents: 0, revenue_cents: 0, outcome: "cancelled", approval_request_id: null, preview: false, ...change });
const run = (input = command()) => runRevenueScout({ root, command: input });
async function fixture(value = plan) {
  await fs.mkdir(root, { recursive: true });
  await write("experiment.json", value);
  await write("economic-ledger.json", reserveExperiment(initializeLedger(10000), value));
}
async function approval(approve = true) {
  vi.stubEnv("SCOUT_MODE", "approval");
  const request = await runApprovalScout({ root });
  if (approve) await runApprovalScout({ root, command: { kind: "approve", requestId: request.request_id } });
  vi.stubEnv("SCOUT_MODE", "revenue");
  return request.request_id;
}
async function ledger() { return parseEconomicLedger(await read("economic-ledger.json")); }
async function absent(name: string) { await expect(fs.stat(path.join(root, name))).rejects.toThrow(); }
function rehash(value: EconomicLedger) {
  let previous = "0".repeat(64);
  for (const entry of value.entries) {
    entry.previous_hash = previous;
    const { hash: _hash, ...payload } = entry;
    entry.hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    previous = entry.hash;
  }
}
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-revenue-")); root = path.join(temp, "workspace");
  vi.stubEnv("SCOUT_MODE", "revenue"); vi.stubEnv("OLLAMA_BASE_URL", "invalid");
  fetchMock = vi.fn(() => { throw new Error("No network or Ollama allowed"); }); vi.stubGlobal("fetch", fetchMock);
  vi.mocked(fs.rename).mockClear(); await fixture();
});
afterEach(async () => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await fs.rm(temp, { recursive: true, force: true });
});

describe("V7 human-confirmed closure and exact V5 accounting", () => {
  it("closes zero/zero without approval, releases everything and keeps V4 an immutable plan", async () => {
    const planBefore = await read("experiment.json"), original = await ledger();
    const { result } = await run(); const after = await ledger();
    expect(result).toMatchObject({ version: 7, experiment_id: experimentReference(plan).id, outcome: "cancelled", reserved_cents: 1000,
      expense_cents: 0, revenue_cents: 0, net_result_cents: 0, released_cents: 1000, approval_id: null, approval_request_id: null,
      status: "closed", source: "human_confirmed", opportunity_score: 82, planned_duration_days: 3, expected_learning: plan.expected_learning });
    expect(result.result_id).toMatch(/^result-/); expect(result.recorded_at).toMatch(/Z$/);
    expect(result.human_reference).toBe(`local-cli:record-result:${result.result_id}`);
    expect(after.entries.slice(0, 2)).toEqual(original.entries);
    expect(after.entries.map(e => e.type)).toEqual(["initialization", "reserve", "release"]);
    expect(after).toMatchObject({ initial_capital_cents: 10000, available_balance_cents: 10000, reserved_balance_cents: 0,
      total_recorded_expenses_cents: 0, total_recorded_revenue_cents: 0, realized_net_result_cents: 0 });
    expect(await read("experiment.json")).toBe(planBefore);
    expect(JSON.parse(await read("experiment-result.json"))).toEqual(result);
    const memory = JSON.parse(await read("economic-history.json"));
    expect(memory.results).toEqual([result]); expect(memory.metrics.closed_experiments).toBe(1); expect(memory.metrics.outcomes.cancelled).toBe(1);
    expect(await read("revenue-report.txt")).toContain("Les montants réalisés ont été déclarés explicitement par l'utilisateur.");
    expect(await read("revenue-report.txt")).toContain("Scout n'a exécuté aucun paiement ni transaction externe.");
    expect(await read("economic-report.txt")).toContain("Solde disponible : 100.00 EUR");
  });

  it.each([
    [700, 2500, 300, 11800, 1800], [1000, 2500, 0, 11500, 1500], [700, 700, 300, 10000, 0],
    [700, 0, 300, 9300, -700], [1, 29, 999, 10028, 28], [0, 2500, 1000, 12500, 2500],
  ])("expense=%i revenue=%i => exact release=%i available=%i net=%i", async (expense, revenue, released, available, net) => {
    const requestId = await approval();
    const approvalBefore = await read("approval.json");
    const { result, report } = await run(command({ expense_cents: expense, revenue_cents: revenue, outcome: "success", approval_request_id: requestId }));
    expect(result).toMatchObject({ expense_cents: expense, revenue_cents: revenue, released_cents: released, net_result_cents: net });
    const after = await ledger();
    expect(after).toMatchObject({ initial_capital_cents: 10000, available_balance_cents: available, reserved_balance_cents: 0,
      total_recorded_expenses_cents: expense, total_recorded_revenue_cents: revenue, realized_net_result_cents: net });
    expect(after.entries.slice(2).map(e => e.type)).toEqual([...(expense ? ["expense"] : []), ...(released ? ["release"] : []), ...(revenue ? ["revenue"] : [])]);
    expect(after.entries.slice(2).every(e => e.human_reference?.startsWith(result.human_reference))).toBe(true);
    const income = after.entries.find(e => e.type === "revenue");
    if (income) { expect(income.description).toContain(result.experiment_id); expect(result.ledger_entry_ids).toContain(income.id); }
    expect(after.available_balance_cents + after.reserved_balance_cents).toBe(10000 + revenue - expense);
    expect(await read("approval.json")).toBe(approvalBefore); expect(await read("revenue-report.txt")).toBe(report);
    expect(report).not.toMatch(/paiement effectué|Scout a payé/);
  });

  it("zero-cost plan can close with human revenue and no invented reservation or approval", async () => {
    const free = { ...plan, experiment_budget_eur: 0, requires_real_spending: false, requires_human_approval: false };
    await fixture(free);
    const { result } = await run(command({ experiment_id: experimentReference(free).id, revenue_cents: 20, outcome: "partial" }));
    expect(result.reserved_cents).toBe(0); expect(result.released_cents).toBe(0);
    expect((await ledger()).entries.map(e => e.type)).toEqual(["initialization", "revenue"]);
  });

  it("handles a zero-cost zero-result closure without appending zero-value V5 events", async () => {
    const free = { ...plan, experiment_budget_eur: 0, requires_real_spending: false, requires_human_approval: false }; await fixture(free);
    const input = command({ experiment_id: experimentReference(free).id }); const before = await read("economic-ledger.json");
    await run(input); await run(input);
    expect(await read("economic-ledger.json")).toBe(before);
    expect(JSON.parse(await read("economic-history.json")).results).toHaveLength(1);
  });

  it("allows cancellation with a valid pending or denied V6 request, never spending", async () => {
    const requestId = await approval(false);
    vi.stubEnv("SCOUT_MODE", "approval"); await runApprovalScout({ root, command: { kind: "deny", requestId } }); vi.stubEnv("SCOUT_MODE", "revenue");
    const { result } = await run();
    expect(result.approval_id).toBeNull(); expect(result.approval_request_id).toBe(requestId);
    expect((await ledger()).reserved_balance_cents).toBe(0);
  });

  it("idempotently returns exactly the prior result without duplicated events or a new timestamp", async () => {
    const requestId = await approval(), input = command({ expense_cents: 700, revenue_cents: 2500, outcome: "success", approval_request_id: requestId });
    const first = await run(input), before = await read("economic-ledger.json"), resultRaw = await read("experiment-result.json");
    expect((await run(input)).result).toEqual(first.result);
    expect(await read("economic-ledger.json")).toBe(before); expect(await read("experiment-result.json")).toBe(resultRaw);
    expect(JSON.parse(await read("economic-history.json")).results).toHaveLength(1);
    for (const change of [{ expense_cents: 600 }, { revenue_cents: 2600 }, { outcome: "failed" as const }, { approval_request_id: null }]) {
      await expect(run({ ...input, ...change })).rejects.toThrow("already closed");
    }
    expect(await read("economic-ledger.json")).toBe(before);
    // V5 rerun never reopens a consumed/released reservation.
    vi.stubEnv("SCOUT_MODE", "ledger"); await runLedgerScout({ root }); vi.stubEnv("SCOUT_MODE", "revenue");
    expect(await read("economic-ledger.json")).toBe(before); expect((await run(input)).result).toEqual(first.result);
  });

  it("appends a second distinct experiment, preserves earlier proof and derives aggregate memory", async () => {
    const request1 = await approval(); await run(command({ expense_cents: 700, revenue_cents: 2500, outcome: "success", approval_request_id: request1 }));
    const firstHistory = JSON.parse(await read("economic-history.json"));
    const nextPlan = { ...plan, opportunity_name: "Seconde expérience", opportunity_score: 61, duration_days: 2 };
    await write("experiment.json", nextPlan); await write("economic-ledger.json", reserveExperiment(await ledger(), nextPlan));
    vi.stubEnv("SCOUT_MODE", "approval"); const request2 = await runApprovalScout({ root, command: { kind: "new-request" } });
    await runApprovalScout({ root, command: { kind: "approve", requestId: request2.request_id } }); vi.stubEnv("SCOUT_MODE", "revenue");
    const secondInput = command({ experiment_id: experimentReference(nextPlan).id, expense_cents: 100, revenue_cents: 0, outcome: "failed", approval_request_id: request2.request_id });
    await run(secondInput); await run(secondInput);
    const history = JSON.parse(await read("economic-history.json"));
    expect(history.results).toHaveLength(2); expect(history.results[0]).toEqual(firstHistory.results[0]);
    expect(history.metrics).toMatchObject({ closed_experiments: 2, expense_cents: 800, gross_revenue_cents: 2500, net_result_cents: 1700, outcomes: { success: 1, failed: 1 } });
    expect(await ledger()).toMatchObject({ available_balance_cents: 11700, reserved_balance_cents: 0, realized_net_result_cents: 1700 });
  });
});

describe("V7 approval boundary, strict CLI and invalid inputs", () => {
  it("requires approved exact request for any positive expense and never mutates on rejection", async () => {
    const before = await read("economic-ledger.json");
    await expect(run(command({ expense_cents: 1 }))).rejects.toThrow("approved V6");
    const requestId = await approval(false);
    await expect(run(command({ expense_cents: 1, approval_request_id: requestId }))).rejects.toThrow("approved V6");
    vi.stubEnv("SCOUT_MODE", "approval"); await runApprovalScout({ root, command: { kind: "approve", requestId } }); vi.stubEnv("SCOUT_MODE", "revenue");
    await expect(run(command({ expense_cents: 1 }))).rejects.toThrow("approved V6");
    await expect(run(command({ expense_cents: 1, approval_request_id: "request-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }))).rejects.toThrow("request_id");
    expect(await read("economic-ledger.json")).toBe(before); await absent("experiment-result.json");
  });

  it("rejects expenditure above reservation, even with approval", async () => {
    const requestId = await approval();
    await expect(run(command({ expense_cents: 1001, approval_request_id: requestId }))).rejects.toThrow("exceeds");
    expect((await ledger()).total_recorded_expenses_cents).toBe(0);
  });

  it.each([{ approved_capabilities: ["publication"] }, { max_amount_cents: 600 }, { request_id: "wrong" }, { human_reference: "model" }])("rejects modified approval scope %j", async change => {
    const requestId = await approval(); await write("approval.json", { ...JSON.parse(await read("approval.json")), ...change });
    await expect(run(command({ expense_cents: 700, approval_request_id: requestId }))).rejects.toThrow("Modified");
    await expect(run()).rejects.toThrow("Modified");
  });

  it("rejects stale V6 after valid unrelated ledger append", async () => {
    const requestId = await approval();
    const extended = recordAuthorizedEvent(await ledger(), { type: "revenue", amount_cents: 1, description: "Test fixture", authorization: { source: "human", reference: "fixture" } });
    await write("economic-ledger.json", extended);
    await expect(run(command({ expense_cents: 1, approval_request_id: requestId }))).rejects.toThrow("stale");
    await expect(run()).rejects.toThrow("stale");
  });

  it.each(["release", "expense"] as const)("rejects an already modified reservation: %s", async type => {
    await write("economic-ledger.json", recordAuthorizedEvent(await ledger(), { type, experiment_id: experimentReference(plan).id, amount_cents: 1,
      description: "Fixture only", authorization: { source: "human", reference: "fixture" } }));
    await expect(run()).rejects.toThrow("active V5 reservation");
  });

  it.each(["experiment.json", "economic-ledger.json"])("requires present valid input %s", async name => {
    await fs.unlink(path.join(root, name)); await expect(run()).rejects.toThrow("requires existing");
    await fs.writeFile(path.join(root, name), "broken JSON"); await expect(run()).rejects.toThrow();
    await absent("experiment-result.json");
  });

  it("rejects no reservation or altered plan/experiment id", async () => {
    await expect(run(command({ experiment_id: "a".repeat(64) }))).rejects.toThrow("Wrong experiment_id");
    await write("economic-ledger.json", initializeLedger(10000)); await expect(run()).rejects.toThrow("reservation");
    await fixture(); await approval(); await write("experiment.json", { ...plan, actions: ["Préparer un autre prototype"] });
    await expect(run()).rejects.toThrow("Wrong experiment_id");
  });

  it.each([-1, -0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 1000000001, "700", null, undefined])("rejects invalid host amount %s", async value => {
    for (const field of ["expense_cents", "revenue_cents"]) await expect(run(command({ [field]: value } as any))).rejects.toThrow();
    await absent("experiment-result.json");
  });

  it("fails on cumulative V5 overflow before any persisted mutation", async () => {
    await write("economic-ledger.json", recordAuthorizedEvent(await ledger(), { type: "revenue", amount_cents: 999990000,
      description: "Large fixture revenue", authorization: { source: "human", reference: "fixture" } }));
    const before = await read("economic-ledger.json");
    await expect(run(command({ revenue_cents: 1 }))).rejects.toThrow("limit");
    expect(await read("economic-ledger.json")).toBe(before); await absent("experiment-result.json");
  });

  it.each(["", "SUCCESS", "all", "approved", null, ["success"]])("rejects invalid outcome %j", async value => {
    await expect(run(command({ outcome: value } as any))).rejects.toThrow("Outcome");
  });

  it("rejects caller-generated ids/time/human reference and strict preview type", async () => {
    for (const extra of [{ human_reference: "I earned money" }, { result_id: "result-forged" }, { recorded_at: "today" }, { notes: "I earned money" }]) {
      await expect(run({ ...command(), ...extra } as any)).rejects.toThrow("fields");
    }
    await expect(run(command({ preview: "false" } as any))).rejects.toThrow("boolean");
  });

  it.each(["NaN", "Infinity", "-1", "-0", "0.1", "1e2", "01", "+1", " 1", "1000000001"])("rejects CLI amount %s", amount => {
    expect(() => parseRevenueCommand(["--record-result", experimentReference(plan).id, "--expense-cents", "0", "--revenue-cents", amount, "--outcome", "success"])).toThrow();
  });

  it("strictly parses reordered fields/preview and rejects aliases, omissions, duplicate/free-text inputs", () => {
    const args = ["--record-result", experimentReference(plan).id, "--expense-cents", "0", "--revenue-cents", "0", "--outcome", "cancelled"];
    expect(parseRevenueCommand([...args, "--preview"])).toEqual(command({ preview: true }));
    expect(parseRevenueCommand([args[0], args[1], "--outcome", "cancelled", "--preview", "--revenue-cents", "0", "--expense-cents", "0"])).toEqual(command({ preview: true }));
    for (const invalid of [args.slice(0, -2), [...args, "--expense-cents", "0"], [...args, "--preview", "--preview"], [...args, "I earned 25 EUR"],
      [...args, "--human-reference", "human"], ["--run"], ...["latest", "*", "all", "yes"].map(id => [args[0], id, ...args.slice(2)])]) {
      expect(() => parseRevenueCommand(invalid)).toThrow();
    }
  });
});

describe("V7 preview, history integrity and atomic failure handling", () => {
  it("preview leaves ledger, plan, approval, directory contents and private history untouched", async () => {
    const requestId = await approval();
    const before = await read("economic-ledger.json"), planRaw = await read("experiment.json"), approvalRaw = await read("approval.json");
    const names = await fs.readdir(root), parentNames = await fs.readdir(temp);
    vi.mocked(fs.rename).mockClear(); // Exclude approval fixture writes from preview observation.
    const output = await run(command({ expense_cents: 700, revenue_cents: 2500, outcome: "success", approval_request_id: requestId, preview: true }));
    expect(output.preview).toBe(true); expect(output.report).toContain("APERÇU"); expect(output.report).toContain("118.00 EUR");
    expect(output.report).toContain("Réservation à libérer : 3.00 EUR");
    expect(output.report).not.toContain("Les montants réalisés ont été déclarés");
    expect(await read("economic-ledger.json")).toBe(before); expect(await read("experiment.json")).toBe(planRaw); expect(await read("approval.json")).toBe(approvalRaw);
    expect(await fs.readdir(root)).toEqual(names); expect(await fs.readdir(temp)).toEqual(parentNames);
    expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
  });

  it.each(["experiment-result.json", "economic-history.json", "revenue-report.txt"])("rejects tampered or missing output %s, never rebuilding it", async name => {
    await run(); const original = await read(name);
    await fs.appendFile(path.join(root, name), " "); await expect(run()).rejects.toThrow("Modified");
    expect(await read(name)).toBe(original + " ");
    await fs.unlink(path.join(root, name)); await expect(run()).rejects.toThrow("missing");
  });

  it("rejects a forged result before first run", async () => {
    await write("experiment-result.json", { status: "closed", revenue_cents: 2500 });
    await expect(run()).rejects.toThrow("orphan");
    expect((await ledger()).reserved_balance_cents).toBe(1000);
  });

  it("rejects ledger corruption, coherent rehashing of history, and changed closed plan", async () => {
    await run(); const before = await read("economic-ledger.json"), l = await ledger();
    l.available_balance_cents++; await write("economic-ledger.json", l); await expect(run()).rejects.toThrow("mismatch");
    await fs.writeFile(path.join(root, "economic-ledger.json"), before); l.available_balance_cents--;
    l.entries[0].description = "Rewritten genesis"; rehash(l); await write("economic-ledger.json", l);
    await expect(run()).rejects.toThrow("history mismatch");
    await fs.writeFile(path.join(root, "economic-ledger.json"), before); await fs.appendFile(path.join(root, "experiment.json"), "\n");
    await expect(run()).rejects.toThrow("Closed experiment changed");
  });

  it("checks historical approval after closing instead of accepting mere approval file presence", async () => {
    const requestId = await approval(), input = command({ expense_cents: 700, approval_request_id: requestId }); await run(input);
    await fs.appendFile(path.join(root, "approval.json"), "\n"); await expect(run(input)).rejects.toThrow("Modified");
  });

  it("authenticates the private history and never regenerates a missing key", async () => {
    await run(); const store = revenueStoreRoot(root), statePath = path.join(store, "state.json");
    const raw = await fs.readFile(statePath, "utf8"), state = JSON.parse(raw); state.records[0].result.revenue_cents = 2500;
    await fs.writeFile(statePath, JSON.stringify(state)); await expect(run()).rejects.toThrow("authentication");
    await fs.writeFile(statePath, raw); await fs.unlink(path.join(store, "integrity-key"));
    await expect(run()).rejects.toThrow("Incomplete revenue anchor");
  });

  it.each(["experiment.json", "economic-ledger.json", "approval.json", "experiment-result.json", "economic-history.json", "revenue-report.txt", "economic-report.txt"])("blocks symlink/hardlink %s before financial mutation", async name => {
    await approval(); const before = await read("economic-ledger.json");
    const outside = path.join(temp, "outside"); await fs.writeFile(outside, "untouched");
    await fs.rm(path.join(root, name), { force: true }); await fs.symlink(outside, path.join(root, name));
    await expect(run()).rejects.toThrow(); await fs.unlink(path.join(root, name)); await fs.link(outside, path.join(root, name));
    await expect(run()).rejects.toThrow(); expect(await fs.readFile(outside, "utf8")).toBe("untouched");
    if (name !== "economic-ledger.json") expect(await read("economic-ledger.json")).toBe(before);
  });

  it.each(["state.json", "integrity-key"])("blocks private history symlink/hardlink %s", async name => {
    await run(); const target = path.join(revenueStoreRoot(root), name), outside = path.join(temp, "outside");
    await fs.rename(target, outside); await fs.symlink(outside, target); await expect(run()).rejects.toThrow();
    await fs.unlink(target); await fs.link(outside, target); await expect(run()).rejects.toThrow();
  });

  it("blocks symlink workspace and stale/concurrent V5 lock", async () => {
    const actual = root + "-actual"; await fs.rename(root, actual); await fs.symlink(actual, root); await expect(run()).rejects.toThrow("unsafe");
    await fs.unlink(root); await fs.rename(actual, root); await fs.writeFile(path.join(root, ".economic-ledger.lock"), "stale");
    await expect(run()).rejects.toThrow("locked"); expect(await read(".economic-ledger.lock")).toBe("stale");
  });

  it("allows only one concurrent close", async () => {
    const results = await Promise.allSettled([run(), run()]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect((await ledger()).entries).toHaveLength(3); expect(JSON.parse(await read("economic-history.json")).results).toHaveLength(1);
  });

  it("atomically applies all V5 events in one rename, never persisting an intermediate balance", async () => {
    const requestId = await approval(), before = await read("economic-ledger.json");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"); let ledgerWrites = 0;
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      if (String(destination) === path.join(root, "economic-ledger.json")) {
        ledgerWrites++;
        expect(await read("economic-ledger.json")).toBe(before);
        const staged = parseEconomicLedger(await fs.readFile(source, "utf8"));
        expect(staged.entries.slice(2).map(e => e.type)).toEqual(["expense", "release", "revenue"]);
        expect(staged.available_balance_cents).toBe(11800);
      }
      await actual.rename(source, destination);
    });
    await run(command({ expense_cents: 700, revenue_cents: 2500, outcome: "success", approval_request_id: requestId }));
    expect(ledgerWrites).toBe(1);
  });

  it.each(["ledger", "result", "complete"])("fails closed after an interrupted %s commit, without duplicated events", async stage => {
    const before = await read("economic-ledger.json"), actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      const target = String(destination);
      const isFinalState = target === path.join(revenueStoreRoot(root), "state.json") && JSON.parse(await fs.readFile(source, "utf8")).phase === "complete";
      if ((stage === "ledger" && target === path.join(root, "economic-ledger.json")) || (stage === "result" && target === path.join(root, "experiment-result.json")) || (stage === "complete" && isFinalState)) throw new Error("simulated disk failure");
      await actual.rename(source, destination);
    });
    await expect(run()).rejects.toThrow("simulated disk failure");
    const after = await read("economic-ledger.json"); if (stage === "ledger") expect(after).toBe(before);
    else expect((await ledger()).reserved_balance_cents).toBe(0);
    await expect(run()).rejects.toThrow("Incomplete revenue transaction");
    expect(await read("economic-ledger.json")).toBe(after);
  });

  it("rejects plan changes between prepared journal and ledger commit", async () => {
    const before = await read("economic-ledger.json"), actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementationOnce(async (source, destination) => {
      await actual.rename(source, destination); await fs.appendFile(path.join(root, "experiment.json"), "\n");
    });
    await expect(run()).rejects.toThrow("Inputs changed before ledger commit");
    expect(await read("economic-ledger.json")).toBe(before); await absent("experiment-result.json");
  });

  it("protects result/history/report and private anchor from the generic tools without adding tools", async () => {
    await run(); const tools = createLocalWorkspaceTools(root);
    expect(tools.map(t => t.name)).toEqual(["list_files", "read_file", "write_file"]);
    const writeTool = tools.find(t => t.name === "write_file")!, readTool = tools.find(t => t.name === "read_file")!;
    for (const name of ["experiment-result.json", "economic-history.json", "revenue-report.txt", "./revenue-report.txt", ".revenue.lock", "sub/experiment-result.json"]) {
      expect(await (writeTool.execute as any)({ path: name, content: "forged" })).toContain("runtime-controlled");
    }
    const outside = path.relative(root, path.join(revenueStoreRoot(root), "integrity-key"));
    expect(await (readTool.execute as any)({ path: outside })).toContain("ERROR");
    expect(await (writeTool.execute as any)({ path: outside, content: "forged" })).toContain("ERROR");
  });

  it("runs actual CLI preview/close without Ollama/mission/network and never accepts model/env amounts", async () => {
    const cliRoot = path.join(temp, ".automaton", "scout-workspace"); await fs.mkdir(cliRoot, { recursive: true });
    for (const name of ["experiment.json", "economic-ledger.json"]) await fs.copyFile(path.join(root, name), path.join(cliRoot, name));
    const cli = (args: string[], mode = "revenue") => promisify(execFile)(process.execPath, ["dist/index.js", ...args], {
      cwd: process.cwd(), env: { ...process.env, HOME: temp, SCOUT_MODE: mode, OLLAMA_BASE_URL: "invalid", SCOUT_MODEL: "not-a-model", SCOUT_REVENUE_CENTS: "2500" }, timeout: 10000 });
    const args = ["--record-result", experimentReference(plan).id, "--expense-cents", "0", "--revenue-cents", "0", "--outcome", "cancelled"];
    expect((await cli([...args, "--preview"])).stdout).toContain("APERÇU");
    await expect(fs.stat(path.join(cliRoot, "experiment-result.json"))).rejects.toThrow();
    await expect(cli(args, "local")).rejects.toThrow(); await expect(cli(["--run"])).rejects.toThrow();
    expect((await cli(args)).stdout).toContain("expérience clôturée"); expect((await cli(args)).stdout).toContain("Already closed");
    expect(parseEconomicLedger(await fs.readFile(path.join(cliRoot, "economic-ledger.json"), "utf8")).total_recorded_revenue_cents).toBe(0);
    const source = await fs.readFile("src/agent/revenue-runner.ts", "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(|node:child_process|node:https?|loadLocalScoutConfig\s*\(/);
  });
});
