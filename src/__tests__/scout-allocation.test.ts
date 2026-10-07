import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runAllocationScout, parseAllocationCommand } from "../agent/allocation-runner.js";
import { calculateAllocation } from "../agent/capital-allocator.js";
import { readAllocationSources, eurosToCents, researchCandidates, approvalPins } from "../agent/allocation-sources.js";
import { allocationStoreRoot, loadAllocation } from "../agent/allocation-store.js";
import { initializeLedger, parseEconomicLedger, recordAuthorizedEvent, reserveProjectReference } from "../agent/economic-ledger.js";
import { runProjectScout, parseProjectCommand } from "../agent/project-manager.js";
import { runMonitoringScout, parseMonitoringCommand } from "../agent/experiment-monitor.js";
import { parseOpportunityPhases, type ResearchEvidence } from "../agent/research-model.js";
import { scoreOpportunity, type OpportunityDraft } from "../agent/opportunity-scout.js";
import { createLocalWorkspaceTools } from "../agent/local-tools.js";
import { locked } from "../agent/ledger-runner.js";
import { canonicalHash } from "../agent/project-model.js";
import { PROJECT_LIMITS } from "../agent/asset-lifecycle.js";

vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(), rename: vi.fn((await original<typeof import("node:fs/promises")>()).rename) }));
let temp: string, root: string, fetchMock: ReturnType<typeof vi.fn>;
const specs = [{ name: "Projet A", cost: 1000, minutes: 25 }, { name: "Projet B", cost: 1000, minutes: 30 }, { name: "Projet remarquable", cost: 3500, minutes: 0 }];
function research(items = specs) {
  const evidence: ResearchEvidence[] = items.map((s, i) => ({ source_id: `research-source-${i + 1}`, url: `https://example.com/${encodeURIComponent(s.name)}`,
    text: `Le coût de ce projet est estimé à ${s.cost / 100} EUR. La demande reste à vérifier.`, query_id: "research-query-1", round: 1 }));
  const opportunities = items.map((s, i) => parseOpportunityPhases({ name: s.name, kind: i === 1 ? "DURABLE_ASSET" : "QUICK_SERVICE", source_index: i },
    JSON.stringify({ summary: "Test économique limité pour examen humain", estimated_cost_cents: s.cost, cost_basis: "SOURCE_ESTIMATE", human_minutes_daily: s.minutes, account_required: true }),
    JSON.stringify({ market: "Marché à vérifier", platform: "Distribution directe", fees: "Frais inconnus", quote: evidence[i].text }),
    JSON.stringify({ risks: ["Demande incertaine"], reason_surfaced: "Cette opportunité semble demander peu de supervision après validation.", mini_test_possible: false, mini_test_cost_cents: null, mini_test_description: "Mini-test inconnu" }), evidence, i));
  return { version: "11.1", status: "PASS", reason: "SOURCED_RESEARCH_ONLY_COSTS_AND_REVENUE_UNCONFIRMED", execution_budget_cents: 1000, research_horizon_cents: 10000,
    queries: [], evidence, opportunities, tool_requests: [], capabilities: [], operator_attention: [], metrics: {},
    security: { project_created: false, approval_created: false, external_action_executed: false, money_spent: false, capability_granted: false, installation_performed: false } };
}
const write = (name: string, value: unknown) => fs.writeFile(path.join(root, name), typeof value === "string" ? value : JSON.stringify(value));
const read = (name: string) => fs.readFile(path.join(root, name), "utf8");
const allocate = async (...args: string[]) => { vi.stubEnv("SCOUT_MODE", "allocation"); return runAllocationScout({ root, command: parseAllocationCommand(args.length ? args : ["--run"]) }); };
const v9 = async (...args: string[]) => { vi.stubEnv("SCOUT_MODE", args[0] === "--approve-project" || args[0] === "--deny-project" ? "approval" : "projects"); return JSON.parse(await runProjectScout({ root, command: parseProjectCommand(args) })); };
const inspect = async (p: any) => (await v9("--inspect-project", p.plan.project_id)).projects[0];
const target = (p: any) => [p.plan.project_id, "--experiment-id", p.experiment_id];
async function plan(name = "Projet A", budget = 1000) {
  const batch = (await v9("--create-batch")).batch;
  return (await v9("--create-project", batch.batch_id, "--name", name, "--hypothesis", "Test humain limité", "--budget-cents", String(budget), "--duration-days", "7")).projects[0];
}
async function reserve(p: any, approved = false, active = false) {
  await v9("--reserve-project", ...target(p)); p = await inspect(p);
  if (approved) await v9("--approve-project", ...target(p), "--request-id", p.approval.request.request_id);
  if (active) await v9("--start-project", ...target(p), "--request-id", p.approval.request.request_id);
  return inspect(p);
}
async function signedEdit(edit: (s: any) => void) {
  const dir = allocationStoreRoot(root), state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
  delete state.mac; edit(state);
  const key = Buffer.from((await fs.readFile(path.join(dir, "integrity-key"), "utf8")).trim(), "hex");
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ ...state, mac: createHmac("sha256", key).update(JSON.stringify(state)).digest("hex") }));
}
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v12-")); root = path.join(temp, ".automaton", "scout-workspace"); await fs.mkdir(root, { recursive: true });
  await write("economic-ledger.json", initializeLedger(10000)); await write("research.json", research());
  vi.stubEnv("OLLAMA_BASE_URL", "invalid"); vi.stubEnv("SCOUT_MODEL", "not-installed");
  fetchMock = vi.fn(() => { throw new Error("Network/Ollama forbidden"); }); vi.stubGlobal("fetch", fetchMock);
  vi.mocked(fs.rename).mockClear();
});
afterEach(async () => { expect(fetchMock).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await fs.rm(temp, { recursive: true, force: true }); });

