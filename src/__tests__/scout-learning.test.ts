import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as https from "node:https";
import * as dns from "node:dns/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runProjectScout, parseProjectCommand } from "../agent/project-manager.js";
import { projectStoreRoot } from "../agent/project-store.js";
import { runMonitoringScout, parseMonitoringCommand } from "../agent/experiment-monitor.js";
import { observationStoreRoot } from "../agent/observation-store.js";
import { runLearningScout, parseLearningCommand, auditLearning } from "../agent/economic-learning.js";
import { learningStoreRoot, loadLearningState, saveLearning } from "../agent/learning-store.js";
import { LEARNING_LIMITS, evidenceLevel, strictStatus, strictRecommendation, rational, boundedReport, validateLearningCommand, type LearningEvent } from "../agent/learning-model.js";
import { readLearningSources, buildProjectEvidence, verifyFinancialTotals, assertNoConflicts, historicalSources, sourcePin, type Sources } from "../agent/evidence-builder.js";
import { initializeLedger, parseEconomicLedger, reserveExperiment, experimentReference } from "../agent/economic-ledger.js";
import { runRevenueScout, revenueStoreRoot } from "../agent/revenue-runner.js";
import { runApprovalScout } from "../agent/approval-gate.js";
import { createLocalWorkspaceTools } from "../agent/local-tools.js";
import { PROJECT_LIMITS } from "../agent/asset-lifecycle.js";
import { canonicalHash, type Project } from "../agent/project-model.js";
import type { ExperimentPlan } from "../agent/experiment-runner.js";
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(), rename: vi.fn((await original<typeof import("node:fs/promises")>()).rename) }));
vi.mock("node:https", async original => ({ ...await original<typeof import("node:https")>(), request: vi.fn(() => { throw new Error("Network forbidden"); }) }));
vi.mock("node:dns/promises", async original => ({ ...await original<typeof import("node:dns/promises")>(), lookup: vi.fn(() => { throw new Error("DNS forbidden"); }) }));
let temp: string, root: string, a: Project, b: Project, batchId: string, fetchMock: ReturnType<typeof vi.fn>;
const start = Date.parse("2026-10-06T12:00:00.000Z"), day = 86400000;
const setDay = (n: number) => vi.setSystemTime(start + n * day);
const target = (p: Project) => [p.plan.project_id, "--experiment-id", p.experiment_id];
const read = (name: string) => fs.readFile(path.join(root, name), "utf8");
const ledger = async () => parseEconomicLedger(await read("economic-ledger.json"));
const learn = async (...args: string[]) => { vi.stubEnv("SCOUT_MODE", "learning"); return runLearningScout({ root, command: parseLearningCommand(args) }); };
const analyze = async (p = a) => (await learn("--analyze-project", ...target(p))).evidence[0];
async function v9(...args: string[]) {
  vi.stubEnv("SCOUT_MODE", args[0] === "--approve-project" ? "approval" : "projects");
  return JSON.parse(await runProjectScout({ root, command: parseProjectCommand(args) }));
}
const inspect = async (p: Project) => (await v9("--inspect-project", p.plan.project_id)).projects[0] as Project;
const v10 = async (...args: string[]) => { vi.stubEnv("SCOUT_MODE", "monitoring"); return runMonitoringScout({ root, command: parseMonitoringCommand(args) }); };
const observe = (p: Project, type: string, ...fields: string[]) => v10("--record-observation", ...target(p), "--type", type, ...fields);
const metric = (p: Project, value: number) => observe(p, "inquiry", "--metric", "inquiries", "--value", String(value));
async function close(p = a, expense = 600, revenue = 400, keep = true) {
  await v9("--close-experiment", ...target(p), "--request-id", p.approval!.request.request_id, "--expense-cents", String(expense), "--revenue-cents", String(revenue), "--classification", expense > revenue ? "failed" : "successful", "--asset-policy", keep ? "keep" : "retire");
  return inspect(p);
}
async function passive(amount = 1300) {
  await v9("--record-passive-revenue", ...target(a), "--asset-id", a.asset!.asset_id, "--receipt-id", `receipt-${randomUUID()}`, "--revenue-cents", String(amount));
}
const hid = () => `hypothesis-${randomUUID()}`;
const create = (id = hid(), rule = "experiment_profitability", extra: string[] = []) => learn("--create-hypothesis", id, "--batch-id", batchId, "--statement", "Hypothèse humaine à tester", "--rule", rule, ...extra);
async function tree(directory: string): Promise<unknown> {
  return Promise.all((await fs.readdir(directory)).sort().map(async name => { const full = path.join(directory, name), stat = await fs.lstat(full); return [name, stat.isDirectory() ? await tree(full) : await fs.readFile(full, "utf8")]; }));
}
async function closedPair() { setDay(7); a = await close(); b = await close(b, 500, 900, false); }
async function signedLearningEdit(edit: (state: any) => void) {
  const dir = learningStoreRoot(root), state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
  edit(state); delete state.mac;
  const key = Buffer.from((await fs.readFile(path.join(dir, "integrity-key"), "utf8")).trim(), "hex");
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ ...state, mac: createHmac("sha256", key).update(JSON.stringify(state)).digest("hex") }));
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); setDay(0);
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v11-")); root = path.join(temp, "workspace"); await fs.mkdir(root);
  await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(initializeLedger(10000)));
  vi.stubEnv("OLLAMA_BASE_URL", "invalid"); vi.stubEnv("SCOUT_MODEL", "not-installed");
  fetchMock = vi.fn(() => { throw new Error("No network or inference"); }); vi.stubGlobal("fetch", fetchMock);
  vi.mocked(fs.rename).mockClear(); vi.mocked(https.request).mockClear(); vi.mocked(dns.lookup).mockClear();
  batchId = (await v9("--create-batch")).batch.batch_id;
  const active = async (name: string) => {
    let p = (await v9("--create-project", batchId, "--name", name, "--hypothesis", "Hypothèse source", "--budget-cents", "1000", "--duration-days", "7")).projects.at(-1);
    await v9("--reserve-project", ...target(p)); p = await inspect(p);
    await v9("--approve-project", ...target(p), "--request-id", p.approval.request.request_id);
    await v9("--start-project", ...target(p), "--request-id", p.approval.request.request_id); return inspect(p);
  };
  a = await active("A"); b = await active("B"); await v9("--create-asset", ...target(a)); a = await inspect(a);
});
afterEach(async () => {
  expect(fetchMock).not.toHaveBeenCalled(); expect(https.request).not.toHaveBeenCalled(); expect(dns.lookup).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); await fs.rm(temp, { recursive: true, force: true });
});

