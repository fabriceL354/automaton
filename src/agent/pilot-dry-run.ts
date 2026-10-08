import { pilotLocked } from "./pilot-lock.js";
/** V12.6: bounded orchestration of canonical services in an isolated workspace. */
import * as fs from "node:fs/promises";
import http from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { readConfined, atomicWrite } from "./ledger-runner.js";
import { initializeLedger, parseEconomicLedger } from "./economic-ledger.js";
import { readProjectContext, runProjectScout, decideExistingProjectApproval } from "./project-manager.js";
import { canonicalHash, structured, same, parseProjectCommand, type Project } from "./project-model.js";
import { runAllocationScout } from "./allocation-runner.js";
import { loadAllocation } from "./allocation-store.js";
import { readVerifiedExternalRecords, runExternalScout, decideExistingExternalApproval } from "./external-gateway.js";
import { runMonitoringScout } from "./experiment-monitor.js";
import { runLearningScout } from "./economic-learning.js";
import { readLearningSources, buildProjectEvidence } from "./evidence-builder.js";
import { readControlSnapshot } from "./control-snapshot.js";
import { syncControlEvents } from "./control-events.js";
import { startControlApi } from "./control-api.js";
import { pilotResearchFixture } from "./pilot-fixture.js";
import { inPilotContext, pilotContext, pilotService } from "./pilot-context.js";
import { installPilotNetworkGuard } from "./pilot-network-guard.js";
import { validatePilotRoot, createPilotKey, loadPilot, savePilot, STAGES, type Stage, type PilotManifest, type PilotOperation, type StatePins } from "./pilot-store.js";
export type PilotOptions = { root?: string; command: "run" | "resume" | "status";
  decision?: { requestId: string; subjectId: string; decision: "approve" | "deny" };
  /** Host tests only. Throw after a canonical commit or durable orchestration checkpoint. */
  fault?: (point: string) => void };