describe("V12 capital separation and deterministic proposals", () => {
  it("100 EUR => two 10 EUR proposals, zero spend/approval/reservation mutations", async () => {
    const before = await read("economic-ledger.json"), r = await allocate();
    expect(r.proposal).toMatchObject({ confirmed_available_cents: 10000, confirmed_reserved_cents: 0, approved_allocation_cents: 0, total_confirmed_spent_cents: 0, total_proposed_cents: 2000, actually_spent_by_v12_cents: 0,
      status: "PROPOSAL_ONLY", notice: "NO REAL MONEY WAS SPENT BY V12", action_authorized: false, approval_created: false, capability_granted: false });
    expect(r.proposal.selected_projects).toHaveLength(2); expect(await read("economic-ledger.json")).toBe(before);
    expect((await fs.readdir(root)).sort()).toEqual(["capital-allocation.json", "economic-ledger.json", "research.json"]);
    expect(r.proposal.selected_projects.every(p => p.project_id === null && p.experiment_id === null)).toBe(true);
  });
  it.each([0, 999, 1000, 1500, 2000, 10000])("respects available capital of %s cents", async capital => {
    await write("economic-ledger.json", initializeLedger(capital)); const r = await allocate();
    expect(r.proposal.total_proposed_cents).toBeLessThanOrEqual(capital); expect(r.proposal.total_proposed_cents).toBeLessThanOrEqual(2000);
    expect(r.proposal.total_proposed_cents).toBe(capital < 1000 ? 0 : capital < 2000 ? 1000 : 2000);
  });
  it("ranks identically after reversing input order", async () => {
    const sources = await readAllocationSources(root, "research.json"), now = new Date().toISOString();
    expect(calculateAllocation(sources, now)).toEqual(calculateAllocation({ ...sources, candidates: [...sources.candidates].reverse() }, now));
  });
  it("ties have stable canonical ID ordering", async () => {
    await write("research.json", research(specs.slice(0, 2).map(s => ({ ...s, minutes: 25 }))));
    const r = await allocate(); expect(r.proposal.selected_projects.map(p => p.opportunity_id)).toEqual(["research-opportunity-1", "research-opportunity-2"]);
  });
  it("idempotent rerun preserves proposal bytes and emits no repeated attention", async () => {
    const a = await allocate(), raw = await read("capital-allocation.json"), b = await allocate();
    expect(b.proposal).toEqual(a.proposal); expect(await read("capital-allocation.json")).toBe(raw); expect(b.new_attention_items).toEqual([]);
  });
  it("supports explicit V3 source with existing score and uncertainty", async () => {
    const o: OpportunityDraft = { name: "Service test", summary: "Service à vérifier", startup_cost_eur: 7.25, time_to_first_revenue_days: 3, weekly_time_hours: 3, difficulty_1_5: 2, risk_1_5: 2, margin_potential_1_5: 3, scalability_1_5: 2, requires_account: true, requires_paid_service: false, key_risks: ["Demande incertaine"], first_three_steps: ["Comparer", "Interroger", "Évaluer"], evidence_source_indexes: [0] };
    await write("opportunities.json", { budget_eur: 100, opportunities: [{ ...o, score: scoreOpportunity(o, 100) }] });
    const r = await allocate("--run", "--source", "opportunity"); expect(r.proposal.total_proposed_cents).toBe(725);
    expect(r.proposal.selected_projects[0].uncertainties).toContain("DIVERSIFICATION_UNKNOWN"); expect(r.new_attention_items).toEqual([]);
  });
  it("never treats time to first revenue as guaranteed duration or profit", async () => {
    const r = await allocate(); expect(r.proposal.selected_projects[0].max_duration_days).toBe(7);
    expect(r.proposal.selected_projects[0].uncertainties).toContain("FUTURE_REVENUE_UNKNOWN"); expect(r.proposal.selected_projects[0].uncertainties).toContain("ACTUAL_EXPERIMENT_DURATION_UNKNOWN");
  });
  it("unknown costs stay null, block proposals and request missing human information", async () => {
    const input = research(specs.slice(0, 1)), o = input.opportunities[0];
    Object.assign(o, { estimated_cost_cents: null, cost_basis: "UNKNOWN", budget_excess_cents: null, classification: "COST_UNCONFIRMED", score: 35 });
    await write("research.json", input); const r = await allocate();
    expect(r.proposal.total_proposed_cents).toBe(0); expect(r.proposal.candidates_considered[0].estimated_cost_cents).toBeNull();
    expect(r.new_attention_items.some(i => i.category === "HUMAN_INTERVENTION_REQUIRED")).toBe(true);
  });
});

