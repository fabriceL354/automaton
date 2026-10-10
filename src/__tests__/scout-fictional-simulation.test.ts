import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ts from "typescript";
import { SIMULATION_LIMITS, SIMULATION_NOTICE, simulateFictionalScenarios, type FictionalScenario } from "../agent/fictional-simulation.js";

const base: FictionalScenario = { scenario_id: "central", budget_cents: 1000, fixed_cost_cents: 601, unit_cost_cents: 100, unit_price_cents: 300, units: 4 };
const input = (...scenarios: unknown[]) => ({ version: "14.1", kind: "FICTIONAL_SIMULATION", currency: "EUR", scenarios });
const row = (changes: Partial<FictionalScenario> = {}) => simulateFictionalScenarios(input({ ...base, ...changes })).scenarios[0];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("V14.1 calculations", () => {
  it("compares explicit hypothetical costs, revenues, losses and thresholds", () => {
    const r = simulateFictionalScenarios(input(
      { ...base, scenario_id: "pessimistic", units: 0 },
      { ...base, scenario_id: "optimistic", units: 6 }, base,
    ));
    expect(r.scenarios.map(s => [s.input.scenario_id, s.hypothetical_variable_cost_cents,
      s.hypothetical_total_cost_cents, s.hypothetical_revenue_cents, s.hypothetical_net_result_cents, s.exceeds_fictional_budget])).toEqual([
      ["central", 400, 1001, 1200, 199, true],
      ["optimistic", 600, 1201, 1800, 599, true],
      ["pessimistic", 0, 601, 0, -601, false],
    ]);
    expect(r.scenarios.every(s => s.unit_margin_cents === 200 && s.break_even.units === 4 && s.break_even.revenue_cents === 1200)).toBe(true);
  });
  it("uses ceiling division; the preceding sale loses money", () => {
    expect(row().break_even).toEqual({ units: 4, revenue_cents: 1200, reason: "FINITE" });
    expect(row({ units: 3 }).hypothetical_net_result_cents).toBe(-1);
    expect(row({ fixed_cost_cents: 600, units: 3 }).hypothetical_net_result_cents).toBe(0);
    expect(row({ fixed_cost_cents: 600 }).break_even.units).toBe(3);
  });
  it("checks ceiling thresholds over a bounded grid of fixed costs and margins", () => {
    for (const fixed of [0, 1, 199, 200, 201, 999, 1000]) for (const margin of [1, 3, 100, 201]) {
      const changes = { fixed_cost_cents: fixed, unit_price_cents: 100 + margin };
      const threshold = row(changes).break_even.units!;
      expect(row({ ...changes, units: threshold }).hypothetical_net_result_cents).toBeGreaterThanOrEqual(0);
      if (threshold > 0) expect(row({ ...changes, units: threshold - 1 }).hypothetical_net_result_cents).toBeLessThan(0);
    }
  });
  it.each([0, 99, 100])("does not invent a profitable threshold at a nonpositive margin (%s)", price => {
    const r = row({ unit_price_cents: price });
    expect(r.break_even).toEqual({ units: null, revenue_cents: null, reason: "NON_POSITIVE_MARGIN" });
    expect(r.hypothetical_net_result_cents).toBeLessThan(0);
  });
  it("distinguishes all-zero economics, no fixed costs and loss-making sales", () => {
    expect(row({ fixed_cost_cents: 0, unit_cost_cents: 0, unit_price_cents: 0, units: 0 }).break_even)
      .toEqual({ units: 0, revenue_cents: 0, reason: "ALWAYS_BREAK_EVEN" });
    expect(row({ fixed_cost_cents: 0, unit_price_cents: 101 }).break_even.reason).toBe("FINITE");
    expect(row({ fixed_cost_cents: 0, unit_price_cents: 99 }).break_even.reason).toBe("NON_POSITIVE_MARGIN");
    expect(row({ fixed_cost_cents: 0, unit_price_cents: 100 }).hypothetical_net_result_cents).toBe(0);
  });
  it("retains budget overruns instead of clipping and accepts exact budget equality", () => {
    expect(row({ budget_cents: 1001 }).exceeds_fictional_budget).toBe(false);
    expect(row({ budget_cents: 0 }).hypothetical_total_cost_cents).toBe(1001);
    expect(row({ budget_cents: 0 }).exceeds_fictional_budget).toBe(true);
  });
  it("accepts exact cent and volume limits including the signed result bound", () => {
    expect(row({ fixed_cost_cents: SIMULATION_LIMITS.MAX_CENTS, unit_cost_cents: 0, unit_price_cents: 0, units: SIMULATION_LIMITS.MAX_UNITS }).hypothetical_net_result_cents).toBe(-SIMULATION_LIMITS.MAX_CENTS);
    expect(row({ fixed_cost_cents: 0, unit_cost_cents: 0, unit_price_cents: 100_000, units: SIMULATION_LIMITS.MAX_UNITS }).hypothetical_net_result_cents).toBe(SIMULATION_LIMITS.MAX_CENTS);
  });
  it.each([
    { unit_cost_cents: 500_000_001, units: 2 },
    { fixed_cost_cents: 1, unit_cost_cents: 500_000_000, units: 2 },
    { unit_price_cents: 500_000_001, units: 2 },
  ])("rejects overflowing products or sums even if the net would fit: %j", changes => {
    expect(() => row(changes)).toThrow("SIMULATION_RESULT_OVERFLOW");
  });
  it("keeps thresholds outside volume or cent bounds explicitly unavailable", () => {
    expect(row({ fixed_cost_cents: 10001, unit_cost_cents: 0, unit_price_cents: 1, units: 0 }).break_even.reason).toBe("OUTSIDE_LIMITS");
    expect(row({ fixed_cost_cents: 10000, unit_cost_cents: 0, unit_price_cents: 1, units: 0 }).break_even.units).toBe(10000);
    expect(row({ fixed_cost_cents: 2, unit_cost_cents: 999_999_999, unit_price_cents: 1_000_000_000, units: 0 }).break_even)
      .toEqual({ units: null, revenue_cents: null, reason: "OUTSIDE_LIMITS" });
  });
  it("reproduces identical JSON across ordering, ambient state and independent calls", () => {
    const a = { ...base, scenario_id: "a" }, z = { ...base, scenario_id: "z", units: 1 };
    const expected = JSON.stringify(simulateFictionalScenarios(input(z, a)));
    vi.stubEnv("SCOUT_MODE", "learning"); vi.stubEnv("SCOUT_INITIAL_CAPITAL_EUR", "999");
    vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("Clock forbidden"); });
    vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("Randomness forbidden"); });
    expect(JSON.stringify(simulateFictionalScenarios(input(a, z)))).toBe(expected);
    expect(JSON.stringify(simulateFictionalScenarios(JSON.parse(JSON.stringify(input(z, a)))))).toBe(expected);
    const differentlyOrdered = { units: a.units, unit_price_cents: a.unit_price_cents, unit_cost_cents: a.unit_cost_cents,
      fixed_cost_cents: a.fixed_cost_cents, budget_cents: a.budget_cents, scenario_id: a.scenario_id };
    expect(simulateFictionalScenarios(input(differentlyOrdered, z))).toEqual(JSON.parse(expected));
  });
  it("does not mutate or retain aliases to caller inputs, outputs or limits", () => {
    const s = { ...base }, request = input(s);
    Object.freeze(s); Object.freeze(request.scenarios); Object.freeze(request);
    const result = simulateFictionalScenarios(request);
    expect(result.scenarios[0].input).not.toBe(s);
    result.scenarios[0].input.fixed_cost_cents = 0;
    expect(s.fixed_cost_cents).toBe(601);
    expect(row().hypothetical_total_cost_cents).toBe(1001);
    expect(Object.isFrozen(SIMULATION_LIMITS)).toBe(true);
  });
});

