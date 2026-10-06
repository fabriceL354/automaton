/** V10 orchestration. Only reads authoritative V9/V5 and (on demand) V8.
 * No financial event writer, external executor, inference, scheduler or timer. */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { scoutMode } from "./opportunity-scout.js";
import { scoutWorkspaceRoot } from "./local-tools.js";
import { locked } from "./ledger-runner.js";
import { ledgerPrefix, type EconomicLedger } from "./economic-ledger.js";
import { readProjectContext, auditProjects } from "./project-manager.js";
import { findProject, canonicalHash, same, exact, hex, uuid, type Project, type ProjectModel } from "./project-model.js";
import { loadObservationState, checkObservationViews, saveObservations } from "./observation-store.js";
import { MONITORING_LIMITS, NOTICE, OBSERVATION_TYPES, parseObservationData, monitoringTime, boundedInteger, ledgerEntryId,
  checkpointSchedule, observationWindow, monitoringStatus, monitoringReport, validateMonitoringCommand, type MonitoringCommand, type ObservationEvent } from "./monitoring-model.js";
export { parseMonitoringCommand } from "./monitoring-model.js";
type ProjectContext = Awaited<ReturnType<typeof readProjectContext>>;
interface HistoricalContext { model: ProjectModel; ledger: EconomicLedger }
function contextReader(current: ProjectContext) {
  const cache = new Map<string, HistoricalContext>();
  return (event: ObservationEvent): HistoricalContext => {
    const count = boundedInteger(event.project_history_count, current.state?.events.length ?? 0, 1);
    boundedInteger(event.ledger_count, current.ledger.entries.length, 1);
    const prefix = current.state!.events.slice(0, count);
    if (canonicalHash(prefix) !== hex(event.project_history_hash)) throw new Error("Monitoring V9 history binding mismatch");
    const key = `${count}:${event.ledger_count}`;
    let context = cache.get(key);
    if (!context) { const ledger = ledgerPrefix(current.ledger, event.ledger_count); context = { ledger, model: auditProjects(prefix, ledger) }; cache.set(key, context); }
    if (canonicalHash(context.ledger) !== hex(event.ledger_hash)) throw new Error("Monitoring ledger prefix mismatch");
    if (event.recorded_at < prefix.at(-1)!.at || event.recorded_at < context.ledger.entries.at(-1)!.timestamp) throw new Error("Monitoring event predates authoritative state");
    return context;
  };
}
/** Read V8 lazily only when an observation actually references its result. */
function externalReader(root: string) {
  let records: Promise<Awaited<ReturnType<typeof import("./external-gateway.js")["readVerifiedExternalRecords"]>>> | undefined;
  return async (p: Project, executionId: string) => {
    if (!records) records = import("./external-gateway.js").then(m => m.readVerifiedExternalRecords(root));
    const record = (await records).find(r => r.execution?.execution_id === executionId);
    const link = record && p.external_actions.find(a => a.action_id === record.action.action_id);
    if (!record?.execution || !link || link.project_id !== p.plan.project_id || link.experiment_id !== p.experiment_id || link.request_id !== record.approval.request.request_id ||
      link.action_fingerprint !== canonicalHash(record.action) || link.request_fingerprint !== record.approval.request.request_fingerprint) throw new Error("Authenticated V8 result for exact project/experiment required");
    return record.execution;
  };
}
function reconciliationData(claim: ObservationEvent, entryId: string, p: Project, ledger: EconomicLedger) {
  if (claim.project_id !== p.plan.project_id || claim.experiment_id !== p.experiment_id || !["sale_claim", "expense_claim"].includes(claim.type)) throw new Error("Exact same-project financial claim required");
  const entry = ledger.entries.find(e => e.id === ledgerEntryId(entryId));
  const expectedType = claim.type === "sale_claim" ? "revenue" : "expense";
  if (!entry || entry.type !== expectedType || entry.amount_cents !== claim.data.amount_cents || entry.timestamp < claim.effective_at) throw new Error("Missing/incompatible confirmed financial event");
  let resultId: string | undefined;
  if (claim.asset_id === null) {
    if (p.result?.ledger_entry_ids.includes(entry.id)) resultId = p.result.result_id;
  } else if (p.asset?.asset_id === claim.asset_id && expectedType === "revenue") {
    resultId = p.passive_receipts.find(r => r.ledger_entry_ids.includes(entry.id))?.receipt_id;
  }
  // V5 revenue has experiment=null. Ownership MUST come from authenticated V9
  // result/receipt links, never an amount, description, global total or raw V7 file.
  if (!resultId || (expectedType === "expense" && entry.experiment?.id !== p.experiment_id)) throw new Error("Financial event belongs to another project/experiment or phase");
  return { observation_id: claim.event_id, ledger_entry_id: entry.id, ledger_entry_hash: entry.hash,
    result_event_id: resultId, financial_scope: claim.asset_id === null ? "experiment" : "post_experiment" };
}
export async function auditObservations(root: string, events: ObservationEvent[], current: ProjectContext) {
  if (events.length > MONITORING_LIMITS.MAX_TOTAL_EVENTS) throw new Error("Monitoring total event limit");
  if (events.filter(e => e.type === "reconciliation").length > MONITORING_LIMITS.MAX_RECONCILIATIONS) throw new Error("Monitoring reconciliation limit");
  const context = contextReader(current), external = externalReader(root), ids = new Set<string>(), reconciled = new Set<string>(), financialIds = new Set<string>();
  const counts = new Map<string, number>(), checkpoints = new Set<string>(), executions = new Set<string>(); let previousTime = "", previousProjectCount = 0, previousLedgerCount = 0;
  for (const [index, event] of events.entries()) {
    exact(event, ["version", "event_id", "project_id", "experiment_id", "asset_id", "recorded_at", "effective_at", "type", "source", "data", "project_history_count", "project_history_hash", "ledger_count", "ledger_hash"]);
    if (event.version !== 10 || event.source !== "human_confirmed") throw new Error("Invalid observation version/source");
    uuid(event.event_id, "observation"); uuid(event.project_id, "project"); hex(event.experiment_id); if (event.asset_id !== null) uuid(event.asset_id, "asset");
    monitoringTime(event.recorded_at); monitoringTime(event.effective_at);
    if (event.effective_at > event.recorded_at) throw new Error("Incoherent future effective_at");
    if (ids.has(event.event_id) || event.recorded_at < previousTime || event.project_history_count < previousProjectCount || event.ledger_count < previousLedgerCount) throw new Error("Duplicate observation or monitoring clock/history rollback");
    ids.add(event.event_id); previousTime = event.recorded_at; previousProjectCount = event.project_history_count; previousLedgerCount = event.ledger_count;
    const count = (counts.get(event.experiment_id) ?? 0) + 1; counts.set(event.experiment_id, count);
    if (count > MONITORING_LIMITS.MAX_MONITORING_EVENTS_PER_EXPERIMENT) throw new Error("Monitoring per-experiment event limit");
    const bound = context(event), p = findProject(bound.model, event.project_id, event.experiment_id);
    if (event.type === "reconciliation") {
      exact(event.data, ["observation_id", "ledger_entry_id", "ledger_entry_hash", "result_event_id", "financial_scope"]);
      const claim = events.slice(0, index).find(e => e.event_id === event.data.observation_id);
      if (!claim || event.asset_id !== claim.asset_id || event.effective_at !== event.recorded_at || reconciled.has(claim.event_id) || financialIds.has(event.data.ledger_entry_id as string)) throw new Error("Unknown/duplicate reconciliation or reused financial entry");
      const expected = reconciliationData(claim, event.data.ledger_entry_id as string, p, bound.ledger);
      if (!same(event.data, expected)) throw new Error("Reconciliation binding mismatch");
      reconciled.add(claim.event_id); financialIds.add(expected.ledger_entry_id);
      if (reconciled.size > MONITORING_LIMITS.MAX_RECONCILIATIONS) throw new Error("Monitoring reconciliation limit");
    } else {
      observationWindow(p, event.asset_id, event.type, event.effective_at, event.recorded_at);
      if (event.type === "checkpoint") {
        exact(event.data, ["checkpoint"]);
        const scheduled = checkpointSchedule(p).find(c => c.checkpoint === event.data.checkpoint), key = `${p.experiment_id}:${event.data.checkpoint}`;
        if (!scheduled || event.asset_id !== null || scheduled.at !== event.effective_at || checkpoints.has(key)) throw new Error("Unknown/premature/duplicate checkpoint"); checkpoints.add(key);
      } else if (event.type === "external_action_result") {
        exact(event.data, ["execution_id", "action_id", "execution_fingerprint"]);
        const execution = await external(p, uuid(event.data.execution_id, "execution"));
        if (execution.attempted_at > event.effective_at || execution.action_id !== event.data.action_id || canonicalHash(execution) !== event.data.execution_fingerprint || executions.has(execution.execution_id)) throw new Error("Invalid/duplicate external result observation");
        executions.add(execution.execution_id);
      } else {
        if (!OBSERVATION_TYPES.includes(event.type)) throw new Error("Unknown observation type");
        if (!same(parseObservationData(event.type, event.data), event.data)) throw new Error("Noncanonical observation data");
      }
    }
  }
  // Persisted report is explicitly a snapshot at last append, not a live view.
  const last = events.at(-1);
  const report = last ? "Snapshot au dernier enregistrement ; --status fournit la vue actuelle.\n" + context(last).model.projects.map(p =>
    monitoringReport(monitoringStatus(p, context(last).ledger, events, last.recorded_at))).join("\n") : undefined;
  if (report && Buffer.byteLength(report) > MONITORING_LIMITS.MAX_REPORT_SIZE) throw new Error("Monitoring report size limit");
  return { report, external };
}
async function makeEvent(root: string, command: MonitoringCommand, current: ProjectContext, events: ObservationEvent[], now: string): Promise<ObservationEvent> {
  if (command.kind === "status" || command.kind === "timeline") throw new Error("Read-only command cannot append");
  const p = findProject(current.model, command.projectId, command.experimentId);
  const event: ObservationEvent = { version: 10, event_id: `observation-${randomUUID()}`, project_id: p.plan.project_id, experiment_id: p.experiment_id,
    asset_id: null, recorded_at: now, effective_at: now, type: "checkpoint", source: "human_confirmed", data: {},
    project_history_count: current.state!.events.length, project_history_hash: canonicalHash(current.state!.events), ledger_count: current.ledger.entries.length, ledger_hash: canonicalHash(current.ledger) };
  if (command.kind === "record" || command.kind === "asset") {
    event.asset_id = command.assetId; event.type = command.type; event.effective_at = command.effectiveAt ?? now;
    if (command.type === "external_action_result") {
      const execution = await externalReader(root)(p, (command.data as { execution_id: string }).execution_id);
      event.data = { execution_id: execution.execution_id, action_id: execution.action_id, execution_fingerprint: canonicalHash(execution) };
    } else event.data = { ...command.data };
  } else if (command.kind === "checkpoint") {
    const checkpoint = checkpointSchedule(p).find(c => c.checkpoint === command.checkpoint);
    if (!checkpoint || now < checkpoint.at) throw new Error("Checkpoint not scheduled or not due");
    event.effective_at = checkpoint.at; event.data = { checkpoint: command.checkpoint };
  } else if (command.kind === "reconcile") {
    const claim = events.find(e => e.event_id === command.observationId);
    if (!claim) throw new Error("Unknown exact observation ID");
    event.type = "reconciliation"; event.asset_id = claim.asset_id; event.data = reconciliationData(claim, command.ledgerEntryId, p, current.ledger);
  }
  return event;
}
export async function runMonitoringScout(options: { root?: string; command: MonitoringCommand; now?: () => string; onEvent?: (s: string) => void }) {
  if (scoutMode() !== "monitoring") throw new Error("Monitoring requires SCOUT_MODE=monitoring");
  const command = validateMonitoringCommand(options.command), root = path.resolve(options.root ?? scoutWorkspaceRoot());
  // Clock injection is trusted-host test code only; never a CLI/env clock override.
  return locked(root, async () => {
    const current = await readProjectContext(root), loaded = await loadObservationState(root), events = loaded.state?.events ?? [];
    const now = monitoringTime((options.now ?? (() => new Date().toISOString()))());
    if (now < (current.state?.events.at(-1)?.at ?? "") || now < current.ledger.entries.at(-1)!.timestamp || now < (events.at(-1)?.recorded_at ?? "")) throw new Error("Monitoring clock moved backwards");
    const p = findProject(current.model, command.projectId, command.experimentId), before = await auditObservations(root, events, current);
    await checkObservationViews(root, events, before.report);
    const readOnly = command.kind === "status" || command.kind === "timeline";
    const event = readOnly ? undefined : await makeEvent(root, command, current, events, now);
    const next = event ? [...events, event] : events, audited = event ? await auditObservations(root, next, current) : before;
    const verifySources = async () => {
      const reread = await readProjectContext(root);
      if (reread.raw !== current.raw || !same(reread.state, current.state)) throw new Error("Monitoring authority changed during append");
      // Reread authenticated V8 results too, never trust a cached snapshot at commit.
      await auditObservations(root, next, reread);
    };
    await verifySources();
    const preview = "preview" in command && command.preview;
    if (event && !preview) await saveObservations(root, loaded.state, next, before.report, audited.report!, loaded.key, verifySources);
    const status = monitoringStatus(p, current.ledger, next, now), report = monitoringReport(status);
    const timeline = next.filter(e => e.project_id === p.plan.project_id && e.experiment_id === p.experiment_id);
    const output = { version: 10, notice: NOTICE, preview, event: event ?? null, status, timeline, report };
    options.onEvent?.(command.kind === "status" ? report : JSON.stringify(output, null, 2) + "\n"); return output;
  });
}