describe("V12 exact V9 lifecycle and exposure", () => {
  it("binds exact planned project IDs and keeps its existing budget", async () => {
    const p = await plan(); const r = await allocate();
    expect(r.proposal.selected_projects.find(x => x.project_id === p.plan.project_id)).toMatchObject({ experiment_id: p.experiment_id, proposed_cents: 1000 });
    expect(r.proposal.total_proposed_cents).toBe(2000);
  });
  it("does not increase an existing plan to fit a cost estimate", async () => {
    await plan("Projet A", 700); const r = await allocate();
    expect(r.proposal.rejected_candidates).toContainEqual({ opportunity_id: "research-opportunity-1", reason: "EXISTING_PLAN_BUDGET_TOO_SMALL" });
  });
  it("reserved project produces only its existing pending approval alert", async () => {
    const p = await reserve(await plan()); const r = await allocate();
    expect(r.proposal).toMatchObject({ confirmed_reserved_cents: 1000, approved_allocation_cents: 0, total_proposed_cents: 1000 });
    expect(r.new_attention_items.find(i => i.category === "APPROVAL_REQUIRED")?.details).toMatchObject({ request_id: p.approval.request.request_id, max_amount_cents: 1000 });
    expect(r.proposal.selected_projects.some(x => x.project_id === p.plan.project_id)).toBe(false);
  });
  it("an actual human approval updates snapshot and removes pending alert", async () => {
    const p = await reserve(await plan()); await allocate();
    await v9("--approve-project", ...target(p), "--request-id", p.approval.request.request_id);
    const r = await allocate(); expect(r.proposal.approved_allocation_cents).toBe(1000); expect(r.proposal.actually_spent_by_v12_cents).toBe(0);
    expect(r.proposal.attention_items.some(i => i.category === "APPROVAL_REQUIRED")).toBe(false);
  });
  it("unused budget never raises another project above 1000 cents", async () => {
    await reserve(await plan("Projet A", 0), true); const r = await allocate();
    expect(r.proposal.selected_projects).toHaveLength(1); expect(r.proposal.total_proposed_cents).toBe(1000);
  });
  it("closed/cancelled projects still occupy V9 initial batch slots", async () => {
    const p = await plan(); await v9("--cancel-project", ...target(p));
    await v9("--create-project", p.plan.batch_id, "--name", "Autre", "--hypothesis", "Test humain", "--budget-cents", "0", "--duration-days", "7");
    const r = await allocate(); expect(r.proposal.total_proposed_cents).toBe(0); expect(r.proposal.v9_batch_slots_used).toBe(2);
  });
  it("confirmed spending consumes exposure even after confirmed profitable revenue", async () => {
    let p = await reserve(await plan(), true, true);
    await v9("--close-experiment", ...target(p), "--request-id", p.approval.request.request_id, "--expense-cents", "1000", "--revenue-cents", "8000", "--classification", "successful", "--asset-policy", "retire");
    const r = await allocate(); expect(r.proposal).toMatchObject({ total_confirmed_spent_cents: 1000, total_confirmed_revenue_cents: 8000, total_proposed_cents: 1000 });
    expect(r.proposal.learning_evidence[0].derived_metrics.recommendation.kind).toBe("repeat_small");
    expect(r.proposal.total_proposed_cents + r.proposal.total_confirmed_spent_cents).toBeLessThanOrEqual(2000);
  });
  it("sale/expense claims affect neither cash nor confirmed spending", async () => {
    const p = await reserve(await plan(), true, true), ledgerBefore = await read("economic-ledger.json");
    vi.stubEnv("SCOUT_MODE", "monitoring");
    for (const type of ["sale_claim", "expense_claim"]) await runMonitoringScout({ root, command: parseMonitoringCommand(["--record-observation", ...target(p), "--type", type, "--amount-cents", "99999"]) });
    const r = await allocate(); expect(r.proposal.total_confirmed_spent_cents).toBe(0); expect(r.proposal.total_confirmed_revenue_cents).toBe(0);
    expect(await read("economic-ledger.json")).toBe(ledgerBefore);
  });
  it("expired active project blocks new proposals and requires human intervention", async () => {
    const p = await reserve(await plan(), true, true); vi.stubEnv("SCOUT_MODE", "allocation");
    const r = await runAllocationScout({ root, command: parseAllocationCommand(["--run"]), now: () => p.experiment_deadline });
    expect(r.proposal.total_proposed_cents).toBe(0); expect(r.new_attention_items.some(i => i.category === "HUMAN_INTERVENTION_REQUIRED" && i.blocks_allocation)).toBe(true);
  });
  it("deadline alone makes an old proposal stale and recalculable", async () => {
    const p = await reserve(await plan(), true, true); await allocate(); vi.stubEnv("SCOUT_MODE", "allocation");
    const inspect = await runAllocationScout({ root, command: { kind: "inspect" }, now: () => p.experiment_deadline }); expect(inspect.stale).toBe(true);
    const next = await runAllocationScout({ root, command: { kind: "calculate", input: "research.json" }, now: () => p.experiment_deadline }); expect(next.proposal.total_proposed_cents).toBe(0);
    expect(next.new_attention_items.some(i => i.category === "HUMAN_INTERVENTION_REQUIRED")).toBe(true);
  });
  it("standalone reservations also reduce total exposure headroom", async () => {
    let ledger = parseEconomicLedger(await read("economic-ledger.json"));
    for (const id of ["a", "b"]) ledger = reserveProjectReference(ledger, { id: id.repeat(64), name: `Standalone ${id}`, budget_cents: 750, requires_real_spending: true, requires_human_approval: true });
    await write("economic-ledger.json", ledger); const r = await allocate(); expect(r.proposal.total_proposed_cents).toBe(0); expect(r.proposal.confirmed_reserved_cents).toBe(1500);
  });
  it("uncovered unreserved plans fail to propose additional capital", async () => {
    await write("economic-ledger.json", initializeLedger(500)); await plan(); const r = await allocate(); expect(r.proposal.total_proposed_cents).toBe(0);
    expect(r.new_attention_items.some(i => i.category === "HUMAN_INTERVENTION_REQUIRED")).toBe(true);
  });
});