describe("V14.1 strict input", () => {
  it.each([null, undefined, 0, "{}", [], {}, { version: "14.1" }])("rejects a malformed root: %j", value => {
    expect(() => simulateFictionalScenarios(value)).toThrow();
  });
  it.each(["version", "kind", "currency"])("rejects a changed %s discriminator", field => {
    expect(() => simulateFictionalScenarios({ ...input(base), [field]: "other" })).toThrow("SIMULATION_INVALID_SCHEMA");
  });
  it.each(["budget_cents", "fixed_cost_cents", "unit_cost_cents", "unit_price_cents", "units"])("requires explicit bounded integers for %s", field => {
    for (const value of [null, undefined, "1", true, -1, -0, 0.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER,
      field === "units" ? SIMULATION_LIMITS.MAX_UNITS + 1 : SIMULATION_LIMITS.MAX_CENTS + 1])
      expect(() => simulateFictionalScenarios(input({ ...base, [field]: value }))).toThrow("SIMULATION_INVALID_INTEGER");
    const missing: Record<string, unknown> = { ...base }; delete missing[field];
    expect(() => simulateFictionalScenarios(input(missing))).toThrow("SIMULATION_INVALID_FIELDS");
  });
  it.each(["", "A", "two words", "../ledger", "https://example.com", "a\n", "é", "a".repeat(49), null, 1])("rejects an invalid scenario id: %j", id => {
    expect(() => simulateFictionalScenarios(input({ ...base, scenario_id: id }))).toThrow("SIMULATION_INVALID_ID");
  });
  it("bounds and uniquely identifies scenarios, rejects sparse/custom arrays", () => {
    expect(() => simulateFictionalScenarios(input())).toThrow("SIMULATION_SCENARIO_LIMIT");
    expect(() => simulateFictionalScenarios(input(...Array.from({ length: 4 }, (_, i) => ({ ...base, scenario_id: `s-${i}` }))))).toThrow("SIMULATION_SCENARIO_LIMIT");
    expect(() => simulateFictionalScenarios(input(base, base))).toThrow("SIMULATION_DUPLICATE_ID");
    for (const scenarios of [new Array(1), null, { 0: base, length: 1 }, Object.assign([base], { extra: true })])
      expect(() => simulateFictionalScenarios({ ...input(base), scenarios })).toThrow();
    expect(row({ scenario_id: "a".repeat(48) }).input.scenario_id).toHaveLength(48);
  });
  it.each(["execute", "root", "proof", "approval", "learning", "seed", "source_url"])("rejects the extra capability/source field %s at both levels", key => {
    expect(() => simulateFictionalScenarios({ ...input(base), [key]: true })).toThrow("SIMULATION_INVALID_FIELDS");
    expect(() => simulateFictionalScenarios(input({ ...base, [key]: true }))).toThrow("SIMULATION_INVALID_FIELDS");
  });
  it("rejects inherited fields, symbols, hidden fields and accessors without invoking them", () => {
    const getter = vi.fn(() => base.units);
    const accessor = { ...base }; Object.defineProperty(accessor, "units", { get: getter, enumerable: true });
    const array = [base]; Object.defineProperty(array, "0", { get: getter, enumerable: true });
    const hidden = { ...base }; Object.defineProperty(hidden, "extra", { value: true });
    const hiddenKnown = { ...base }; Object.defineProperty(hiddenKnown, "units", { value: 4, enumerable: false });
    for (const s of [accessor, hidden, hiddenKnown, Object.create(base), { ...base, [Symbol("extra")]: true }])
      expect(() => simulateFictionalScenarios(input(s))).toThrow();
    expect(() => simulateFictionalScenarios({ ...input(base), scenarios: array })).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it("returns no partial comparison when any scenario is invalid", () => {
    expect(() => simulateFictionalScenarios(input(base, { ...base, scenario_id: "bad", units: 10001 }))).toThrow();
  });
});

describe("V14.1 capability isolation", () => {
  it("has no static/dynamic dependencies or access to external capabilities", async () => {
    const source = await fs.readFile(new URL("../agent/fictional-simulation.ts", import.meta.url), "utf8");
    const ast = ts.createSourceFile("fictional-simulation.ts", source, ts.ScriptTarget.Latest, true);
    const forbidden: string[] = [];
    const capabilities = new Set(["fetch", "process", "globalThis", "require", "eval", "Function", "Date", "Math", "Buffer", "setTimeout", "setInterval", "XMLHttpRequest", "WebSocket"]);
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier ||
        ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node) && capabilities.has(node.text)) forbidden.push(node.getText(ast));
      ts.forEachChild(node, visit);
    }
    visit(ast); expect(forbidden).toEqual([]);
    const fetchSpy = vi.fn(() => { throw new Error("Network/Ollama forbidden"); }); vi.stubGlobal("fetch", fetchSpy);
    expect(row().hypothetical_net_result_cents).toBe(199); expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("labels every report as fictitious and never grants evidence, learning or authority", () => {
    expect(simulateFictionalScenarios(input(base))).toMatchObject({ version: "14.1", kind: "FICTIONAL_SIMULATION", fictional: true,
      real_evidence: false, authenticated_learning_eligible: false, action_authorized: false, execution_allowed: false,
      financial_transfer_performed: false, money_moved_cents: 0, available_funds_increase_cents: 0, notice: SIMULATION_NOTICE });
  });
});

describe("V14.1 protected state", () => {
  it("reproduces identical reports in fresh compiled processes with different environments", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const url = new URL("../../dist/agent/fictional-simulation.js", import.meta.url).href;
    const script = `globalThis.fetch = () => { throw new Error('Network forbidden'); };
      Date.now = Math.random = () => { throw new Error('Nondeterminism forbidden'); };
      const { simulateFictionalScenarios } = await import(${JSON.stringify(url)});
      process.stdout.write(JSON.stringify(simulateFictionalScenarios(JSON.parse(process.argv[1]))));`;
    const a = { ...base, scenario_id: "a" }, z = { ...base, scenario_id: "z", units: 0 };
    const expected = JSON.stringify(simulateFictionalScenarios(input(a, z)));
    for (const [timezone, request] of [["UTC", input(a, z)], ["Europe/Paris", input(z, a)]] as const) {
      const result = await run(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(request)],
        { env: { ...process.env, TZ: timezone, SCOUT_MODE: "learning" }, timeout: 5000 });
      expect(result.stdout).toBe(expected); expect(result.stderr).toBe("");
    }
  });
  it("leaves a genuine V13 workspace, HMAC state, decisions and terminal stop byte-identical", async () => {
    const { createPreparationExample } = await import("../../scripts/scout-v12-7-example.mjs");
    const { runPilotPreparation } = await import("../agent/pilot-preparation.js");
    const { runPilotReadiness } = await import("../agent/pilot-readiness.js");
    const { runOperationalPlanning, stopOperationalPlanning } = await import("../agent/operational-planning.js");
    const { inMode } = await import("./scout-control-fixtures.js");
    const { parseEconomicLedger } = await import("../agent/economic-ledger.js");
    const { validateDefinition } = await import("../agent/learning-model.js");
    const { validateOperationalPlan } = await import("../agent/operational-planning-model.js");
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-fictional-isolation-")), root = path.join(temp, "workspace");
    async function snapshot(dir: string): Promise<Record<string, string>> {
      const files: Record<string, string> = {};
      for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const name = path.join(dir, entry.name);
        if (entry.isDirectory()) { files[path.relative(temp, name) + "/"] = "directory"; Object.assign(files, await snapshot(name)); }
        else files[path.relative(temp, name)] = (await fs.readFile(name)).toString("hex");
      }
      return files;
    }
    try {
      await createPreparationExample(root);
      const prepared = await inMode("pilot-preparation", () => runPilotPreparation({ root, command: { kind: "prepare" } }));
      const p = prepared.projects[0], r = p.requests[0];
      await inMode("pilot-preparation", () => runPilotPreparation({ root, command: { kind: "approve", project_id: p.project_id,
        action_id: r.action_id, request_id: r.request_id, fingerprint: r.fingerprint } }));
      await inMode("pilot-readiness", () => runPilotReadiness({ root, command: { kind: "prepare-handover" } }));
      await inMode("operational-planning", () => runOperationalPlanning({ root, command: { kind: "plan" } }));
      await inMode("operational-planning", () => stopOperationalPlanning({ root, command: { kind: "halt", reason: "operator-stop" } }));
      const before = await snapshot(temp);
      const fetchSpy = vi.fn(() => { throw new Error("Network/Ollama forbidden"); }); vi.stubGlobal("fetch", fetchSpy);
      vi.stubEnv("SCOUT_WORKSPACE", root); vi.stubEnv("SCOUT_MODE", "operational-planning");
      const report = simulateFictionalScenarios(input(base));
      expect(() => parseEconomicLedger(JSON.stringify(report))).toThrow();
      expect(() => validateDefinition(report as any)).toThrow();
      expect(() => validateOperationalPlan(report as any)).toThrow();
      expect(await snapshot(temp)).toEqual(before);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect((await inMode("operational-planning", () => stopOperationalPlanning({ root, command: { kind: "stop-status" } }))).stopped).toBe(true);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  });
});
