import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  initialCapitalCents, initializeLedger, parseEconomicLedger, reserveExperiment, recordAuthorizedEvent,
  experimentReference, parseLedgerExperiment, buildEconomicReport, formatCents, LEDGER_LIMITS,
  type AuthorizedLedgerEvent, type EconomicLedger,
} from "../agent/economic-ledger.js";
import { runLedgerScout, recordLedgerEvent } from "../agent/ledger-runner.js";
import { createLocalWorkspaceTools } from "../agent/local-tools.js";
import { scoutMode } from "../agent/opportunity-scout.js";
import { type ExperimentPlan } from "../agent/experiment-runner.js";

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
const ref = experimentReference(plan);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const parse = (ledger: unknown) => parseEconomicLedger(JSON.stringify(ledger));
function event(type: "expense" | "release", amount: number, reference = "human-1"): AuthorizedLedgerEvent {
  return { type, amount_cents: amount, experiment_id: ref.id, description: "Événement comptable confirmé par l'opérateur", authorization: { source: "human", reference } };
}
function revenue(amount: number, reference = "revenue-1"): AuthorizedLedgerEvent {
  return { type: "revenue", amount_cents: amount, description: "Revenu confirmé par l'opérateur", authorization: { source: "human", reference } };
}
function reserved() { return reserveExperiment(initializeLedger(10000), plan); }
// Even a recomputed hash must not bypass accounting replay invariants.
function rehash(ledger: EconomicLedger) {
  let previous = "0".repeat(64);
  for (const entry of ledger.entries) {
    entry.previous_hash = previous;
    const { hash: _hash, ...payload } = entry;
    entry.hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    previous = entry.hash;
  }
}

let temp: string;
let root: string;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-ledger-"));
  root = path.join(temp, "workspace");
  vi.stubEnv("SCOUT_MODE", "ledger");
  vi.stubEnv("SCOUT_INITIAL_CAPITAL_EUR", "100");
  fetchMock = vi.fn(() => { throw new Error("No network or Ollama allowed"); });
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(fs.rename).mockClear();
});
afterEach(async () => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  await fs.rm(temp, { recursive: true, force: true });
});