describe("V12 diversification and exception-based attention", () => {
  it("same evidence + market + platform rejects a duplicate exposure", async () => {
    const input = research(); input.opportunities[1].evidence = input.opportunities[0].evidence;
    await write("research.json", input); const r = await allocate(); expect(r.proposal.total_proposed_cents).toBe(1000);
    expect(r.proposal.rejected_candidates).toContainEqual({ opportunity_id: "research-opportunity-2", reason: "DUPLICATE_EXPOSURE" });
  });
  it("one remarkable sourced out-of-budget candidate is non-blocking, no authority", async () => {
    const r = await allocate(), items = r.new_attention_items.filter(i => i.category === "OUT_OF_BUDGET_OPPORTUNITY");
    expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ blocks_allocation: false, blocks_research: false, requires_human_decision: true, approval_created: false, capability_granted: false });
    expect(items[0].details).toMatchObject({ opportunity_id: "research-opportunity-3", estimated_cost_cents: 3500, current_ceiling_cents: 1000, excess_cents: 2500, score: 70, in_budget_baseline_score: 55, status: "NON_BLOCKING", execution_authorized: false });
    expect(r.proposal.selected_projects.some(p => p.opportunity_id === "research-opportunity-3")).toBe(false);
  });
  it("a score gap below 15 does not signal", async () => {
    await write("research.json", research(specs.map((s, i) => i === 0 ? { ...s, minutes: 24 } : s)));
    expect((await allocate()).new_attention_items).toEqual([]);
  });
  it("weak out-of-budget evidence/score does not signal", async () => {
    await write("research.json", research([{ name: "Faible", cost: 3500, minutes: 40 }])); expect((await allocate()).new_attention_items).toEqual([]);
  });
  it("unsourced cost never qualifies for out-of-budget alert", async () => {
    const input = research(); input.opportunities[2].cost_basis = "ASSUMPTION"; input.opportunities[2].score -= 10;
    await write("research.json", input); expect((await allocate()).new_attention_items).toEqual([]);
  });
  it("signals at most one of several remarkable opportunities", async () => {
    await write("research.json", research([{ name: "Hors A", cost: 3500, minutes: 0 }, { name: "Hors B", cost: 4000, minutes: 0 }, { name: "Hors C", cost: 4500, minutes: 0 }]));
    const r = await allocate(); expect(r.new_attention_items).toHaveLength(1); expect(r.proposal.total_proposed_cents).toBe(0);
  });
  it("deduplicates attention even when unrelated source state changes", async () => {
    await allocate(); await plan("Projet A", 1000); const r = await allocate(); expect(r.new_attention_items).toEqual([]);
  });
  it("reordering research indexes does not repeat the same out-of-budget opportunity", async () => {
    await allocate(); await write("research.json", research([specs[2], specs[1], specs[0]]));
    expect((await allocate()).new_attention_items).toEqual([]);
  });
  it("ordinary candidates require no invented approvals or INFO noise", async () => {
    await write("research.json", research(specs.slice(0, 2))); const r = await allocate(); expect(r.new_attention_items).toEqual([]);
  });
});