describe("V11 deterministic evidence and separate horizons", () => {
  it("reports null pending results instead of inventing zero profit", async () => {
    const e = await analyze(); expect(e.facts.financial_status).toBe("pending_result"); expect(e.derived_metrics.experiment_net_cents).toBeNull();
    expect(e.derived_metrics.lifetime_net_cents).toBeNull(); expect(e.derived_metrics.score.value).toBeNull(); expect(e.derived_metrics.recommendation.kind).toBe("insufficient_evidence");
  });
  it("reconstructs exact A/B experiment and lifetime finances with traceable references", async () => {
    await closedPair(); setDay(30); await passive(); const r = await learn("--analyze-batch", batchId), [ea, eb] = r.evidence;
    expect(ea.facts).toMatchObject({ experiment_expense_cents: 600, experiment_revenue_cents: 400, post_experiment_revenue_cents: 1300 });
    expect(ea.derived_metrics).toMatchObject({ experiment_net_cents: -200, deadline_net_cents: -200, lifetime_revenue_cents: 1700, lifetime_net_cents: 1100, experiment_outcome: "negative", lifetime_outcome: "positive" });
    expect(eb.derived_metrics).toMatchObject({ experiment_net_cents: 400, lifetime_net_cents: 400 }); expect(r.confidence).toBe("very_low");
    expect(ea.source_refs.result_id).toBe(a.result!.result_id); expect(ea.source_refs.financial_entries.filter(e => e.type === "revenue").map(e => e.amount_cents)).toEqual([400,1300]);
    expect(ea.derived_metrics.recommendation.kind).toBe("modify_and_retry");
  });
  it("late closure cannot pretend to be an exact deadline snapshot", async () => {
    setDay(9); await close(); const e = await analyze(); expect(e.derived_metrics.deadline_net_cents).toBeNull(); expect(e.derived_metrics.actual_duration_ms).toBe(9 * day);
  });
  it("early closure retains actual duration and does not invent J+7", async () => {
    setDay(2); await close(); const e = await analyze(); expect(e.derived_metrics.deadline_net_cents).toBeNull(); expect(e.derived_metrics.actual_duration_ms).toBe(2 * day);
  });
  it("unreconciled sale and expense claims never affect financial facts", async () => {
    await observe(a,"sale_claim","--amount-cents","99999"); await observe(a,"expense_claim","--amount-cents","777"); setDay(7); await close();
    const e = await analyze(); expect(e.observations.claims).toHaveLength(2); expect(e.facts.experiment_revenue_cents).toBe(400); expect(e.facts.experiment_expense_cents).toBe(600);
  });
  it("a reconciled claim links the original ledger proof without double counting", async () => {
    const claim = (await observe(a,"sale_claim","--amount-cents","400")).event!; setDay(7); a = await close();
    const entry = (await ledger()).entries.find(e => a.result!.ledger_entry_ids.includes(e.id) && e.type === "revenue")!;
    await v10("--reconcile-observation", ...target(a), "--observation-id", claim.event_id, "--ledger-entry-id", entry.id);
    const e = await analyze(); expect(e.observations.claims[0].reconciliation?.ledger_entry_id).toBe(entry.id); expect(e.derived_metrics.lifetime_revenue_cents).toBe(400);
  });
  it("first income time comes from confirmed ledger, never an earlier claim", async () => {
    setDay(1); await observe(a,"sale_claim","--amount-cents","400"); setDay(7); await close();
    expect((await analyze()).derived_metrics.time_to_first_confirmed_revenue_ms).toBe(7 * day);
  });
  it("first income can come from a passive receipt after zero experiment revenue", async () => {
    setDay(7); await close(a,600,0); setDay(30); await passive(); expect((await analyze()).derived_metrics.time_to_first_confirmed_revenue_ms).toBe(30 * day);
  });
  it("zero revenue means confirmed zero and no first-income timestamp", async () => {
    setDay(7); await close(a,600,0); const e = await analyze(); expect(e.facts.experiment_revenue_cents).toBe(0); expect(e.facts.first_confirmed_revenue_at).toBeNull(); expect(e.derived_metrics.time_to_first_confirmed_revenue_ms).toBeNull();
  });
  it("zero expense keeps rational ratios null", async () => {
    setDay(7); await close(a,0,400); const e = await analyze(); expect(e.facts.experiment_expense_cents).toBe(0); expect(e.derived_metrics.revenue_per_euro_spent).toBeNull(); expect(e.derived_metrics.net_per_euro_spent).toBeNull();
  });
  it("stores exact rational ratios and an explainable non-probabilistic score", async () => {
    await closedPair(); const e = await analyze(); expect(e.derived_metrics.revenue_per_euro_spent).toEqual({numerator:400,denominator:600}); expect(e.derived_metrics.net_per_euro_spent).toEqual({numerator:-200,denominator:600});
    expect(e.derived_metrics.score).toMatchObject({value:-3,is_probability:false,meaning:"descriptive_only"}); expect(await analyze()).toEqual(e);
  });
  it("handles metric snapshots and missing metrics without summing or inventing zeros", async () => {
    setDay(1); await metric(a,2); setDay(3); await metric(a,4); await closedPair(); const e = await analyze();
    expect(e.observations.experiment_metrics.inquiries.value).toBe(4); expect(e.observations.experiment_metrics.leads).toBeUndefined(); expect(e.observations.asset_metrics).toEqual({});
  });
  it("passive metrics stay separate from experimental signals", async () => {
    await metric(a,4); await closedPair(); setDay(8); await v10("--asset-observation",...target(a),"--asset-id",a.asset!.asset_id,"--type","inquiry","--metric","inquiries","--value","9");
    const e = await analyze(); expect(e.observations.experiment_metrics.inquiries.value).toBe(4); expect(e.observations.asset_metrics.inquiries.value).toBe(9);
  });
  it("risks, blockers, checkpoints and human classification stay distinct", async () => {
    await observe(a,"risk","--note","Risque déclaré"); await observe(a,"blocker","--note","Blocage déclaré"); await v10("--checkpoint",...target(a),"--checkpoint","start"); await closedPair();
    const e = await analyze(); expect(e.observations.risks).toHaveLength(1); expect(e.observations.blockers).toHaveLength(1); expect(e.observations.checkpoints).toHaveLength(1);
    expect(e.original_hypothesis).toMatchObject({human_classification:"failed",automatic_validation:"not_inferred"}); expect(e.derived_metrics.recommendation.kind).toBe("modify_and_retry");
  });
  it("compares only exact A/B, flags unequal costs and never selects a winner", async () => {
    await closedPair(); const r = await learn("--compare",a.plan.project_id,b.plan.project_id);
    expect(r.comparison).toMatchObject({winner:null,generalization:"insufficient_evidence",confidence:"very_low",sample_size:2,lifetime_net_difference_a_minus_b_cents:-600});
    expect(r.comparison!.warnings).toContain("UNEQUAL_CONFIRMED_COSTS"); expect(r.comparison!.warnings).toContain("UNEQUAL_LIFETIME_EXPOSURE_OR_ASSET_STATE");
  });
  it("comparison warns on missing outcomes and unequal actual durations", async () => {
    setDay(2); await close(); const r = await learn("--compare",a.plan.project_id,b.plan.project_id);
    expect(r.comparison!.warnings).toContain("MISSING_CONFIRMED_RESULT"); expect(r.comparison!.warnings).toContain("UNEQUAL_EXPERIMENT_DURATION"); expect(r.comparison!.lifetime_net_difference_a_minus_b_cents).toBeNull();
  });
  it("report separates all five levels and forbids naive success percentages", async () => {
    await closedPair(); const r = await learn("--learning-report", ...target(a));
    for (const label of ["FACTS", "OBSERVATIONS", "DERIVED METRICS", "HYPOTHESES", "RECOMMENDATION", "CONFIDENCE", "NO ACTION IS AUTHORIZED BY THIS REPORT."]) expect(r.report).toContain(label);
    expect(r.report).not.toMatch(/100%|probabilité de réussite|stratégie gagnante/); expect(r.confidence).toBe("insufficient");
  });
  it.each([[0,"insufficient"],[1,"insufficient"],[2,"very_low"],[4,"very_low"],[5,"low"],[19,"low"],[20,"moderate"],[49,"moderate"],[50,"strong"]])("evidence sample %i => %s", (n, level) => { expect(evidenceLevel(n as number)).toBe(level); });
  it.each(["repeat_small","modify_and_retry","observe_longer","avoid_for_now","insufficient_evidence"])("strict recommendation enum %s", r => { expect(strictRecommendation(r)).toBe(r); });
  it("avoids unprofitable retired assets and observes still-passive ones", async () => {
    await closedPair(); expect((await analyze()).derived_metrics.recommendation.kind).toBe("observe_longer");
    await v9("--retire-asset",...target(a),"--asset-id",a.asset!.asset_id); expect((await analyze()).derived_metrics.recommendation.kind).toBe("avoid_for_now");
    expect((await analyze(b)).derived_metrics.recommendation.kind).toBe("repeat_small");
  });
});