describe("V5 exact accounting and replay", () => {
  it("initializes 100 EUR with runtime ids, time and verified totals", () => {
    const ledger = initializeLedger(initialCapitalCents("100"));
    expect(parse(ledger)).toEqual(ledger);
    expect(ledger.initial_capital_cents).toBe(10000);
    expect(ledger.available_balance_cents).toBe(10000);
    expect(ledger.entries[0].id).toBe("entry-000001");
    expect(ledger.entries[0].timestamp).toMatch(/^\d{4}-.*Z$/);
    expect(ledger.entries[0].type).toBe("initialization");
    expect(ledger.total_recorded_expenses_cents).toBe(0);
    expect(ledger.total_recorded_revenue_cents).toBe(0);
  });

  it("parses decimal digits exactly and formats cents without floating rounding", () => {
    expect(initialCapitalCents()).toBe(10000);
    expect(initialCapitalCents("0")).toBe(0);
    expect(initialCapitalCents("0.1")).toBe(10);
    expect(initialCapitalCents("0.29")).toBe(29);
    expect(initialCapitalCents("10000.00")).toBe(1000000);
    let ledger = initializeLedger(initialCapitalCents("0.10"));
    ledger = recordAuthorizedEvent(ledger, revenue(20));
    expect(ledger.available_balance_cents).toBe(30);
    expect(formatCents(ledger.available_balance_cents)).toBe("0.30 EUR");
    expect(formatCents(-1)).toBe("-0.01 EUR");
  });

  it.each(["", "-1", "+1", "01", " 100", "1e2", "NaN", "Infinity", "0.001", "10000.01", "10001", "1,00"])("rejects initial capital %s", value => {
    expect(() => initialCapitalCents(value)).toThrow();
  });

  it("reserves only bookkeeping funds and is idempotent for canonical V4 content", () => {
    const ledger = reserved();
    expect(ledger.available_balance_cents).toBe(9000);
    expect(ledger.reserved_balance_cents).toBe(1000);
    expect(ledger.total_recorded_expenses_cents).toBe(0);
    expect(ledger.entries[1].experiment?.requires_human_approval).toBe(true);
    expect(reserveExperiment(ledger, copy(plan))).toEqual(ledger);
    const reordered = Object.fromEntries(Object.entries(plan).reverse()) as unknown as ExperimentPlan;
    expect(reserveExperiment(ledger, reordered)).toEqual(ledger);
    expect(() => reserveExperiment(initializeLedger(999), plan)).toThrow("unaffordable");
  });

  it("releases, records reserved expenses and confirmed revenue, preserving prior entries", () => {
    const original = reserved();
    let ledger = recordAuthorizedEvent(original, event("expense", 301));
    expect(ledger.realized_net_result_cents).toBe(-301);
    expect(ledger.available_balance_cents).toBe(9000);
    expect(ledger.reserved_balance_cents).toBe(699);
    ledger = recordAuthorizedEvent(ledger, event("release", 699, "human-2"));
    ledger = recordAuthorizedEvent(ledger, revenue(502));
    expect(ledger.entries.slice(0, 2)).toEqual(original.entries);
    expect(original.entries).toHaveLength(2);
    expect(ledger.available_balance_cents).toBe(10201);
    expect(ledger.reserved_balance_cents).toBe(0);
    expect(ledger.total_recorded_expenses_cents).toBe(301);
    expect(ledger.total_recorded_revenue_cents).toBe(502);
    expect(ledger.realized_net_result_cents).toBe(201);
    expect(parse(ledger)).toEqual(ledger);
    expect(reserveExperiment(ledger, plan)).toEqual(ledger); // Never reopen spent/released funds.
    expect(() => recordAuthorizedEvent(ledger, event("expense", 1, "human-3"))).toThrow("exceeds");
  });

  it("does not authorize expenses from the available balance without a reservation", () => {
    expect(() => recordAuthorizedEvent(initializeLedger(10000), event("expense", 1))).toThrow("Unknown experiment");
    expect(() => recordAuthorizedEvent(reserved(), event("expense", 1001))).toThrow("exceeds");
    expect(() => recordAuthorizedEvent(reserved(), event("release", 1001))).toThrow("exceeds");
  });

  it("requires an explicit trusted-human reference and rejects replayed confirmations", () => {
    const ledger = reserved();
    for (const invalid of [
      { ...event("expense", 1), authorization: undefined },
      { ...event("expense", 1), authorization: { source: "model", reference: "I earned money" } },
      { ...revenue(1), authorization: { source: "human", reference: "" } },
      { ...revenue(1), available_balance_cents: 999999 },
    ]) expect(() => recordAuthorizedEvent(ledger, invalid as AuthorizedLedgerEvent)).toThrow();
    const next = recordAuthorizedEvent(ledger, revenue(1));
    expect(() => recordAuthorizedEvent(next, revenue(1))).toThrow("Unique explicit human");
  });

  it.each([-1, -0, 0, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER, "10", null])("rejects event amount %s", value => {
    expect(() => recordAuthorizedEvent(reserved(), revenue(value as number))).toThrow();
  });

  it("rejects tampering in every cached total and in the integrity chain", () => {
    const ledger = reserved();
    for (const field of ["initial_capital_cents", "available_balance_cents", "reserved_balance_cents", "total_recorded_expenses_cents", "total_recorded_revenue_cents", "realized_net_result_cents"]) {
      const changed = copy(ledger) as unknown as Record<string, unknown>;
      changed[field] = 999;
      expect(() => parse(changed)).toThrow("mismatch");
    }
    const changed = copy(ledger);
    changed.entries[0].description = "Edited history";
    expect(() => parse(changed)).toThrow("integrity");
    changed.entries[0].hash = "0".repeat(64);
    expect(() => parse(changed)).toThrow("integrity");
  });

  it("rejects extras, currency, unknown entry types and modified references", () => {
    const ledger = reserved();
    expect(() => parse({ ...ledger, extra: true })).toThrow();
    expect(() => parse({ ...ledger, currency: "USD" })).toThrow();
    expect(() => parse({ ...ledger, version: 4 })).toThrow();
    for (const changes of [{ extra: true }, { type: "payment" }, { type: ["reserve"] }, { amount_cents: -1 }, { timestamp: "yesterday" }, { id: "model-id" }]) {
      const changed = copy(ledger);
      Object.assign(changed.entries[1], changes);
      expect(() => parse(changed)).toThrow();
    }
    const changed = copy(ledger);
    Object.assign(changed.entries[1].experiment!, { extra: true });
    expect(() => parse(changed)).toThrow();
  });

  it("enforces chronological and accounting invariants even with recomputed hashes", () => {
    const changed = reserved();
    changed.entries[1].amount_cents = 2000;
    rehash(changed);
    expect(() => parse(changed)).toThrow("reservation");
    const duplicate = reserved();
    duplicate.entries.push({ ...duplicate.entries[1], id: "entry-000003" });
    rehash(duplicate);
    expect(() => parse(duplicate)).toThrow("Duplicate");
    const backwards = reserved();
    backwards.entries[1].timestamp = "2000-01-01T00:00:00.000Z";
    rehash(backwards);
    expect(() => parse(backwards)).toThrow("timestamp");
    const unauthorized = recordAuthorizedEvent(reserved(), event("expense", 10));
    unauthorized.entries[2].human_reference = null;
    rehash(unauthorized);
    expect(() => parse(unauthorized)).toThrow("human");
  });

  it("bounds ledger growth and lifetime money counters", () => {
    expect(() => parseEconomicLedger(" ".repeat(LEDGER_LIMITS.maxBytes + 1))).toThrow("size");
    expect(() => parse({ ...initializeLedger(0), entries: Array(1001).fill({}) })).toThrow("count");
    const ledger = recordAuthorizedEvent(initializeLedger(0), revenue(LEDGER_LIMITS.maxCents));
    expect(() => recordAuthorizedEvent(ledger, revenue(1, "new-ref"))).toThrow("limit");
  });
});