describe("V12 integrity, bounded storage and authenticated history", () => {
  it("inspects the existing proposal without any durable writes", async () => {
    await allocate(); const before = await read("capital-allocation.json"); vi.mocked(fs.rename).mockClear();
    const r = await allocate("--inspect-allocation"); expect(r.stale).toBe(false); expect(await read("capital-allocation.json")).toBe(before); expect(fs.rename).not.toHaveBeenCalled();
  });
  it("inspection marks changed sources stale without replacing a proposal", async () => {
    await allocate(); const before = await read("capital-allocation.json"); await write("research.json", research(specs.slice(0, 2)));
    const r = await allocate("--inspect-allocation"); expect(r.stale).toBe(true); expect(await read("capital-allocation.json")).toBe(before);
    expect((await allocate()).stale).toBe(false);
  });
  it.each(["economic-ledger.json", "research.json"])("missing essential %s fails closed", async name => {
    await fs.unlink(path.join(root, name)); await expect(allocate()).rejects.toThrow(); expect(await loadAllocation(root)).toEqual({});
  });
  it("rejects ledger with non-authenticated positive revenue", async () => {
    const ledger = recordAuthorizedEvent(parseEconomicLedger(await read("economic-ledger.json")), { type: "revenue", amount_cents: 99999, description: "Test", authorization: { source: "human", reference: "unanchored:test" } });
    await write("economic-ledger.json", ledger); await expect(allocate()).rejects.toThrow("Unauthenticated financial outcome");
  });
  it("detects financial history rollback even with valid rewritten chain", async () => {
    const initial = await read("economic-ledger.json"), p = await reserve(await plan()); await allocate();
    await write("economic-ledger.json", initial); await expect(allocate()).rejects.toThrow();
  });
  it("detects valid replacement of initial capital after anchoring", async () => {
    await allocate(); await write("economic-ledger.json", initializeLedger(50000)); await expect(allocate()).rejects.toThrow("prefix mismatch");
  });
  it.each(["integrity-key", "state.json"])("missing %s never regenerates an anchor", async name => {
    await allocate(); await fs.unlink(path.join(allocationStoreRoot(root), name)); await expect(allocate()).rejects.toThrow("Incomplete allocation anchor");
    await expect(fs.stat(path.join(allocationStoreRoot(root), name))).rejects.toThrow();
  });
  it("detects private state HMAC tampering", async () => {
    await allocate(); const stateFile = path.join(allocationStoreRoot(root), "state.json"), raw = await fs.readFile(stateFile, "utf8");
    await fs.writeFile(stateFile, raw.replace('"confirmed_available_cents": 10000', '"confirmed_available_cents": 99999'));
    await expect(allocate()).rejects.toThrow("authentication failed");
  });
  it.each(["corrupt", "orphan", "missing"])("public proposal %s fails closed", async kind => {
    if (kind !== "orphan") await allocate();
    if (kind === "missing") await fs.unlink(path.join(root, "capital-allocation.json")); else await write("capital-allocation.json", "{}");
    await expect(allocate()).rejects.toThrow(/projection|anchor/);
  });
  it("prepared transaction never auto-repairs", async () => {
    await allocate(); await signedEdit(s => { s.phase = "prepared"; }); await expect(allocate()).rejects.toThrow("Incomplete allocation transaction");
  });
  it("interrupted projection write leaves prepared state blocked", async () => {
    const rename = vi.mocked(fs.rename); rename.mockImplementation(async (a, b) => {
      if (String(b).endsWith("capital-allocation.json")) throw new Error("Simulated interrupted write");
      const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"); return real.rename(a, b);
    });
    await expect(allocate()).rejects.toThrow("Simulated interrupted write"); rename.mockRestore(); await expect(allocate()).rejects.toThrow("Incomplete allocation transaction");
  });
  it("attention history limit fails closed instead of dropping dedup IDs", async () => {
    await allocate(); await signedEdit(s => { s.seen_attention_ids = Array.from({ length: 128 }, (_, i) => `allocation-attention-${canonicalHash(i)}`); });
    await write("research.json", research([{ name: "Nouveau hors budget", cost: 4000, minutes: 0 }])); await expect(allocate()).rejects.toThrow("size limit");
  });
  it("source mutation during an atomic write leaves allocation blocked", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementation(async (a, b) => {
      await actual.rename(a, b);
      if (String(b).endsWith("capital-allocation.json")) await write("research.json", research(specs.slice(0, 2)));
    });
    await expect(allocate()).rejects.toThrow("sources changed"); vi.mocked(fs.rename).mockRestore();
    await expect(allocate()).rejects.toThrow("Incomplete allocation transaction");
  });
  it("workspace directory symlink is rejected", async () => {
    const moved = path.join(temp, "moved-workspace"); await fs.rename(root, moved); await fs.symlink(moved, root);
    await expect(allocate()).rejects.toThrow("unsafe directory");
  });
  it.each(["research.json", "capital-allocation.json"])("rejects symlink %s", async name => {
    await fs.unlink(path.join(root, name)).catch(() => undefined); const outside = path.join(temp, "outside"); await fs.writeFile(outside, "{}"); await fs.symlink(outside, path.join(root, name));
    await expect(allocate()).rejects.toThrow("unsafe file"); expect(await fs.readFile(outside, "utf8")).toBe("{}");
  });
  it.each(["research.json", "capital-allocation.json"])("rejects hardlink %s", async name => {
    await fs.unlink(path.join(root, name)).catch(() => undefined); const outside = path.join(temp, "outside"); await fs.writeFile(outside, "{}"); await fs.link(outside, path.join(root, name));
    await expect(allocate()).rejects.toThrow("unsafe file");
  });
  it("rejects permissive private store", async () => { await allocate(); await fs.chmod(allocationStoreRoot(root), 0o755); await expect(allocate()).rejects.toThrow("private"); });
  it("does not accept oversized inputs", async () => { await write("research.json", "x".repeat(128 * 1024 + 1)); await expect(allocate()).rejects.toThrow("oversized"); });
  it("does not accept clock rollback", async () => {
    const r = await allocate(); vi.stubEnv("SCOUT_MODE", "allocation");
    await expect(runAllocationScout({ root, command: { kind: "calculate", input: "research.json" }, now: () => new Date(Date.parse(r.proposal.generated_at) - 1).toISOString() })).rejects.toThrow("clock rollback");
  });
  it("pins V6 immutable requests while allowing pending-to-approved transition", () => {
    const r: any = { request: { request_id: "one", max_amount_cents: 1000, status: "pending" }, decision: null };
    const before = approvalPins([r]), after = approvalPins([{ ...r, request: { ...r.request, status: "approved" }, decision: { status: "approved" } }]);
    expect(after.requests).toEqual(before.requests); expect(before.decisions).toEqual([]); expect(after.decisions).toHaveLength(1);
  });
});