describe("V11 explicit hypothesis memory and preserved contradictory evidence", () => {
  it("creates an open hypothesis before results; refresh collects weak support/contradiction", async () => {
    const id = hid(); let r = await create(id); expect(r.hypotheses[0].status).toBe("open"); expect(r.hypotheses[0].sample_size).toBe(0);
    await closedPair(); r = await learn("--refresh-hypothesis",id); const h = r.hypotheses[0];
    expect(h.status).toBe("mixed"); expect(h.evidence_for[0].project_id).toBe(b.plan.project_id); expect(h.evidence_against[0].project_id).toBe(a.plan.project_id); expect(h.confidence).toBe("very_low");
  });
  it("retains negative prior evidence after a lifetime reversal, without increasing sample size", async () => {
    await metric(a,4); await metric(b,2); await closedPair(); const id = hid(); await create(id,"inquiries_lifetime",["--min-inquiries","3"]);
    setDay(30); await passive(); const r = await learn("--refresh-hypothesis",id), h = r.hypotheses[0];
    expect(h.status).toBe("mixed"); expect(h.evidence_for.some(e => e.project_id === a.plan.project_id)).toBe(true);
    expect(h.evidence_against.some(e => e.project_id === a.plan.project_id && e.lifetime_net_cents === -200)).toBe(true); expect(h.sample_size).toBe(2); expect(h.confidence).toBe("very_low");
    const again = await learn("--refresh-hypothesis",id); expect(again.hypotheses[0].evidence_against).toEqual(h.evidence_against); expect(again.hypotheses[0].sample_size).toBe(2);
  });
  it("one project with a signal cannot produce strong confidence", async () => {
    await metric(a,4); await closedPair(); const r = await create(hid(),"inquiries_lifetime",["--min-inquiries","3"]); expect(r.hypotheses[0].sample_size).toBe(1); expect(r.hypotheses[0].confidence).toBe("insufficient");
    expect(r.hypotheses[0].current_evaluation.missing_project_ids).toEqual([b.plan.project_id]);
  });
  it("reconstructs stored views using old authenticated prefixes after new V9/V10 data", async () => {
    await create(); const before = await read("learning-hypotheses.json"); await metric(a,4); await closedPair(); setDay(30); await passive();
    expect((await learn("--list-hypotheses")).hypotheses[0].status).toBe("open"); expect(await read("learning-hypotheses.json")).toBe(before);
  });
  it("retirement preserves history/evidence and prevents further refresh", async () => {
    await closedPair(); const id=hid(); await create(id); const before=(await loadLearningState(root)).state!.events;
    await learn("--retire-hypothesis",id); const r = await learn("--inspect-hypothesis",id);
    expect(r.hypotheses[0].status).toBe("retired"); expect(r.hypotheses[0].evidence_against).toHaveLength(1); expect(r.hypothesis_history).toHaveLength(2);
    expect((await loadLearningState(root)).state!.events.slice(0,-1)).toEqual(before); await expect(learn("--refresh-hypothesis",id)).rejects.toThrow("non-retired");
  });
  it("preview of each mutation leaves every byte unchanged", async () => {
    const id=hid(), before=await tree(temp); await create(id,"experiment_profitability",["--preview"]); expect(await tree(temp)).toEqual(before);
    await create(id); const after=await tree(temp); await learn("--refresh-hypothesis",id,"--preview"); await learn("--retire-hypothesis",id,"--preview"); expect(await tree(temp)).toEqual(after);
  });
  it("rejects duplicate hypothesis IDs", async () => { const id=hid(); await create(id); await expect(create(id)).rejects.toThrow("Duplicate hypothesis"); });
  it("refuses unknown hypothesis IDs", async () => { await expect(learn("--inspect-hypothesis",hid())).rejects.toThrow("existing"); await expect(learn("--retire-hypothesis",hid())).rejects.toThrow("existing"); });
  it.each(["open","supported_weakly","contradicted_weakly","mixed","retired"])("strict allowed status %s", s => expect(strictStatus(s)).toBe(s));
  it.each(["proven","guaranteed","approved","invest",null,0])("refuses invented status/recommendation %j", s => { expect(()=>strictStatus(s)).toThrow(); expect(()=>strictRecommendation(s)).toThrow(); });
});