describe("V5 V4 compatibility and strict plan validation", () => {
  it("accepts the V4.1 output contract and only reserves its runtime numeric budget", () => {
    const validated = parseLedgerExperiment(JSON.stringify(plan));
    expect(validated).toEqual(plan);
    const ledger = reserveExperiment(initializeLedger(10000), validated);
    expect(ledger.entries.map(entry => entry.type)).toEqual(["initialization", "reserve"]);
    const free = { ...plan, experiment_budget_eur: 0, requires_real_spending: false, requires_human_approval: false };
    expect(reserveExperiment(initializeLedger(0), free).entries).toHaveLength(1);
    expect(reserveExperiment(initializeLedger(0), { ...plan, experiment_budget_eur: 0 }).entries).toHaveLength(1);
  });

  it.each([
    { version: 5 }, { status: "executed" }, { extra: true }, { experiment_budget_eur: 11 }, { experiment_budget_eur: 0.1 },
    { requires_human_approval: false }, { requires_real_spending: "true" }, { requires_publication: 1 },
    { duration_days: 8 }, { duration_days: "3" }, { actions: [] }, { actions: ["Already paid"] },
    { success_metrics: [] }, { expected_learning: "" }, { requires_real_spending: false },
  ])("rejects invalid V4 plan %j", change => {
    expect(() => parseLedgerExperiment(JSON.stringify({ ...plan, ...change }))).toThrow();
  });
});

