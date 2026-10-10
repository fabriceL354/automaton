import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { runOperationalPlanning, stopOperationalPlanning, parsePlanningCommand, renderPlanningReport } from "../agent/operational-planning.js";
import { simulateEconomics, validateOperationalPlan, validateOperationalPlanning, appendPlanningEvent, buildOperationalPlan, PLANNING_LIMITS } from "../agent/operational-planning-model.js";
import { runPilotPreparation, preparationControlView } from "../agent/pilot-preparation.js";
import * as preparationHost from "../agent/pilot-preparation.js";
import { runPilotReadiness } from "../agent/pilot-readiness.js";
import { loadPreparation, preparationStoreRoot, decodePreparation, savePreparation } from "../agent/pilot-preparation-store.js";
import { createLocalWorkspaceTools } from "../agent/local-tools.js";
import { initializeLedger } from "../agent/economic-ledger.js";
import { runLedgerScout, locked } from "../agent/ledger-runner.js";
import { pilotStopRoot } from "../agent/pilot-stop.js";
import { canonicalHash } from "../agent/project-model.js";
import { inMode } from "./scout-control-fixtures.js";
import { createPreparationExample } from "../../scripts/scout-v12-7-example.mjs";

describe("V13 pure economic simulations", () => {
  it("calculates three ordered sensitivity cases in integer cents", () => {
    const cases = simulateEconomics({ budget_cents: 1000, baseline_cost_cents: 601, baseline_revenue_cents: 1001 });
    expect(cases.map(s => [s.name, s.estimated_cost_cents, s.hypothetical_revenue_cents, s.projected_result_cents])).toEqual([
      ["pessimistic", 1000, 0, -1000], ["central", 601, 1001, 400], ["optimistic", 480, 1501, 1021],
    ]);
    expect(cases.every(s => !s.revenue_is_acquired && s.revenue_added_to_available_funds_cents === 0 && s.bank_verified_result_cents === null)).toBe(true);
  });
  it("keeps absent estimates unknown rather than inventing zero costs or profit", () => {
    const cases = simulateEconomics({ budget_cents: 1000, baseline_cost_cents: null, baseline_revenue_cents: null });
    expect(cases.map(s => s.estimated_cost_cents)).toEqual([null, null, null]);
    expect(cases.map(s => s.hypothetical_revenue_cents)).toEqual([0, null, null]);
    expect(cases.every(s => s.projected_result_cents === null && s.unknown_cost && s.unknown_revenue)).toBe(true);
  });
  it("retains estimates above the ceiling and flags them instead of clipping", () => {
    const cases = simulateEconomics({ budget_cents: 500, baseline_cost_cents: 900, baseline_revenue_cents: 0 });
    expect(cases.map(s => s.estimated_cost_cents)).toEqual([900, 900, 720]);
    expect(cases.every(s => s.exceeds_budget)).toBe(true);
  });
  it("handles zero estimates without treating missing values as zero", () => {
    expect(simulateEconomics({ budget_cents: 0, baseline_cost_cents: 0, baseline_revenue_cents: 0 }).every(s => s.projected_result_cents === 0 && !s.unknown_cost && !s.unknown_revenue)).toBe(true);
  });
  it.each([-1, -0, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER, "100"])("rejects invalid cents %s", value => {
    expect(() => simulateEconomics({ budget_cents: 1000, baseline_cost_cents: value as number, baseline_revenue_cents: 0 })).toThrow();
    expect(() => simulateEconomics({ budget_cents: 1000, baseline_cost_cents: 0, baseline_revenue_cents: value as number })).toThrow();
  });
  it("rejects a widened budget, unknown fields and optimistic output overflow", () => {
    expect(() => simulateEconomics({ budget_cents: 1001, baseline_cost_cents: 0, baseline_revenue_cents: 0 })).toThrow("SPENDING_CEILING_EXCEEDED");
    expect(() => simulateEconomics({ budget_cents: 0, baseline_cost_cents: 0, baseline_revenue_cents: 0, execute: true } as any)).toThrow();
    expect(() => simulateEconomics({ budget_cents: 1000, baseline_cost_cents: 0, baseline_revenue_cents: 1_000_000_000 })).toThrow();
  });
});