describe("V11 exact CLI and authority boundaries", () => {
  it.each(["latest","all","current","*","project-123","../x",""])("rejects ambiguous project %j", id => { expect(()=>parseLearningCommand(["--analyze-project",id,"--experiment-id",a.experiment_id])).toThrow(); });
  it("rejects wrong experiment, missing batch and duplicate comparison targets", async () => {
    await expect(learn("--analyze-project",a.plan.project_id,"--experiment-id",b.experiment_id)).rejects.toThrow("matching");
    await expect(learn("--analyze-batch",`batch-${randomUUID()}`)).rejects.toThrow("existing");
    expect(()=>parseLearningCommand(["--compare",a.plan.project_id,a.plan.project_id])).toThrow("distinct");
    await expect(learn("--compare",a.plan.project_id,`project-${randomUUID()}`)).rejects.toThrow("matching");
  });
  it("requires exact grammar with no injected score/status/source or malformed threshold", () => {
    const base=["--create-hypothesis",hid(),"--batch-id",batchId,"--statement","x","--rule","inquiries_lifetime"];
    for(const extra of [["--min-inquiries","0"],["--min-inquiries","1.5"],["--min-inquiries","01"],["--min-inquiries","1000001"],["--status","proven"],["--score","99"],["--preview","--preview"]]) expect(()=>parseLearningCommand([...base,...extra])).toThrow();
    expect(()=>parseLearningCommand(["--list-hypotheses","--preview"])).toThrow();
    expect(()=>validateLearningCommand({kind:"list-hypotheses",score:1} as any)).toThrow();
  });
  it("no model/network, economic mutation, approval, V8, reservation or source code writes", async () => {
    await closedPair(); const protectedBefore = await tree(temp), code = await fs.readFile(new URL("../agent/economic-learning.ts",import.meta.url),"utf8");
    await analyze(); await learn("--compare",a.plan.project_id,b.plan.project_id); expect(await tree(temp)).toEqual(protectedBefore);
    const writes=vi.spyOn(fs,"open"); await create();
    for(const call of writes.mock.calls) {
      const name=String(call[0]), flags=call[1]; if(typeof flags === "number" && (flags & 1 || flags & 2 || flags & 64)) expect(name.startsWith(root+path.sep)||name.startsWith(learningStoreRoot(root)+path.sep)).toBe(true);
    }
    expect(await fs.readFile(new URL("../agent/economic-learning.ts",import.meta.url),"utf8")).toBe(code);
    const names=await fs.readdir(root); expect(names.some(n=>n.startsWith("external")||n.startsWith("approval"))).toBe(false);
    expect(await ledger()).toMatchObject({total_recorded_expenses_cents:1100,total_recorded_revenue_cents:1300,reserved_balance_cents:0});
  });
  it("V10 and financial/project histories remain byte-identical after V11 mutations", async () => {
    await metric(a,4); await closedPair(); const names=(await fs.readdir(root)).sort(), before=await Promise.all(names.map(read));
    const privateBefore=await Promise.all([projectStoreRoot(root),observationStoreRoot(root)].map(tree));
    const id=hid(); await create(id); await learn("--refresh-hypothesis",id); await learn("--retire-hypothesis",id);
    expect(await Promise.all(names.map(read))).toEqual(before); expect(await Promise.all([projectStoreRoot(root),observationStoreRoot(root)].map(tree))).toEqual(privateBefore);
  });
  it("V9 bounds are unchanged", () => { expect(PROJECT_LIMITS).toMatchObject({MAX_ACTIVE_PROJECTS:2,MAX_PROJECT_BUDGET_CENTS:1000,MAX_BATCH_BUDGET_CENTS:2000,MAX_EXPERIMENT_DURATION_DAYS:7}); });
  it("actual CLI runs without installed Ollama and returns no authorization", async () => {
    const home=path.join(temp,"home"); await fs.mkdir(path.join(home,".automaton"),{recursive:true});
    // Copy the complete parent including workspace-bound private stores is NOT safe:
    // use this existing workspace as the default via HOME's standard location.
    const cliRoot=path.join(home,".automaton","scout-workspace"); await fs.mkdir(cliRoot);
    const result=await promisify(execFile)(process.execPath,["dist/index.js","--list-hypotheses"],{env:{...process.env,HOME:home,SCOUT_MODE:"learning",OLLAMA_BASE_URL:"invalid"}}).catch(e=>e);
    expect(result.stderr).toContain("Initialize existing V5 ledger");
    await fs.writeFile(path.join(cliRoot,"economic-ledger.json"),JSON.stringify(initializeLedger(10000)));
    const ok=await promisify(execFile)(process.execPath,["dist/index.js","--list-hypotheses"],{env:{...process.env,HOME:home,SCOUT_MODE:"learning",OLLAMA_BASE_URL:"invalid",SCOUT_MODEL:"missing"}});
    expect(JSON.parse(ok.stdout).action_authorized).toBe(false);
  });
  it("wrong mode is refused", async () => { vi.stubEnv("SCOUT_MODE","local"); await expect(runLearningScout({root,command:{kind:"list-hypotheses"}})).rejects.toThrow("SCOUT_MODE=learning"); });
});