describe("V12 CLI confinement and concurrency", () => {
  it.each(["--pay", "--approve", "--execute", "--publish", "--install", "--create-project", "--reserve-project"])("CLI refuses %s before config/inference", async flag => {
    await expect(promisify(execFile)(process.execPath, ["dist/index.js", flag], { env: { ...process.env, SCOUT_MODE: "allocation", OLLAMA_BASE_URL: "invalid", HOME: temp } })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Allocation accepts") });
  });
  it.each([["--run", "--source", "../evil"], ["--run", "--pay"], ["--inspect-allocation", "--source", "research"], ["--run", "--source", "research", "--source", "opportunity"], []])("strict parser rejects ambiguous command %j", args => expect(() => parseAllocationCommand(args)).toThrow());
  it("model workspace writer cannot modify V12 outputs", async () => {
    const writer = createLocalWorkspaceTools(root).find(t => t.name === "write_file")!;
    for (const name of ["capital-allocation.json", "nested/capital-allocation.json", ".capital-allocation.tmp"]) expect(await writer.execute({ path: name, content: "{}" }, {} as any)).toContain("runtime-controlled");
  });
  it("concurrent host calls keep exactly one bounded current proposal", async () => {
    vi.stubEnv("SCOUT_MODE", "allocation"); const results = await Promise.allSettled(Array.from({ length: 2 }, () => runAllocationScout({ root, command: { kind: "calculate", input: "research.json" } })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(String((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason)).toContain("Ledger locked");
    expect((await loadAllocation(root)).state!.proposal.total_proposed_cents).toBe(2000);
  });
  it("shared finance lock excludes a second CLI process", async () => {
    await locked(root, async () => await expect(promisify(execFile)(process.execPath, ["dist/index.js", "--run"], { env: { ...process.env, SCOUT_MODE: "allocation", HOME: temp } })).rejects.toMatchObject({ stderr: expect.stringContaining("Ledger locked") }));
  });
  it("two real CLI processes never create additive exposure or duplicate alerts", async () => {
    const env = { ...process.env, SCOUT_MODE: "allocation", HOME: temp, OLLAMA_BASE_URL: "invalid" };
    const results = await Promise.allSettled(Array.from({ length: 2 }, () => promisify(execFile)(process.execPath, ["dist/index.js", "--run"], { env })));
    const completed = results.filter(r => r.status === "fulfilled").map(r => JSON.parse((r as PromiseFulfilledResult<{ stdout: string }>).value.stdout));
    expect(completed.length).toBeGreaterThan(0); expect(completed.reduce((n, r) => n + r.new_attention_items.length, 0)).toBe(1);
    expect((await loadAllocation(root)).state!.proposal.total_proposed_cents).toBe(2000);
    for (const result of results) if (result.status === "rejected") expect(result.reason.stderr).toContain("Ledger locked");
    const inspected = JSON.parse((await promisify(execFile)(process.execPath, ["dist/index.js", "--inspect-allocation"], { env })).stdout); expect(inspected.stale).toBe(false);
  });
  it.each([NaN, Infinity, -1, -0, 0.001, 1.001, 1e20])("rejects invalid monetary euro value %s", n => expect(() => eurosToCents(n)).toThrow());
  it("cent conversion never rounds fractions", () => { expect(eurosToCents(7.25)).toBe(725); expect(eurosToCents(0.29)).toBe(29); });
  it.each(["score", "estimated_cost_cents", "execution_authorized", "kind"])("research %s tampering rejected", field => {
    const input = research(); (input.opportunities[0] as any)[field] = field === "execution_authorized" ? true : field === "kind" ? "OTHER" : 99999;
    expect(() => researchCandidates(JSON.stringify(input))).toThrow();
  });
  it("V9 limits are unchanged", () => expect(PROJECT_LIMITS).toMatchObject({ MAX_ACTIVE_PROJECTS: 2, MAX_PROJECT_BUDGET_CENTS: 1000, MAX_BATCH_BUDGET_CENTS: 2000, MAX_EXPERIMENT_DURATION_DAYS: 7 }));
});