const DAY = 86_400_000;
async function state(root: string) {
  const snapshot = await readControlSnapshot(root), project = await readProjectContext(root), external = await readVerifiedExternalRecords(root);
  const allocation = (await loadAllocation(root)).state?.proposal;
  const research = JSON.parse((await readConfined(root, "research.json", 128 * 1024))!);
  const pins: StatePins = { histories: Object.fromEntries(Object.entries(snapshot.histories).map(([k, v]) => [k, { count: v.length, hash: canonicalHash(v) }])),
    allocation: canonicalHash(allocation ?? null), research: canonicalHash(research), external: canonicalHash(external) };
  return { snapshot, project, external, allocation, research, pins };
}
type State = Awaited<ReturnType<typeof state>>;
function refs(m: PilotManifest, s: State) {
  m.opportunity_ids = s.research.opportunities.map((v: { opportunity_id: string }) => v.opportunity_id);
  m.allocation_id = s.allocation?.allocation_id ?? null;
  m.source_state_fingerprint = s.allocation?.source_state_fingerprint ?? null;
  m.project_ids = s.project.model.projects.map(p => p.plan.project_id);
  m.approval_ids = s.snapshot.approvals.map(a => a.request_id);
  m.action_simulation_ids = s.external.flatMap(r => r.execution?.status === "simulated" ? [r.execution.execution_id] : []);
  m.monitoring_ids = s.snapshot.histories.observations.map(e => (e as { event_id: string }).event_id);
  m.result_ids = s.project.model.projects.flatMap(p => p.result ? [p.result.result_id] : []);
  m.learning_ids = s.snapshot.histories.learning.map(e => (e as { event_id: string }).event_id);
}
function checkRefs(m: PilotManifest, s: State) {
  const copy = structuredClone(m); refs(copy, s);
  for (const key of ["opportunity_ids", "allocation_id", "source_state_fingerprint", "project_ids", "approval_ids", "action_simulation_ids", "monitoring_ids", "result_ids", "learning_ids"] as const) {
    if (!same(m[key], copy[key])) throw new Error(`Unknown or mismatched pilot reference: ${key}`);
  }
}
function validateStageState(m: PilotManifest, s: State) {
  const reached = (stage: Stage) => STAGES.indexOf(m.current_stage) >= STAGES.indexOf(stage);
  const projects = s.project.model.projects;
  const admitted = projects.filter(p => p.approval?.request.status === "approved" && p.result?.classification !== "cancelled");
  const bad = reached("ALLOCATION_READY") && !s.allocation || reached("PROJECTS_READY") && projects.length !== 2 ||
    reached("APPROVALS_REQUIRED") && projects.some(p => !p.approval) ||
    reached("APPROVED") && projects.some(p => p.approval?.request.status === "pending") ||
    reached("ACTIONS_SIMULATED") && admitted.some(p => !p.external_actions.some(a => s.external.some(r => r.action.action_id === a.action_id && r.execution?.status === "simulated"))) ||
    reached("MONITORING") && admitted.some(p => s.snapshot.histories.observations.filter(o => (o as any).project_id === p.plan.project_id && (o as any).type === "checkpoint").length !== 5) ||
    reached("RESULTS_RECORDED") && admitted.some(p => !p.result) ||
    reached("LEARNING_UPDATED") && !(s.snapshot.histories.learning as any[]).some(e => e.operation === "refresh" && e.definition.hypothesis_id === m.hypothesis_id) ||
    reached("COMPLETED") && m.pending !== null;
  if (bad) throw new Error("Impossible pilot stage for canonical state");
}
function projectArgs(p: Project, operation: string, extra: string[] = []) { return [`--${operation}`, p.plan.project_id, "--experiment-id", p.experiment_id, ...extra]; }
function receipt(op: PilotOperation, s: State): string | undefined {
  switch (op.kind) {
    case "allocation": return s.allocation?.allocation_id;
    case "project": {
      const command = parseProjectCommand(op.args);
      return s.project.state?.events.find(e => same(e.command, command))?.event_id;
    }
    case "prepare": {
      const used = s.project.model.projects.filter(p => p.plan.project_id !== op.projectId).flatMap(p => p.external_actions.map(a => a.action_id));
      return s.external.find(r => !used.includes(r.action.action_id))?.action.action_id;
    }
    case "execute": {
      const e = s.external.find(r => r.action.action_id === op.actionId)?.execution;
      if (e && e.status !== "simulated") throw new Error("Uncertain or non-simulated external result; inspection required");
      return e?.execution_id;
    }
    case "decision": {
      if (op.scope === "project") return s.project.state?.events.find(e => e.command.operation === `${op.decision}-project` && e.command.target === op.subjectId && e.command.fields["request-id"] === op.requestId)?.event_id;
      const record = s.external.find(r => r.action.action_id === op.subjectId && r.approval.request.request_id === op.requestId);
      return record?.approval.decision?.status === (op.decision === "approve" ? "approved" : "denied") ? record.approval.request.request_id : undefined;
    }
    case "monitor": {
      const c = op.command;
      return (s.snapshot.histories.observations as import("./monitoring-model.js").ObservationEvent[]).find(e => e.project_id === c.projectId && e.experiment_id === c.experimentId &&
        (c.kind === "checkpoint" ? e.type === "checkpoint" && e.data.checkpoint === c.checkpoint : (c.kind === "record" || c.kind === "asset") && e.type === c.type &&
        (c.type === "external_action_result" ? e.data.execution_id === (c.data as { execution_id: string }).execution_id : same(e.data, c.data))))?.event_id;
    }
    case "learn": {
      const c = op.command;
      return (s.snapshot.histories.learning as import("./learning-model.js").LearningEvent[]).find(e => c.kind === "create-hypothesis" ? e.operation === "create" && same(e.definition, c.definition) : c.kind === "refresh-hypothesis" && e.operation === "refresh" && e.definition.hypothesis_id === c.hypothesisId)?.event_id;
    }
  }
}
function verifyDelta(before: StatePins, after: State, op: PilotOperation) {
  const allowed = op.kind === "project" || op.kind === "decision" && op.scope === "project" ? ["projects", "ledger"] :
    op.kind === "monitor" ? ["observations"] : op.kind === "learn" ? ["learning"] : op.kind === "prepare" ? ["external_actions"] :
    op.kind === "execute" ? ["external_executions"] : op.kind === "decision" ? ["external_decisions"] : [];
  for (const [key, pin] of Object.entries(before.histories)) {
    const history = after.snapshot.histories[key];
    if (!history || history.length < pin.count || canonicalHash(history.slice(0, pin.count)) !== pin.hash || !allowed.includes(key) && !same(after.pins.histories[key], pin)) throw new Error("Unexpected source mutation during pilot intent");
    if (allowed.includes(key) && key !== "ledger" && history.length !== pin.count + 1) throw new Error("Expected exactly one canonical effect");
  }
  if (before.research !== after.pins.research || op.kind !== "allocation" && before.allocation !== after.pins.allocation ||
    !["prepare", "execute", "decision"].includes(op.kind) && before.external !== after.pins.external || op.kind === "decision" && op.scope === "project" && before.external !== after.pins.external) throw new Error("Untracked pilot source changed");
  if (op.kind === "project" || op.kind === "decision" && op.scope === "project") {
    const event = after.project.state!.events.at(-1)!;
    if (event.ledger_before_count !== before.histories.ledger.count || event.ledger_after_count !== after.project.ledger.entries.length) throw new Error("Untracked ledger delta during project operation");
  }
  if (!receipt(op, after)) throw new Error("Missing exact canonical receipt");
}
async function execute(root: string, op: PilotOperation) {
  const now = () => pilotContext()!.now;
  switch (op.kind) {
    case "allocation": return pilotService("allocation", () => runAllocationScout({ root, command: { kind: "calculate", input: "research.json" }, now }));
    case "project": return pilotService("projects", () => runProjectScout({ root, command: parseProjectCommand(op.args) }));
    case "prepare": return pilotService("external", () => runExternalScout({ root, command: { kind: "prepare" } }));
    case "execute": return pilotService("external", () => runExternalScout({ root, command: { kind: "execute", actionId: op.actionId, requestId: op.requestId, projectId: op.projectId, experimentId: op.experimentId, preview: false } }));
    case "monitor": return pilotService("monitoring", () => runMonitoringScout({ root, command: op.command, now }));
    case "learn": return pilotService("learning", () => runLearningScout({ root, command: op.command, now }));
    case "decision": return pilotService("control-api", () => op.scope === "project" ? decideExistingProjectApproval(root, op.subjectId, op.requestId, op.decision) : decideExistingExternalApproval(root, op.requestId, op.decision));
  }
}
async function apiCheck(root: string, expected: State) {
  const token = randomBytes(32).toString("hex"), guard = pilotContext()!.guard;
  let api: Awaited<ReturnType<typeof startControlApi>> | undefined;
  const request = (route: string) => new Promise<any>((resolve, reject) => {
    const req = http.get(api!.url + route, { agent: false, headers: { Authorization: `Bearer ${token}` } }, response => {
      let raw = ""; response.setEncoding("utf8"); response.on("data", s => { raw += s; if (raw.length > 1024 * 1024) req.destroy(new Error("API response bound")); });
      response.on("end", () => { try { if (response.statusCode !== 200) throw new Error(`API ${route}: ${response.statusCode}`); resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    }); req.on("error", reject); req.setTimeout(5000, () => req.destroy(new Error("API timeout")));
  });
  try {
    api = await pilotService("control-api", () => startControlApi({ root, env: { SCOUT_CONTROL_API_PORT: "0", SCOUT_CONTROL_API_TOKEN: token } })); guard.port = api.port;
    if (api.host !== "127.0.0.1" || api.port === 11434) throw new Error("Exact loopback control listener required");
    if ((await request("/v1/health")).status !== "ok" || !same(await request("/v1/summary"), expected.snapshot.summary) ||
      !same((await request("/v1/projects")).items, expected.snapshot.projects) || !same((await request("/v1/allocation")).allocation, expected.snapshot.allocation) ||
      !same((await request("/v1/approvals")).items, expected.snapshot.approvals)) throw new Error("Control API disagrees with canonical state");
    const events = await request("/v1/events?limit=100");
    if (events.has_more || new Set(events.items.map((e: any) => e.event_id)).size !== events.items.length || events.items.some((e: any, i: number) => e.sequence !== i + 1)) throw new Error("Event order or duplication failure");
    await api.close(); guard.port = null;
    api = await pilotService("control-api", () => startControlApi({ root, env: { SCOUT_CONTROL_API_PORT: "0", SCOUT_CONTROL_API_TOKEN: token } })); guard.port = api.port;
    if (!same(await request("/v1/events?limit=100"), events)) throw new Error("Events changed after restart");
    return events.items as Awaited<ReturnType<typeof syncControlEvents>>;
  } finally { await api?.close(); guard.port = null; }
}
export async function runPilotDryRun(options: PilotOptions) {
  if (process.env.SCOUT_MODE !== "pilot-dry-run") throw new Error("Explicit SCOUT_MODE=pilot-dry-run required");
  if (!["run", "resume", "status"].includes(options.command)) throw new Error("Dry-run command only");
  const root = await validatePilotRoot(options.root ?? process.env.SCOUT_PILOT_WORKSPACE);
  installPilotNetworkGuard();
  return inPilotContext({ root, mode: "pilot-dry-run", now: new Date().toISOString(), lockHeld: false, guard: { attempts: 0, port: null } }, () => pilotLocked(root, async () => {
    pilotContext()!.lockHeld = true;
    let loaded = await loadPilot(root);
    if (!loaded) {
      if (options.command !== "run" || options.decision) throw new Error("Existing pilot required");
      if ((await fs.readdir(root)).some(name => name !== ".economic-ledger.lock")) throw new Error("New pilot requires an empty dedicated workspace");
      const key = await createPilotKey(root);
      await atomicWrite(root, "economic-ledger.json", structured(initializeLedger(10000)), parseEconomicLedger);
      await atomicWrite(root, "research.json", structured(pilotResearchFixture()), raw => { if (!same(JSON.parse(raw), pilotResearchFixture())) throw new Error("Fixture mismatch"); });
      const s = await state(root);
      const manifest: PilotManifest = { blocking_reasons: [], safety_violations: 0, schema_version: "12.6", mode: "DRY_RUN_ONLY", workspace: root, run_id: `pilot-${randomUUID()}`, started_at: pilotContext()!.now, completed_at: null,
        current_stage: "OPPORTUNITIES_READY", status: "RUNNING", source_state_fingerprint: null, checkpoint: s.pins, steps: [], pending: null,
        opportunity_ids: [], allocation_id: null, project_ids: [], approval_ids: [], action_simulation_ids: [], monitoring_ids: [], result_ids: [], learning_ids: [],
        hypothesis_id: `hypothesis-${randomUUID()}`, passive_receipt_id: `receipt-${randomUUID()}`, simulated_human_decisions: [] };
      refs(manifest, s); await savePilot(root, manifest, key); loaded = { manifest, key };
    }
    const { manifest: m, key } = loaded;
    try {
    const wasCompleted = m.current_stage === "COMPLETED";
    let current = await state(root);
    validateStageState(m, current);
    if (!m.pending) { if (!same(current.pins, m.checkpoint)) throw new Error("Stale pilot allocation/source fingerprint; no silent recalculation"); checkRefs(m, current); }
    if (options.command !== "status") m.blocking_reasons = [];
    const at = (day = 0) => new Date(Date.parse(m.started_at) + day * DAY).toISOString();
    const persist = () => savePilot(root, m, key);
    const stage = async (value: Stage) => {
      if (STAGES.indexOf(value) > STAGES.indexOf(m.current_stage)) { m.current_stage = value; await persist(); }
    };
    const step = async (name: string, op: PilotOperation, day = 0) => {
      const done = m.steps.find(s => s.key === name);
      if (done) { if (done.receipt !== receipt(op, current)) throw new Error("Canonical pilot receipt missing or wrong"); return; }
      if (wasCompleted) throw new Error("Completed pilot has a missing step");
      if (m.pending) {
        if (m.pending.key !== name || !same(m.pending.operation, op) || m.pending.at !== at(day) || !same(m.pending.before, m.checkpoint)) throw new Error("Impossible pending pilot transition");
      } else {
        if (!same(current.pins, m.checkpoint)) throw new Error("Pilot source changed before transition");
        if (receipt(op, current)) throw new Error("Orphan canonical effect without a pilot intent");
        m.pending = { key: name, operation: op, at: at(day), before: m.checkpoint }; await persist();
      }
      pilotContext()!.now = m.pending.at;
      if (!receipt(op, current)) {
        if (!same(current.pins, m.pending.before)) throw new Error("Partial/unexpected canonical write; inspection required");
        await execute(root, op); options.fault?.(`after-effect:${name}`); current = await state(root);
      }
      verifyDelta(m.pending.before, current, op);
      m.steps.push({ key: name, receipt: receipt(op, current)! });
      if (op.kind === "decision") m.simulated_human_decisions.push({ request_id: op.requestId, subject_id: op.subjectId, decision: op.decision, marker: "SIMULATED_HUMAN_DECISION" });
      m.pending = null; m.checkpoint = current.pins; refs(m, current); await persist();
      await syncControlEvents(root, current.snapshot); options.fault?.(`after:${name}`);
    };
    // Resolve an interrupted explicit human decision before the deterministic schedule.
    if (m.pending?.operation.kind === "decision") await step(m.pending.key, m.pending.operation);
    if (options.decision) {
      const d = options.decision;
      const approval = current.snapshot.approvals.find(a => a.request_id === d.requestId);
      if (!approval || approval.subject_id !== d.subjectId || !["project", "external"].includes(approval.scope)) throw new Error("Wrong approval/project binding");
      if (approval.consumed) throw new Error("Consumed approval cannot be replayed");
      if (!["approve", "deny"].includes(d.decision)) throw new Error("Explicit simulated human decision required");
      await step(`decision-${d.requestId}`, { kind: "decision", scope: approval.scope as "project" | "external", subjectId: d.subjectId, requestId: d.requestId, decision: d.decision });
    }
    const status = async () => {
      current = await state(root); await syncControlEvents(root, current.snapshot);
      return { mode: "DRY_RUN_ONLY", manifest: m, approvals: current.snapshot.approvals.filter(a => a.current && !a.consumed && a.status === "pending"), attention: current.snapshot.attention };
    };
    if (options.command === "status" || options.decision) return status();
    const pause = async () => { m.status = "WAITING_FOR_HUMAN"; await persist(); return status(); };
    if (!current.allocation) await pilotService("learning", () => runLearningScout({ root, command: { kind: "list-hypotheses" }, now: () => at() }));
    await step("allocation", { kind: "allocation" }); await stage("ALLOCATION_READY");
    const proposal = current.allocation!;
    const selected = proposal.selected_projects;
    const expected = current.research.opportunities.slice(0, 2).map((o: { opportunity_id: string }) => o.opportunity_id).sort();
    if (selected.length !== 2 || !same(selected.map(s => s.opportunity_id).sort(), expected) || selected.some(s => s.proposed_cents !== 1000 || s.max_duration_days !== 7) || proposal.total_proposed_cents !== 2000 || proposal.status !== "PROPOSAL_ONLY" || proposal.out_of_budget_candidates.length !== 1 || proposal.out_of_budget_candidates[0].estimated_cost_cents !== 3500) throw new Error("Canonical allocator did not produce bounded A+B; pilot blocked");
    if (!m.steps.some(s => s.key === "batch") && !m.pending) {
      const inspected = await pilotService("allocation", () => runAllocationScout({ root, command: { kind: "inspect" }, now: () => at() }));
      if (inspected.stale) throw new Error("Stale allocation before project creation");
    }
    await step("batch", { kind: "project", args: ["--create-batch"] });
    const batch = current.project.model.batch!.batch_id;
    for (const candidate of selected) {
      const research = current.research.opportunities.find((o: { opportunity_id: string }) => o.opportunity_id === candidate.opportunity_id);
      await step(`project-${candidate.opportunity_id}`, { kind: "project", args: ["--create-project", batch, "--name", research.name,
        "--hypothesis", "SIMULATED: small experiment profitability", "--budget-cents", String(candidate.proposed_cents), "--duration-days", String(candidate.max_duration_days)] });
    }
    await stage("PROJECTS_READY");
    await step("hypothesis", { kind: "learn", command: { kind: "create-hypothesis", definition: { hypothesis_id: m.hypothesis_id, batch_id: batch,
      statement: "SIMULATED: small experiments can be profitable", rule: "experiment_profitability", min_inquiries: null }, preview: false } });
    const projects = () => current.project.model.projects;
    for (const p of [...projects()]) await step(`reserve-${p.plan.project_id}`, { kind: "project", args: projectArgs(p, "reserve-project") });
    await stage("APPROVALS_REQUIRED");
    if (projects().some(p => p.approval?.request.status === "pending")) return pause();
    await stage("APPROVED");
    for (const original of [...projects()]) {
      let p = projects().find(p => p.plan.project_id === original.plan.project_id)!;
      if (p.approval!.request.status === "denied") { await step(`cancel-${p.plan.project_id}`, { kind: "project", args: projectArgs(p, "cancel-project") }); continue; }
      await step(`start-${p.plan.project_id}`, { kind: "project", args: projectArgs(p, "start-project", ["--request-id", p.approval!.request.request_id]) });
      await step(`prepare-${p.plan.project_id}`, { kind: "prepare", projectId: p.plan.project_id });
      const actionId = m.steps.find(s => s.key === `prepare-${p.plan.project_id}`)!.receipt;
      const external = current.external.find(r => r.action.action_id === actionId)!;
      await step(`link-${p.plan.project_id}`, { kind: "project", args: projectArgs(p, "link-external-action", ["--action-id", actionId, "--request-id", external.approval.request.request_id]) });
      await stage("ACTIONS_PREPARED");
      if (external.approval.request.status === "pending") return pause();
      if (external.approval.request.status === "denied") {
        await step(`close-denied-${p.plan.project_id}`, { kind: "project", args: projectArgs(p, "close-experiment", ["--request-id", p.approval!.request.request_id, "--expense-cents", "0", "--revenue-cents", "0", "--classification", "cancelled", "--asset-policy", "retire"]) }); continue;
      }
      await step(`action-${p.plan.project_id}`, { kind: "execute", projectId: p.plan.project_id, experimentId: p.experiment_id, actionId, requestId: external.approval.request.request_id });
      if (p.plan.name === "A") {
        await step("asset-A", { kind: "project", args: projectArgs(p, "create-asset") });
        p = projects().find(p => p.plan.project_id === original.plan.project_id)!;
        await step("activate-A", { kind: "project", args: projectArgs(p, "activate-asset", ["--asset-id", p.asset!.asset_id]) });
      }
      const executionId = current.external.find(r => r.action.action_id === actionId)!.execution!.execution_id;
      await step(`observe-action-${p.plan.project_id}`, { kind: "monitor", command: { kind: "record", projectId: p.plan.project_id, experimentId: p.experiment_id,
        assetId: null, type: "external_action_result", data: { execution_id: executionId }, effectiveAt: null, preview: false } });
    }
    await stage("ACTIONS_SIMULATED");
    const admitted = () => projects().filter(p => p.approval?.request.status === "approved" && !m.steps.some(s => s.key === `close-denied-${p.plan.project_id}`));
    for (const [day, checkpoint] of [[0, "start"], [1, "day_1"], [3, "day_3"], [5, "day_5"], [7, "deadline"]] as const) {
      for (const p of [...admitted()]) await step(`monitor-${checkpoint}-${p.plan.project_id}`, { kind: "monitor", command: { kind: "checkpoint", projectId: p.plan.project_id, experimentId: p.experiment_id, checkpoint, preview: false } }, day);
    }
    await stage("MONITORING");
    for (const p of [...admitted()]) {
      await step(`claim-${p.plan.project_id}`, { kind: "monitor", command: { kind: "record", projectId: p.plan.project_id, experimentId: p.experiment_id, assetId: null,
        type: "sale_claim", data: { amount_cents: 99999 }, effectiveAt: null, preview: false } }, 7);
      await step(`result-${p.plan.project_id}`, { kind: "project", args: projectArgs(p, "close-experiment", ["--request-id", p.approval!.request.request_id,
        "--expense-cents", p.plan.name === "A" ? "700" : "800", "--revenue-cents", p.plan.name === "A" ? "1200" : "400",
        "--classification", p.plan.name === "A" ? "successful" : "failed", "--asset-policy", p.plan.name === "A" ? "keep" : "retire"]) }, 7);
    }
    const a = admitted().find(p => p.plan.name === "A");
    if (a) await step("passive-A", { kind: "project", args: projectArgs(a, "record-passive-revenue", ["--asset-id", a.asset!.asset_id, "--receipt-id", m.passive_receipt_id, "--revenue-cents", "200"]) }, 8);
    await stage("RESULTS_RECORDED");
    await step("learning-update", { kind: "learn", command: { kind: "refresh-hypothesis", hypothesisId: m.hypothesis_id, preview: false } }, 8);
    await stage("LEARNING_UPDATED");
    if (m.pending) throw new Error("Unknown unconsumed pilot intent");
    pilotContext()!.now = at(8);
    const learning = await pilotService("learning", () => runLearningScout({ root, command: { kind: "analyze-batch", batchId: batch }, now: () => at(8) }));
    current = await state(root); const events = await apiCheck(root, current);
    if (!same((await state(root)).pins, current.pins)) throw new Error("Control API altered business state");
    const sources = await readLearningSources(root), evidence = projects().map(p => buildProjectEvidence(sources, p.plan.project_id));
    const allSimulated = current.external.length === 2 && current.external.every(r => r.execution?.status === "simulated");
    const checks = {
      complete_lifecycle: admitted().length === 2 && evidence.every(e => e.facts.financial_status === "confirmed_closed"),
      limits_unchanged: projects().length === 2 && projects().every(p => p.plan.budget_cents <= 1000 && p.plan.duration_days <= 7) && proposal.total_proposed_cents <= 2000,
      canonical_approvals: allSimulated && current.snapshot.approvals.length === 4 && current.snapshot.approvals.every(a => a.status === "approved" && a.consumed),
      external_actions_simulated: allSimulated,
      monitoring_completed: m.monitoring_ids.length === 14,
      positive_and_negative_learned: learning.hypotheses[0]?.status === "mixed" && learning.hypotheses[0]?.evidence_for.length === 1 && learning.hypotheses[0]?.evidence_against.length === 1,
      experiment_vs_lifetime: evidence.some(e => e.derived_metrics.experiment_net_cents === 500 && e.derived_metrics.lifetime_net_cents === 700 && e.derived_metrics.deadline_net_cents === 500) && evidence.some(e => e.derived_metrics.experiment_net_cents === -400),
      unconfirmed_claims_excluded: current.project.ledger.total_recorded_revenue_cents === 1800,
      control_api_coherent: true, ordered_unique_events: true,
      mobile_progress_visible: ["APPROVAL_REQUIRED", "OUT_OF_BUDGET_OPPORTUNITY", "PROJECT_UPDATED", "PROJECT_COMPLETED"].every(t => events.some(e => e.event_type === t)),
      restart_idempotence_validated: wasCompleted && options.command === "resume",
      zero_network_ollama_shell: pilotContext()!.guard.attempts === 0 && m.safety_violations === 0,
    };
    const blocking = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
    m.current_stage = "COMPLETED"; m.completed_at = at(8); m.status = admitted().length === 2 ? "COMPLETED" : "DENIED"; m.blocking_reasons = blocking; await persist();
    const report = { schema_version: "12.6", run_id: m.run_id, mode: "DRY_RUN_ONLY", financial_notice: "ALL FINANCIAL VALUES IN THIS PILOT ARE SIMULATED", notice: "NO REAL MONEY WAS SPENT",
      final_state_fingerprint: canonicalHash(current.pins), started_at: m.started_at, completed_at: m.completed_at, source_state_fingerprint: m.source_state_fingerprint,
      opportunity_ids: m.opportunity_ids, allocation_id: m.allocation_id, project_ids: m.project_ids, approval_ids: m.approval_ids,
      action_simulation_ids: m.action_simulation_ids, monitoring_ids: m.monitoring_ids, result_ids: m.result_ids, learning_references: learning.hypotheses,
      evidence_references: evidence.map(e => ({ project_id: e.project_id, evidence_hash: canonicalHash(e), result_id: e.source_refs.result_id, financial_entry_ids: e.source_refs.financial_entries.map(v => v.entry_id) })),
      event_sequence_range: [events[0]?.sequence ?? 0, events.at(-1)?.sequence ?? 0],
      simulated_starting_capital_cents: 10000, simulated_expenses_cents: current.project.ledger.total_recorded_expenses_cents,
      simulated_revenues_cents: current.project.ledger.total_recorded_revenue_cents, simulated_final_capital_cents: current.project.ledger.available_balance_cents,
      blocked_safety_attempts: m.safety_violations + pilotContext()!.guard.attempts, real_money_spent_cents: 0, public_network: 0, ollama: 0, payments: 0, publication: 0,
      invariant_checks: checks, failures: blocking, warnings: ["SYNTHETIC_EVIDENCE_NOT_MARKET_VALIDATION", "INITIAL_ALLOCATION_RETAINED_AS_STALE_AFTER_PLANNED_PROJECT_MUTATIONS"],
      technical_readiness: blocking.length ? "NOT_READY_FOR_SUPERVISED_REAL_PILOT" : "READY_FOR_SUPERVISED_REAL_PILOT", blocking_reasons: blocking,
      verdict_authorizes_execution: false };
    await atomicWrite(root, "pilot-dry-run-report.json", structured(report), raw => { if (!same(JSON.parse(raw), report)) throw new Error("Report mismatch"); });
    return { ...(await status()), report };
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      m.status = /stale|fingerprint|corrupt|authentication|unsafe|binding|Impossible|Unknown|Consumed/i.test(reason) ? "BLOCKED" : "FAILED";
      m.blocking_reasons = [reason];
      // Preserve pending intent and original pins. Never repair canonical data.
      await savePilot(root, m, key);
      const failure = { schema_version: "12.6", run_id: m.run_id, mode: "DRY_RUN_ONLY", started_at: m.started_at, completed_at: null,
        source_state_fingerprint: m.source_state_fingerprint, opportunity_ids: m.opportunity_ids, allocation_id: m.allocation_id, project_ids: m.project_ids,
        approval_ids: m.approval_ids, action_simulation_ids: m.action_simulation_ids, monitoring_ids: m.monitoring_ids, result_ids: m.result_ids, learning_references: m.learning_ids,
        event_sequence_range: null, simulated_starting_capital_cents: 10000, simulated_expenses_cents: null, simulated_revenues_cents: null, simulated_final_capital_cents: null,
        invariant_checks: { complete_lifecycle: false }, failures: [reason], warnings: [], blocking_reasons: [reason],
        technical_readiness: "NOT_READY_FOR_SUPERVISED_REAL_PILOT", real_money_spent_cents: 0, notice: "NO REAL MONEY WAS SPENT",
        financial_notice: "ALL FINANCIAL VALUES IN THIS PILOT ARE SIMULATED", verdict_authorizes_execution: false };
      await atomicWrite(root, "pilot-dry-run-report.json", structured(failure), raw => { if (!same(JSON.parse(raw), failure)) throw new Error("Failure report mismatch"); });
      throw error;
    } finally {
      if (pilotContext()!.guard.attempts) { m.safety_violations += pilotContext()!.guard.attempts; await savePilot(root, m, key); }
    }
  }));
}
export async function runPilotCli(args: string[]) {
  if (args.length === 4 && ["--approve-simulated", "--deny-simulated"].includes(args[0]) && args[2] === "--subject-id") {
    console.log(structured(await runPilotDryRun({ command: "resume", decision: { requestId: args[1], subjectId: args[3], decision: args[0] === "--approve-simulated" ? "approve" : "deny" } }))); return;
  }
  const command = args[0]?.slice(2);
  if (args.length !== 1 || !["run", "resume", "status"].includes(command)) throw new Error("V12.6 accepts --run, --resume or --status only; or --approve-simulated/--deny-simulated <request-id> --subject-id <id>");
  console.log(structured(await runPilotDryRun({ command: command as PilotOptions["command"] })));
}