describe("V13 authenticated planning host", () => {
  let temp: string, root: string;
  const read = (file: string) => fs.readFile(path.join(root, file), "utf8");
  const stateRaw = () => fs.readFile(path.join(preparationStoreRoot(root), "state.json"), "utf8");
  const prep = (command: any = { kind: "prepare" }, now?: string) => inMode("pilot-preparation", () => runPilotPreparation({ root, command, ...(now ? { now: () => now } : {}) }));
  const ready = (command: any = { kind: "prepare-handover" }) => inMode("pilot-readiness", () => runPilotReadiness({ root, command }));
  const run = (command: any = { kind: "plan" }, now?: string) => inMode("operational-planning", () => runOperationalPlanning({ root, command, ...(now ? { now: () => now } : {}) }));
  const stop = (command: any = { kind: "halt", reason: "operator-stop" }) => inMode("operational-planning", () => stopOperationalPlanning({ root, command }));
  const scope = (p: any) => ({ project_id: p.project_id, dossier_hash: p.dossier_hash, action_id: p.requests[0].action_id, request_id: p.requests[0].request_id, fingerprint: p.requests[0].fingerprint });
  async function edit(change: (d: any) => void) { const d = JSON.parse(await read("pilot-preparation-input.json")); change(d); await fs.writeFile(path.join(root, "pilot-preparation-input.json"), JSON.stringify(d)); }
  async function prepared() { await prep(); return ready(); }
  async function authorize() {
    // Synthetic fixtures only: no real economic action or account.
    await edit(d => d.dossiers.forEach((p: any) => { p.fictional = false; }));
    const p = (await prep()).projects[0], r = p.requests[0];
    await prep({ kind: "review", project_id: p.project_id, dossier_hash: p.dossier_hash, quote_cents: 600, cost_proof_id: p.dossier.proofs[0].proof_id });
    await prep({ kind: "approve", project_id: p.project_id, action_id: r.action_id, request_id: r.request_id, fingerprint: r.fingerprint });
    await ready(); return p;
  }
  function child(operation = "plan", cliArgs?: string[]) {
    return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const p = spawn(process.execPath, cliArgs ? ["dist/index.js", ...cliArgs] : ["src/__tests__/fixtures/planning-child.mjs", root, operation], {
        cwd: process.cwd(), env: { ...process.env, SCOUT_MODE: "operational-planning" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let out = ""; p.stdout!.on("data", d => { out += d; }); p.stderr!.on("data", d => { out += d; });
      const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("Planning child exceeded 15-second deadline")); }, 15000);
      p.on("error", e => { clearTimeout(timer); reject(e); }); p.on("close", code => { clearTimeout(timer); resolve({ code, out }); });
    });
  }
  beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-planning-test-")); root = path.join(temp, "workspace"); await createPreparationExample(root); });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(temp, { recursive: true, force: true }); });

  it("requires explicit mode, V12.7 preparation and V12.8 supervision", async () => {
    await expect(runOperationalPlanning({ root, command: { kind: "plan" } })).rejects.toThrow("SCOUT_MODE");
    await expect(run()).rejects.toThrow("V12.7"); await prep(); await expect(run()).rejects.toThrow("V12_8_HANDOVER_REQUIRED");
  });
  it("proposes dependencies, risks, criteria and three scenarios with no financial writer", async () => {
    await prepared(); const ledger = await read("economic-ledger.json"), r = await run();
    expect(r.plan.projects).toHaveLength(2); expect(r.plan_recorded).toBe(true);
    expect(r.plan).toMatchObject({ execution_allowed: false, financial_transfer_performed: false, money_moved_cents: 0 });
    for (const p of r.plan.projects) {
      expect(p.economics.scenarios).toHaveLength(3); expect(p.started_at).toBeNull(); expect(p.real_deadline).toBeNull();
      const seen = new Set<string>();
      for (const a of p.actions) { expect(a.depends_on.every(id => seen.has(id))).toBe(true); seen.add(a.action_id); expect(a.executable).toBe(false); expect(a.risks.length).toBeGreaterThan(0); expect(a.success_criteria.length).toBeGreaterThan(0); }
    }
    expect(r.decision_dossiers.every(p => p.blockers.includes("ATOMIC_HANDOVER_NOT_IMPLEMENTED") && p.blockers.includes("V13_EXECUTION_NOT_IMPLEMENTED"))).toBe(true);
    expect(await read("economic-ledger.json")).toBe(ledger); expect(await fs.readdir(root)).not.toContain("project-batch.json");
    expect(renderPlanningReport(r)).toContain("Autorisation ≠ exécution");
  });
  it("uses a human reviewed quote for the baseline without calling it bank proof", async () => {
    await authorize(); const r = await run(), p = r.plan.projects[0];
    expect(p.economics.cost_basis).toBe("HUMAN_REVIEWED_QUOTE_NOT_BANK_PROOF");
    expect(p.economics.scenarios.map(s => s.estimated_cost_cents)).toEqual([1000, 600, 480]);
    expect(p.economics.verified_expense_cents).toBeNull();
  });
  it("replays identically without rewriting or duplicating audit, including a new process", async () => {
    await prepared(); const r = await run(), raw = await stateRaw(); const repeat = await run();
    expect(repeat.plan).toEqual(r.plan); expect(await stateRaw()).toBe(raw);
    expect((await child()).code).toBe(0); expect(await stateRaw()).toBe(raw); expect(repeat.audit).toHaveLength(1);
  });
  it("reports before planning without creating a plan or renewing approvals", async () => {
    await prepared(); const raw = await stateRaw(), r = await run({ kind: "report" });
    expect(r.plan_recorded).toBe(false); expect(r.created_at).toBeNull(); expect(r.decision_dossiers[0].blockers).toContain("PLAN_NOT_RECORDED"); expect(await stateRaw()).toBe(raw);
  });
  it("checks a scoped approval without consuming it or marking any execution", async () => {
    const p = await authorize(), r = await run(), before = (await loadPreparation(root)).state!.projects;
    const c = { kind: "check-action", plan_id: r.plan.plan_id, scope: scope(p) }, checked = await run(c);
    expect(checked.audit.at(-1)?.result).toBe("EXACT_AUTHORIZATION_CURRENT_NO_EXECUTION");
    expect(checked.execution_allowed).toBe(false); expect((await loadPreparation(root)).state!.projects).toEqual(before);
    const raw = await stateRaw(); await run(c); expect(await stateRaw()).toBe(raw);
  });
  it.each(["project_id", "dossier_hash", "action_id", "request_id", "fingerprint"])("rejects and records altered %s scope", async field => {
    const p = await authorize(), r = await run(), wrong = { ...scope(p), [field]: field.endsWith("hash") || field === "fingerprint" ? "f".repeat(64) : "wrong-id" };
    await expect(run({ kind: "check-action", plan_id: r.plan.plan_id, scope: wrong })).rejects.toThrow("SCOPE_MISMATCH");
    expect((await run({ kind: "events" })).audit.at(-1)?.result).toBe("SCOPE_MISMATCH");
  });
  it("rejects a different plan identity", async () => {
    const p = await authorize(); await run(); await expect(run({ kind: "check-action", plan_id: "unknown-plan", scope: scope(p) })).rejects.toThrow("SCOPE_MISMATCH");
  });
  it.each(["pending", "denied"])("does not accept %s authorizations", async status => {
    const p = (await prep()).projects[0], s = scope(p);
    if (status === "denied") await prep({ kind: "deny", project_id: s.project_id, action_id: s.action_id, request_id: s.request_id, fingerprint: s.fingerprint });
    await ready(); const r = await run(); await expect(run({ kind: "check-action", plan_id: r.plan.plan_id, scope: s })).rejects.toThrow("APPROVAL_REQUIRED");
  });
  it("blocks fictitious projects even with exact approved requests", async () => {
    const p = (await prep()).projects[0], s = scope(p); await prep({ kind: "approve", project_id: s.project_id, action_id: s.action_id, request_id: s.request_id, fingerprint: s.fingerprint });
    await ready(); const r = await run(); await expect(run({ kind: "check-action", plan_id: r.plan.plan_id, scope: s })).rejects.toThrow("DOSSIER_BLOCKED");
  });
  it("rejects expiry at its boundary and never renews the decision", async () => {
    const p = await authorize(), r = await run();
    await expect(run({ kind: "check-action", plan_id: r.plan.plan_id, scope: scope(p) }, p.dossier.review_expires_at)).rejects.toThrow("APPROVAL_EXPIRED");
    const expired = await run({ kind: "report" }, p.dossier.review_expires_at);
    expect(expired.decision_dossiers[0].blockers).toContain("APPROVAL_EXPIRED"); expect(expired.decision_dossiers[0].exact_authorizations[0].status).toBe("approved");
    const raw = await stateRaw(); await expect(run(undefined, p.dossier.review_expires_at)).rejects.toThrow("APPROVAL_EXPIRED"); expect(await stateRaw()).toBe(raw);
  });
  it("rejects clock rollback", async () => { await prepared(); const r = await run(); await expect(run({ kind: "report" }, new Date(Date.parse(r.generated_at) - 1000).toISOString())).rejects.toThrow("clock rollback"); });
  it("archives changes in decisions as a new plan and refuses old plan checks", async () => {
    await prepared(); const old = await run(), p = old.decision_dossiers[0], r = p.exact_authorizations[0];
    await prep({ kind: "approve", project_id: p.project_id, action_id: r.action_id, request_id: r.request_id, fingerprint: r.fingerprint });
    await expect(run({ kind: "report" })).rejects.toThrow("PLAN_SOURCE_CHANGED");
    await expect(run({ kind: "check-action", plan_id: old.plan.plan_id, scope: { project_id: p.project_id, dossier_hash: p.dossier_hash, action_id: r.action_id, request_id: r.request_id, fingerprint: r.fingerprint } })).rejects.toThrow("PLAN_SOURCE_CHANGED");
    const next = await run(); expect(next.plan.plan_id).not.toBe(old.plan.plan_id); expect(next.archived_plan_ids).toEqual([old.plan.plan_id, next.plan.plan_id]);
    expect(next.audit.every(e => !e.execution_performed)).toBe(true);
  });
  it("never converts declarations into available funds or acquired revenue", async () => {
    const p = await authorize(); await prep({ kind: "declare", project_id: p.project_id, declaration_id: "claim", economic_kind: "revenue", amount_cents: 900, phase: "post_experiment", proof_id: p.dossier.proofs[0].proof_id });
    const ledger = await read("economic-ledger.json"), r = await run();
    expect(r.decision_dossiers[0].declarations[0].verification).toBe("UNVERIFIED_HUMAN_DECLARATION");
    expect(r.decision_dossiers[0].confirmed_revenue_cents).toBeNull(); expect(r.plan.projects[0].economics.available_funds_increase_cents).toBe(0); expect(await read("economic-ledger.json")).toBe(ledger);
  });
  it.each(["dossier", "proof", "research", "ledger", "mac", "approval", "provenance"])("refuses changed %s without repairing the history", async kind => {
    await prepared(); await run();
    if (kind === "dossier") await edit(d => { d.dossiers[0].offer = "Changed"; });
    if (kind === "proof") await fs.appendFile(path.join(root, "evidence/quote-1.txt"), "changed");
    if (kind === "research") await fs.appendFile(path.join(root, "research.json"), " ");
    if (kind === "ledger") await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(initializeLedger(9999)));
    if (["mac", "approval", "provenance"].includes(kind)) {
      const raw = JSON.parse(await stateRaw());
      if (kind === "mac") raw.mac = "f".repeat(64);
      if (kind === "approval") raw.state.projects[0].requests[0].status = "approved";
      if (kind === "provenance") raw.state.planning.plans[0].plan.provenance.input_hash = "f".repeat(64);
      await fs.writeFile(path.join(preparationStoreRoot(root), "state.json"), JSON.stringify(raw));
    }
    const before = await stateRaw(); await expect(run()).rejects.toThrow(); expect(await stateRaw()).toBe(before);
  });
  it("refuses transplanted authenticated state from a different workspace", async () => {
    await prepared(); await run(); const other = path.join(temp, "other"); await fs.cp(root, other, { recursive: true });
    await fs.cp(preparationStoreRoot(root), preparationStoreRoot(other), { recursive: true });
    await expect(inMode("operational-planning", () => runOperationalPlanning({ root: other, command: { kind: "plan" } }))).rejects.toThrow("Invalid preparation state");
  });
  it("refuses missing and unsafe evidence", async () => {
    await prepared(); await fs.unlink(path.join(root, "evidence/quote-1.txt")); await expect(run()).rejects.toThrow("MISSING_EVIDENCE");
    await fs.symlink(path.join(root, "evidence/market-1.txt"), path.join(root, "evidence/quote-1.txt")); await expect(run()).rejects.toThrow("unsafe file");
  });
  it("rechecks sources before commit", async () => {
    await prepared(); const original = preparationHost.readPreparationSnapshot; let calls = 0;
    vi.spyOn(preparationHost, "readPreparationSnapshot").mockImplementation(async (...args) => {
      if (++calls === 2) await fs.appendFile(path.join(root, "research.json"), " ");
      return original(...args);
    });
    const raw = await stateRaw(); await expect(run()).rejects.toThrow(); expect(await stateRaw()).toBe(raw);
  });
  it("rejects recomputed proposal hashes with altered economic logic or dependencies", async () => {
    await prepared(); const r = await run();
    for (const kind of ["scenario", "dependency", "execution"] as const) {
      const p = structuredClone(r.plan);
      if (kind === "scenario") p.projects[0].economics.scenarios[0].projected_result_cents = 1;
      if (kind === "dependency") p.projects[0].actions[0].depends_on = ["review-result"];
      if (kind === "execution") (p.projects[0].actions[0] as any).executable = true;
      const { plan_hash: _h, plan_id: _i, ...body } = p; p.plan_hash = canonicalHash(body); p.plan_id = `operational-plan-${p.plan_hash}`;
      expect(() => validateOperationalPlan(p)).toThrow("mismatch");
    }
  });
  it("validates audit chain and rejects an execution flag even under a fresh hash", async () => {
    await prepared(); await run(); const loaded = await loadPreparation(root), s = structuredClone(loaded.state!.planning!);
    (s.events[0] as any).execution_performed = true; const { hash: _h, ...body } = s.events[0]; s.events[0].hash = canonicalHash(body);
    expect(() => validateOperationalPlanning(s, loaded.state!.updated_at)).toThrow("chain");
    await expect(savePreparation(root, { ...loaded.state!, planning: s }, loaded.key)).rejects.toThrow();
  });
  it("rejects a validly constructed proposal with different authenticated provenance", async () => {
    await prepared(); await run(); const loaded = await loadPreparation(root), state = structuredClone(loaded.state!);
    const p = buildOperationalPlan({ ...state.planning!.plans[0].plan.provenance, input_hash: "f".repeat(64) }, state.projects);
    state.planning = { version: "13", plans: [{ created_at: state.updated_at, plan: p }], events: [] };
    appendPlanningEvent(state.planning, state.updated_at, p.plan_id, null, "PLAN_RECORDED_NO_EXECUTION");
    await expect(savePreparation(root, state, loaded.key)).rejects.toThrow("provenance binding");
  });
  it("bounds plan archives and audit without truncating history", async () => {
    await prepared(); await run(); const loaded = await loadPreparation(root), state = loaded.state!, s = state.planning!;
    const base = s.plans[0].plan;
    for (let i = 1; i < PLANNING_LIMITS.MAX_PLANS; i++) {
      const p = buildOperationalPlan({ ...base.provenance, allocation_sources_hash: canonicalHash(i) }, state.projects);
      s.plans.push({ created_at: state.updated_at, plan: p }); appendPlanningEvent(s, state.updated_at, p.plan_id, null, "PLAN_RECORDED_NO_EXECUTION");
    }
    await savePreparation(root, state, loaded.key); const p = state.projects[0], r = p.requests[0];
    await prep({ kind: "approve", project_id: p.project_id, action_id: r.action_id, request_id: r.request_id, fingerprint: r.fingerprint });
    const raw = await stateRaw(); await expect(run()).rejects.toThrow("history full"); expect(await stateRaw()).toBe(raw);
    const events = structuredClone(s);
    while (events.events.length < PLANNING_LIMITS.MAX_EVENTS) appendPlanningEvent(events, state.updated_at, base.plan_id, { ...scope(p), action_id: `action-${events.events.length}` }, "SCOPE_MISMATCH");
    expect(() => appendPlanningEvent(events, state.updated_at, base.plan_id, { ...scope(p), action_id: "extra" }, "SCOPE_MISMATCH")).toThrow("audit full");
    expect((await stop()).stopped).toBe(true);
  });
  it("shares the original lock and does not steal it", async () => {
    await prepared(); await inMode("operational-planning", () => locked(root, async () => { const result = await child(); expect(result.code).toBe(2); expect(result.out).toContain("Ledger locked"); }, "planning"));
    expect((await child()).code).toBe(0);
  });
  it("serializes competing processes without duplicate plans or affectations", async () => {
    await prepared(); const results = await Promise.all([child(), child()]);
    expect(results.some(r => r.code === 0)).toBe(true); expect(results.every(r => r.code === 0 || r.code === 2 && r.out.includes("Ledger locked"))).toBe(true);
    const r = await run({ kind: "report" }); expect(r.audit).toHaveLength(1); expect((await loadPreparation(root)).state!.projects.reduce((n, p) => n + p.reserved_budget_cents, 0)).toBe(2000);
  });
  it.each(["crash-before-rename", "crash-after-rename"])("preserves complete old or new authenticated state after %s", async operation => {
    await prepared(); const old = await stateRaw(), loaded = await loadPreparation(root), result = await child(operation);
    expect(result.code).toBe(operation === "crash-before-rename" ? 31 : 32);
    const raw = await stateRaw(), state = decodePreparation(raw, root, loaded.key!);
    if (operation === "crash-before-rename") expect(raw).toBe(old); else expect(state.planning!.plans).toHaveLength(1);
    await expect(run()).rejects.toThrow("stale lock"); expect((await stop()).stopped).toBe(true);
  });
  it("stop arriving during commit never returns permission", async () => {
    await prepared(); const ledger = await read("economic-ledger.json"), result = await child("halt-before-rename");
    expect(result.code).toBe(2); expect(result.out).toContain("EMERGENCY_STOP");
    const r = await run({ kind: "report" }); expect(r.execution_allowed).toBe(false); expect(r.emergency_stop.stopped).toBe(true); expect(await read("economic-ledger.json")).toBe(ledger);
  });
  it("persists emergency stop across processes, preserves read access and legacy sealing", async () => {
    await prepared(); await run(); const raw = await stateRaw(); expect((await child("halt")).code).toBe(0);
    expect((await child()).out).toContain("EMERGENCY_STOP"); expect((await run({ kind: "report" })).decision_dossiers.every(p => p.blockers.includes("EMERGENCY_STOP"))).toBe(true);
    await expect(inMode("ledger", () => runLedgerScout({ root }))).rejects.toThrow("EMERGENCY_STOP"); expect(await stateRaw()).toBe(raw);
  });
  it("stop remains usable with corrupt state and a stale lock", async () => {
    await prepared(); await fs.writeFile(path.join(preparationStoreRoot(root), "state.json"), "broken"); await fs.writeFile(path.join(root, ".economic-ledger.lock"), "stale");
    expect((await stop()).stopped).toBe(true); expect((await stop({ kind: "stop-status" })).stopped).toBe(true);
    await expect(run({ kind: "report" })).rejects.toThrow();
  });
  it("an incomplete stop receipt is still terminal", async () => { await prepared(); await fs.mkdir(pilotStopRoot(root), { mode: 0o700 }); await expect(run()).rejects.toThrow("EMERGENCY_STOP"); });
  it("keeps V12.7, V12.8 and Control projections compatible after planning", async () => {
    await prepared(); await run(); expect((await prep({ kind: "inspect" })).projects).toHaveLength(2);
    expect((await ready({ kind: "report" })).execution_allowed).toBe(false);
    expect((await inMode("control-api", () => preparationControlView(root)))!.projects.every(p => !p.can_execute)).toBe(true);
    await expect(inMode("ledger", () => runLedgerScout({ root }))).rejects.toThrow("sealed");
  });
  it("has zero network/Ollama calls and preserves original workspace artifacts", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    await prepared(); const before = await fs.readdir(root), ledger = await read("economic-ledger.json"); await run(); await run({ kind: "report" });
    expect(fetchSpy).not.toHaveBeenCalled(); expect(await fs.readdir(root)).toEqual(before); expect(await read("economic-ledger.json")).toBe(ledger);
  });
  it("rejects execution CLI routes before reading or changing any workspace", async () => {
    for (const args of [["--start"], ["--pay"], ["--publish"], ["--execute"], ["--run"], ["--resume"], ["--plan", "extra"]]) expect(() => parsePlanningCommand(args)).toThrow("PLANNING_COMMAND_FORBIDDEN");
    const result = await child("", ["--execute"]); expect(result.code).toBe(1); expect(JSON.parse(result.out)).toMatchObject({ version: "13", execution_allowed: false, money_moved_cents: 0 });
  });
  it("model tools cannot forge planning artifacts", async () => {
    const tool = createLocalWorkspaceTools(root).find(t => t.name === "write_file")!;
    for (const file of ["operational-planning.json", ".operational-planning.json", "nested/operational-planning-report.md"])
      expect(await tool.execute({ path: file, content: "forged" }, {} as any)).toContain("runtime-controlled");
  });
});