describe("V5 confined atomic storage and CLI", () => {
  it("persists/reloads capital and ignores later initialization env changes", async () => {
    expect(scoutMode()).toBe("ledger");
    await runLedgerScout({ root });
    const original = await fs.readFile(path.join(root, "economic-ledger.json"), "utf8");
    vi.stubEnv("SCOUT_INITIAL_CAPITAL_EUR", "200");
    await runLedgerScout({ root });
    vi.stubEnv("SCOUT_INITIAL_CAPITAL_EUR", "invalid");
    await runLedgerScout({ root });
    expect(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8")).toBe(original);
    expect(parseEconomicLedger(original).initial_capital_cents).toBe(10000);
  });

  it("reserves the same V4 plan only once across runs and generates an honest report", async () => {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "experiment.json"), JSON.stringify(plan));
    await runLedgerScout({ root });
    await runLedgerScout({ root });
    const ledger = parseEconomicLedger(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8"));
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.total_recorded_expenses_cents).toBe(0);
    expect(ledger.total_recorded_revenue_cents).toBe(0);
    const report = await fs.readFile(path.join(root, "economic-report.txt"), "utf8");
    expect(report).toContain("Solde disponible : 90.00 EUR");
    expect(report).toContain("Approbation humaine : requise");
    expect(report).toContain("Aucune dépense ni action externe n'a été exécutée par Scout.");
    expect((await fs.readdir(root)).sort()).toEqual(["economic-ledger.json", "economic-report.txt", "experiment.json"]);
  });

  it("persists only explicitly authorized expense/revenue/release events", async () => {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "experiment.json"), JSON.stringify(plan));
    await runLedgerScout({ root });
    await recordLedgerEvent(event("expense", 20), root);
    await recordLedgerEvent(revenue(50), root);
    await recordLedgerEvent(event("release", 980, "release-ref"), root);
    await runLedgerScout({ root });
    const ledger = parseEconomicLedger(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8"));
    expect(ledger.available_balance_cents).toBe(10030);
    expect(ledger.realized_net_result_cents).toBe(30);
    expect(ledger.entries).toHaveLength(5);
    expect(buildEconomicReport(ledger)).toContain("Dépenses enregistrées : 0.20 EUR");
  });

  it("does not replace a corrupt ledger or initialize over invalid V4 data", async () => {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "economic-ledger.json"), "broken JSON");
    await expect(runLedgerScout({ root })).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8")).toBe("broken JSON");
    await fs.rm(path.join(root, "economic-ledger.json")); // Test fixture only, never recovery code.
    await fs.writeFile(path.join(root, "experiment.json"), '{"tool":"spend"}');
    await expect(runLedgerScout({ root })).rejects.toThrow();
    await expect(fs.stat(path.join(root, "economic-ledger.json"))).rejects.toThrow();
  });

  it("leaves old complete ledger untouched on failed atomic rename", async () => {
    await runLedgerScout({ root });
    const original = await fs.readFile(path.join(root, "economic-ledger.json"), "utf8");
    vi.mocked(fs.rename).mockImplementationOnce(async (source, destination) => {
      expect(String(source)).toContain(".economic-ledger-");
      expect(String(destination)).toBe(path.join(root, "economic-ledger.json"));
      const staged = parseEconomicLedger(await fs.readFile(source, "utf8"));
      expect(staged.total_recorded_revenue_cents).toBe(20);
      expect(await fs.readFile(destination, "utf8")).toBe(original);
      throw new Error("simulated disk failure before rename");
    });
    await expect(recordLedgerEvent(revenue(20), root)).rejects.toThrow("simulated disk failure");
    expect(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8")).toBe(original);
    expect((await fs.readdir(root)).sort()).toEqual(["economic-ledger.json", "economic-report.txt"]);
  });

  it("recovers a report write failure without duplicating a committed reservation", async () => {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "experiment.json"), JSON.stringify(plan));
    const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementationOnce(realFs.rename).mockRejectedValueOnce(new Error("report failed"));
    await expect(runLedgerScout({ root })).rejects.toThrow("report failed");
    expect(parseEconomicLedger(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8")).entries).toHaveLength(2);
    await runLedgerScout({ root });
    expect(parseEconomicLedger(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8")).entries).toHaveLength(2);
    expect(await fs.readFile(path.join(root, "economic-report.txt"), "utf8")).toContain("Montant réservé : 10.00 EUR");
  });

  it("refuses concurrent updates with an exclusive lock, preserving successful history", async () => {
    await runLedgerScout({ root });
    const results = await Promise.allSettled([recordLedgerEvent(revenue(1, "one"), root), recordLedgerEvent(revenue(2, "two"), root)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason.message).toContain("locked");
    expect(parseEconomicLedger(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8")).entries).toHaveLength(2);
  });

  it("does not steal stale locks or trust abandoned temporary files", async () => {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, ".economic-ledger.lock"), "stale lock");
    await fs.writeFile(path.join(root, ".economic-ledger-abandoned.tmp"), "broken temporary file");
    await expect(runLedgerScout({ root })).rejects.toThrow("locked");
    expect(await fs.readFile(path.join(root, ".economic-ledger.lock"), "utf8")).toBe("stale lock");
    await expect(fs.stat(path.join(root, "economic-ledger.json"))).rejects.toThrow();
  });

  it.each(["economic-ledger.json", "economic-report.txt", "experiment.json"])("blocks symlink destination/input %s", async name => {
    await fs.mkdir(root);
    const outside = path.join(temp, "outside");
    await fs.writeFile(outside, "untouched");
    await fs.symlink(outside, path.join(root, name));
    await expect(runLedgerScout({ root })).rejects.toThrow();
    expect(await fs.readFile(outside, "utf8")).toBe("untouched");
  });

  it("blocks symlink workspaces and hardlinked ledgers", async () => {
    await fs.mkdir(path.join(temp, "outside"));
    await fs.symlink(path.join(temp, "outside"), root);
    await expect(runLedgerScout({ root })).rejects.toThrow();
    await fs.unlink(root); await fs.mkdir(root);
    const source = path.join(temp, "original.json");
    await fs.writeFile(source, JSON.stringify(initializeLedger(10000)));
    await fs.link(source, path.join(root, "economic-ledger.json"));
    await expect(runLedgerScout({ root })).rejects.toThrow();
  });

  it("keeps economic files unavailable to generic file writes without adding a tool", async () => {
    const tools = createLocalWorkspaceTools(root);
    expect(tools.map(tool => tool.name)).toEqual(["list_files", "read_file", "write_file"]);
    const write = tools.find(tool => tool.name === "write_file")!;
    for (const name of ["economic-ledger.json", "./economic-ledger.json", "economic-report.txt", ".economic-ledger.lock", ".economic-ledger-x.tmp"]) {
      expect(await (write.execute as (args: Record<string, unknown>) => Promise<string>)({ path: name, content: "forged" })).toContain("runtime-controlled");
    }
  });

  it("runs the actual ledger CLI without Ollama config, mission or external calls", async () => {
    const result = await promisify(execFile)(process.execPath, ["dist/index.js", "--run"], {
      cwd: process.cwd(), env: { ...process.env, HOME: temp, SCOUT_MODE: "ledger", SCOUT_INITIAL_CAPITAL_EUR: "100", OLLAMA_BASE_URL: "invalid", SCOUT_MODEL: "not-a-model" }, timeout: 10000,
    });
    expect(result.stdout).toContain("economic-ledger.json and economic-report.txt verified");
    const actualRoot = path.join(temp, ".automaton", "scout-workspace");
    const ledger = parseEconomicLedger(await fs.readFile(path.join(actualRoot, "economic-ledger.json"), "utf8"));
    expect(ledger.available_balance_cents).toBe(10000);
  });
});