describe("V11 authenticated journal, bounds and fail-closed sources", () => {
  it.each(["economic-ledger.json","projects.json","project-batch.json","assets.json","monitoring-history.json","monitoring-report.txt"])("tampered source %s fails without reconstruction", async name => {
    await metric(a,4); await fs.writeFile(path.join(root,name),"{}"); const before=await tree(temp); await expect(analyze()).rejects.toThrow(); expect(await tree(temp)).toEqual(before);
  });
  it.each(["economic-ledger.json","projects.json","monitoring-history.json"])("missing required source %s fails", async name => {
    await metric(a,4); await fs.unlink(path.join(root,name)); await expect(analyze()).rejects.toThrow();
  });
  it("absent V10 from the start is explicit lack of observations", async () => { expect((await analyze()).observations.availability).toBe("no_history"); });
  it.each(["project","monitoring"])("private %s HMAC tamper fails", async source => {
    await metric(a,4); const dir=source==="project"?projectStoreRoot(root):observationStoreRoot(root),file=path.join(dir,"state.json");
    const d=JSON.parse(await fs.readFile(file,"utf8")); d.mac="0".repeat(64); await fs.writeFile(file,JSON.stringify(d)); await expect(analyze()).rejects.toThrow("authentication");
  });
  it("detects learning public-view and private MAC tampering", async () => {
    await create(); const before=await read("learning-hypotheses.json"); await fs.writeFile(path.join(root,"learning-hypotheses.json"),"{}"); await expect(learn("--list-hypotheses")).rejects.toThrow("Modified");
    await fs.writeFile(path.join(root,"learning-hypotheses.json"),before);
    const file=path.join(learningStoreRoot(root),"state.json"),d=JSON.parse(await fs.readFile(file,"utf8")); d.mac="0".repeat(64); await fs.writeFile(file,JSON.stringify(d)); await expect(learn("--list-hypotheses")).rejects.toThrow("authentication");
  });
  it("semantic replay refuses even a signed invented evidence snapshot", async () => {
    await closedPair(); await create(); await signedLearningEdit(s=>{s.events[0].evaluation.evidence_against[0].lifetime_net_cents=999;}); await expect(learn("--list-hypotheses")).rejects.toThrow("evidence does not match");
  });
  it("detects loss of an earlier pinned monitoring history", async () => {
    await metric(a,4); await create(); await fs.rm(observationStoreRoot(root),{recursive:true}); await fs.unlink(path.join(root,"monitoring-history.json")); await fs.unlink(path.join(root,"monitoring-report.txt"));
    await expect(learn("--list-hypotheses")).rejects.toThrow();
  });
  it.each(["symlink","hardlink"])("refuses learning %s", async kind => {
    await create(); const file=path.join(root,"learning-history.json"),other=path.join(temp,"other"); await fs.rename(file,other);
    if(kind==="symlink") await fs.symlink(other,file); else await fs.link(other,file);
    await expect(learn("--list-hypotheses")).rejects.toThrow("unsafe");
  });
  it("refuses a private learning directory symlink", async () => {
    await create(); const dir=learningStoreRoot(root),other=path.join(temp,"moved"); await fs.rename(dir,other); await fs.symlink(other,dir); await expect(learn("--list-hypotheses")).rejects.toThrow("unsafe");
  });
  it("missing key never silently regenerates state", async () => {
    await create(); await fs.unlink(path.join(learningStoreRoot(root),"integrity-key")); const before=await tree(temp); await expect(learn("--list-hypotheses")).rejects.toThrow("Incomplete"); expect(await tree(temp)).toEqual(before);
  });
  it("private permission enforcement", async () => {
    await create(); await fs.chmod(path.join(learningStoreRoot(root),"state.json"),0o644); await expect(learn("--list-hypotheses")).rejects.toThrow("private");
  });
  it("atomic first rename failure preserves prior state byte-for-byte", async () => {
    const id=hid(); await create(id); const before=await tree(temp); vi.mocked(fs.rename).mockRejectedValueOnce(new Error("injected rename failure"));
    await expect(learn("--refresh-hypothesis",id)).rejects.toThrow("rename failure"); expect(await tree(temp)).toEqual(before); expect((await learn("--list-hypotheses")).hypotheses).toHaveLength(1);
  });
  it("partial transaction remains blocked instead of repairing or replaying", async () => {
    const id=hid(); await create(id); const original=(await vi.importActual<typeof fs>("node:fs/promises")).rename; let n=0;
    vi.mocked(fs.rename).mockImplementation(async(...args)=>{ if(++n===2) throw new Error("view failure"); return original(...args); });
    await expect(learn("--refresh-hypothesis",id)).rejects.toThrow("view failure"); await expect(learn("--list-hypotheses")).rejects.toThrow("Incomplete learning transaction");
  });
  it("same shared lock refuses concurrent V11 work", async () => {
    const results=await Promise.allSettled([create(),create()]); expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(String((results.find(r=>r.status==="rejected") as PromiseRejectedResult).reason)).toContain("locked");
  });
  it("respects an existing V5/V9 lock", async () => {
    await fs.writeFile(path.join(root,".economic-ledger.lock"),"other run"); await expect(analyze()).rejects.toThrow("locked"); expect(await read(".economic-ledger.lock")).toBe("other run");
  });
  it("generic writes cannot edit journal/views, temp names or escape to private store", async () => {
    const write=createLocalWorkspaceTools(root).find(t=>t.name==="write_file")!;
    for(const file of ["learning-history.json","learning-hypotheses.json","learning-report.txt",".learning-history.tmp","sub/learning-history.json",`../${path.basename(learningStoreRoot(root))}/state.json`]) expect(await write.execute({path:file,content:"bad"},{} as any)).toMatch(/^ERROR/);
  });
  it("store enforces append-only prefix", async () => {
    await create(); const loaded=await loadLearningState(root),before=await tree(temp);
    await expect(saveLearning(root,loaded.state,[],undefined,"x",loaded.key,async()=>{})).rejects.toThrow("append-only"); expect(await tree(temp)).toEqual(before);
  });
  it("hypothesis and event limits refuse growth without pruning old evidence", async () => {
    const first=await create(),sources=await readLearningSources(root),event=first.event!;
    const entries=Array.from({length:LEARNING_LIMITS.MAX_HYPOTHESES+1},()=>({...structuredClone(event),event_id:`learningevent-${randomUUID()}`,definition:{...event.definition,hypothesis_id:hid()}}));
    expect(auditLearning(entries.slice(0,16),sources)).toHaveLength(16); expect(()=>auditLearning(entries,sources)).toThrow("hypothesis limit");
    expect(()=>auditLearning(Array(129).fill(event),sources)).toThrow("history event limit");
  });
  it("report and persisted history byte limits are strict", async () => {
    expect(boundedReport("x".repeat(LEARNING_LIMITS.MAX_REPORT_BYTES))).toHaveLength(LEARNING_LIMITS.MAX_REPORT_BYTES);
    expect(()=>boundedReport("é".repeat(LEARNING_LIMITS.MAX_REPORT_BYTES))).toThrow("report size");
    await create(); await fs.writeFile(path.join(learningStoreRoot(root),"state.json")," ".repeat(LEARNING_LIMITS.MAX_HISTORY_BYTES+1)); await expect(learn("--list-hypotheses")).rejects.toThrow("oversized");
  });
  it("source reference bound rejects excessive evidence rather than truncating it", async () => {
    const s=await readLearningSources(root); const original=s.projects.find(e=>e.command.target===a.plan.project_id)!;
    s.projects.push(...Array(LEARNING_LIMITS.MAX_EVIDENCE_LINKS).fill(original)); expect(()=>buildProjectEvidence(s,a.plan.project_id)).toThrow("evidence link limit");
  });
  it("DATA_CONFLICT is explicit and never resolves conflicting finances arbitrarily", async () => {
    await closedPair(); const s=await readLearningSources(root),e=buildProjectEvidence(s,a.plan.project_id);
    expect(()=>verifyFinancialTotals(e.source_refs.financial_entries,600,999)).toThrow("DATA_CONFLICT");
    s.model.projects[1].result!.ledger_entry_ids.push(...s.model.projects[0].result!.ledger_entry_ids);
    expect(()=>assertNoConflicts(s)).toThrow("DATA_CONFLICT");
  });
  it("historical source pins refuse changed or missing prefixes", async () => {
    const s=await readLearningSources(root),pin=sourcePin(s); expect(()=>historicalSources(s,{...pin,ledger_hash:"0".repeat(64)})).toThrow("prefix mismatch");
    expect(()=>historicalSources(s,{...pin,observation_count:1})).toThrow();
  });
});

