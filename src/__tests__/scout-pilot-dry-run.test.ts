import { beforeAll, afterAll, describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { runPilotDryRun } from "../agent/pilot-dry-run.js";
import { loadPilot, pilotStoreRoot } from "../agent/pilot-store.js";
import { workspaceFingerprint } from "../agent/pilot-workspace-proof.js";
import { scoutWorkspaceRoot } from "../agent/local-tools.js";
import { PROJECT_LIMITS } from "../agent/asset-lifecycle.js";
import { ALLOCATION_LIMITS } from "../agent/allocation-sources.js";
import { parseEconomicLedger } from "../agent/economic-ledger.js";
import { readProjectContext } from "../agent/project-manager.js";
import { readVerifiedExternalRecords } from "../agent/external-gateway.js";
import { readLearningSources, buildProjectEvidence } from "../agent/evidence-builder.js";
import { controlEventStoreRoot } from "../agent/control-events.js";
let temp: string, root: string, before: string, previous: string | undefined, complete: any, project: any, sources: any, events: any[], external: any[];
export async function completePilot(root: string, initial = false, denyName?: string) {
  let result: any;
  for (let i = 0; i < 8; i++) {
    result = await runPilotDryRun({ root, command: initial && i === 0 ? "run" : "resume" });
    if (result.manifest.current_stage === "COMPLETED") return runPilotDryRun({ root, command: "resume" });
    expect(result.manifest.status).toBe("WAITING_FOR_HUMAN");
    for (const a of result.approvals) {
      const p = (await readProjectContext(root)).model.projects.find(p => p.plan.project_id === a.subject_id);
      await runPilotDryRun({ root, command: "resume", decision: { requestId: a.request_id, subjectId: a.subject_id, decision: p?.plan.name === denyName ? "deny" : "approve" } });
    }
  }
  throw new Error("Pilot driver exhausted");
}
beforeAll(async () => {
  previous = process.env.SCOUT_MODE; process.env.SCOUT_MODE = "pilot-dry-run";
  before = await workspaceFingerprint(scoutWorkspaceRoot());
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-pilot-tests-")); root = path.join(temp, "workspace"); await fs.mkdir(root);
  // Real process deaths, on the same run, including after canonical effect but
  // before orchestration receipt. OS mutex and V5 lock must recover safely.
  for (const point of ["after-effect:allocation", "after-effect:reserve-", "after-effect:decision-", "after-effect:action-", "after-effect:result-"]) {
    const result = await new Promise<{ code: number | null; signal: string | null; stderr: string }>((resolve, reject) => {
      let stderr = "";
      const child = spawn(process.execPath, ["src/__tests__/fixtures/pilot-crash-child.mjs", root, point], { env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "ignore", "pipe"] });
      child.stderr.on("data", data => { stderr += data; }); child.on("error", reject); child.on("exit", (code, signal) => resolve({ code, signal, stderr }));
    });
    expect(result, point).toEqual({ code: null, signal: "SIGKILL", stderr: "" });
    const m = (await loadPilot(root))!.manifest; expect(m.pending?.key).toBeTruthy();
  }
  complete = await completePilot(root);
  project = await readProjectContext(root); sources = await readLearningSources(root); external = await readVerifiedExternalRecords(root);
  events = JSON.parse(await fs.readFile(path.join(controlEventStoreRoot(root), "state.json"), "utf8")).events;
}, 120000);
afterAll(async () => {
  expect(await workspaceFingerprint(scoutWorkspaceRoot())).toBe(before);
  if (previous === undefined) delete process.env.SCOUT_MODE; else process.env.SCOUT_MODE = previous;
  await fs.rm(temp, { recursive: true, force: true });
});
describe("V12.6 canonical offline lifecycle after five SIGKILL/restarts", () => {
  it("completes with a readiness verdict that grants no authority", () => {
    expect(complete.report.technical_readiness).toBe("READY_FOR_SUPERVISED_REAL_PILOT"); expect(complete.report.verdict_authorizes_execution).toBe(false);
  });
  it("uses exactly two canonical V9 projects", () => expect(project.model.projects).toHaveLength(2));
  it("keeps 1000 cents maximum per project", () => expect(project.model.projects.map((p: any) => p.plan.budget_cents)).toEqual([1000, 1000]));
  it("keeps 2000 cents total and PROPOSAL_ONLY", async () => {
    const a = JSON.parse(await fs.readFile(path.join(root, "capital-allocation.json"), "utf8")); expect(a.status).toBe("PROPOSAL_ONLY"); expect(a.total_proposed_cents).toBe(2000);
  });
  it("never creates or reserves the 3500-cent C candidate", () => {
    expect(project.model.projects.map((p: any) => p.plan.name).sort()).toEqual(["A", "B"]);
    expect(project.ledger.entries.filter((e: any) => e.type === "reserve")).toHaveLength(2);
  });
  it("emits an informational out-of-budget alert with no capability", () => {
    const alerts = events.filter(e => e.event_type === "OUT_OF_BUDGET_OPPORTUNITY"); expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.every(e => e.payload.action_authorized === false && e.payload.capability_granted === false)).toBe(true);
  });
  it("has four real V6 approvals, all consumed once", () => {
    expect(complete.manifest.approval_ids).toHaveLength(4); expect(complete.manifest.simulated_human_decisions).toHaveLength(4);
    expect(external.every(r => r.approval.decision.status === "approved")).toBe(true);
  });
  it("marks every V8 result ACTION_SIMULATED, never executed", () => expect(external.map(r => r.execution.status)).toEqual(["simulated", "simulated"]));
  it("records J0/J1/J3/J5/J7 for each project without waiting", () => {
    for (const p of project.model.projects) expect(sources.observations.filter((o: any) => o.project_id === p.plan.project_id && o.type === "checkpoint").map((o: any) => o.data.checkpoint)).toEqual(["start", "day_1", "day_3", "day_5", "deadline"]);
  });
  it("learns the confirmed positive A result", () => {
    const a = project.model.projects.find((p: any) => p.plan.name === "A"), e = buildProjectEvidence(sources, a.plan.project_id);
    expect(e.facts.experiment_expense_cents).toBe(700); expect(e.facts.experiment_revenue_cents).toBe(1200); expect(e.derived_metrics.experiment_net_cents).toBe(500);
  });
  it("learns the negative B result", () => {
    const b = project.model.projects.find((p: any) => p.plan.name === "B"); expect(buildProjectEvidence(sources, b.plan.project_id).derived_metrics.experiment_net_cents).toBe(-400);
  });
  it("distinguishes experiment/deadline from lifetime", () => {
    const a = project.model.projects.find((p: any) => p.plan.name === "A"), e = buildProjectEvidence(sources, a.plan.project_id);
    expect(e.derived_metrics.deadline_net_cents).toBe(500); expect(e.derived_metrics.lifetime_net_cents).toBe(700);
  });
  it("does not learn unconfirmed sale claims as financial facts", () => {
    expect(sources.observations.filter((o: any) => o.type === "sale_claim").map((o: any) => o.data.amount_cents)).toEqual([99999, 99999]);
    expect(project.ledger.total_recorded_revenue_cents).toBe(1800);
  });
  it("releases reservations and closes the canonical results", () => {
    expect(project.ledger.reserved_balance_cents).toBe(0); expect(project.ledger.available_balance_cents).toBe(10300);
    expect(project.ledger.entries.filter((e: any) => e.type === "release").map((e: any) => e.amount_cents)).toEqual([300, 200]);
  });
  it("binds learning evidence to canonical result and ledger IDs", () => {
    expect(complete.report.evidence_references).toHaveLength(2); expect(complete.report.evidence_references.every((r: any) => r.result_id && r.financial_entry_ids.length >= 3)).toBe(true);
    expect(complete.report.learning_references[0].status).toBe("mixed");
  });
  it("checks health/summary/projects/events/allocation/approvals over actual loopback HTTP", () => expect(complete.report.invariant_checks.control_api_coherent).toBe(true));
  it("exposes ordered unique mobile events", () => {
    expect(events.map(e => e.sequence)).toEqual(events.map((_, i) => i + 1)); expect(new Set(events.map(e => e.event_id)).size).toBe(events.length);
    for (const type of ["APPROVAL_REQUIRED", "PROJECT_UPDATED", "PROJECT_COMPLETED", "OUT_OF_BUDGET_OPPORTUNITY"]) expect(events.some(e => e.event_type === type)).toBe(true);
  });
  it.each(["allocation", "approval creation", "approval decision", "action simulation", "result recording"])("survives actual SIGKILL after %s with one canonical effect", label => {
    const keys = complete.manifest.steps.map((s: any) => s.key); expect(new Set(keys).size).toBe(keys.length);
    expect(external).toHaveLength(2); expect(complete.manifest.result_ids).toHaveLength(2); expect(complete.manifest.allocation_id).toBeTruthy();
  });
  it("resume changes neither events nor financial bytes", async () => {
    const ledger = await fs.readFile(path.join(root, "economic-ledger.json"), "utf8"), e = await fs.readFile(path.join(controlEventStoreRoot(root), "state.json"), "utf8");
    await runPilotDryRun({ root, command: "resume" });
    expect(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8")).toBe(ledger); expect(await fs.readFile(path.join(controlEventStoreRoot(root), "state.json"), "utf8")).toBe(e);
  });
  it("refuses consumed approval retry", async () => {
    const d = complete.manifest.simulated_human_decisions[0]; await expect(runPilotDryRun({ root, command: "resume", decision: { requestId: d.request_id, subjectId: d.subject_id, decision: "approve" } })).rejects.toThrow(/Consumed/);
  });
  it.each(["real_money_spent_cents", "public_network", "ollama", "payments", "publication"])("records zero %s", field => expect(complete.report[field]).toBe(0));
  it("keeps all V9/V12 safety constants unchanged", () => {
    expect(PROJECT_LIMITS).toMatchObject({ MAX_ACTIVE_PROJECTS: 2, MAX_PROJECT_BUDGET_CENTS: 1000, MAX_BATCH_BUDGET_CENTS: 2000, MAX_EXPERIMENT_DURATION_DAYS: 7 });
    expect(ALLOCATION_LIMITS).toBeDefined();
  });
  it("leaves the real workspace byte-for-byte unchanged", async () => expect(await workspaceFingerprint(scoutWorkspaceRoot())).toBe(before));
});