const legacyPlan: ExperimentPlan = {version:4,status:"planned",opportunity_name:"Legacy fictif",opportunity_score:60,hypothesis:"Demande",experiment_budget_eur:10,duration_days:3,
  actions:["Prototype"],success_metrics:["Une réponse"],stop_conditions:["Trois jours"],expected_learning:"Demande",requires_real_spending:true,requires_external_account:false,requires_publication:false,requires_human_approval:true};
async function legacyFixture() {
  root=path.join(temp,"legacy"); await fs.mkdir(root); await fs.writeFile(path.join(root,"experiment.json"),JSON.stringify(legacyPlan));
  await fs.writeFile(path.join(root,"economic-ledger.json"),JSON.stringify(reserveExperiment(initializeLedger(10000),legacyPlan)));
  vi.stubEnv("SCOUT_MODE","approval"); const request=await runApprovalScout({root}); await runApprovalScout({root,command:{kind:"approve",requestId:request.request_id}});
  vi.stubEnv("SCOUT_MODE","revenue"); return runRevenueScout({root,command:{experiment_id:experimentReference(legacyPlan).id,expense_cents:600,revenue_cents:400,outcome:"failed",approval_request_id:request.request_id,preview:false}});
}
describe("V11 authenticated legacy V7 adapter", () => {
  it("uses actual V7/V6/V5 records without inventing project, asset, start or lifetime", async () => {
    const fixture=await legacyFixture(),r=await learn("--analyze-experiment",fixture.result.experiment_id),e=r.legacy_evidence!;
    expect(e.project_id).toBeNull(); expect(e.facts).toMatchObject({experiment_expense_cents:600,experiment_revenue_cents:400,post_experiment_revenue_cents:null});
    expect(e.derived_metrics).toMatchObject({experiment_net_cents:-200,lifetime_net_cents:null,time_to_first_confirmed_revenue_ms:null}); expect(r.confidence).toBe("insufficient");
  });
  it.each(["experiment-result.json","economic-history.json","revenue-report.txt"])("V7 corrupt view %s fails closed", async name => {
    const f=await legacyFixture(); await fs.writeFile(path.join(root,name),"{}"); await expect(learn("--analyze-experiment",f.result.experiment_id)).rejects.toThrow("Modified");
  });
  it("missing V7 anchor and all public views still fails via confirmed ledger binding", async () => {
    const f=await legacyFixture(); await fs.rm(revenueStoreRoot(root),{recursive:true}); for(const n of ["experiment-result.json","economic-history.json","revenue-report.txt"]) await fs.unlink(path.join(root,n));
    await expect(learn("--analyze-experiment",f.result.experiment_id)).rejects.toThrow("Missing authenticated V7");
  });
  it("private V7 MAC corruption refuses analysis", async () => {
    const f=await legacyFixture(),file=path.join(revenueStoreRoot(root),"state.json"),s=JSON.parse(await fs.readFile(file,"utf8")); s.mac="0".repeat(64); await fs.writeFile(file,JSON.stringify(s));
    await expect(learn("--analyze-experiment",f.result.experiment_id)).rejects.toThrow("authentication");
  });
  it("V7 and V9 claims of one experiment produce explicit DATA_CONFLICT", async () => {
    await closedPair(); const s=await readLearningSources(root); const f=await legacyFixture(); const legacy=await readLearningSources(root);
    legacy.revenues[0].result.experiment_id=s.model.projects[0].experiment_id; s.revenues=legacy.revenues;
    expect(()=>assertNoConflicts(s)).toThrow("DATA_CONFLICT");
  });
});
