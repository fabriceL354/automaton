/** V10 bounded observations. Pure validation/projection: never financial events. */
import { exact, uuid, hex, time, projectMetrics, type Project } from "./project-model.js";
import { formatCents, type EconomicLedger } from "./economic-ledger.js";
export const MONITORING_LIMITS = Object.freeze({ MAX_MONITORING_EVENTS_PER_EXPERIMENT: 128, MAX_TOTAL_EVENTS: 256,
  MAX_NOTE_LENGTH: 500, MAX_METRIC_VALUE: 1_000_000, MAX_CLAIM_CENTS: 1_000_000, MAX_RECONCILIATIONS: 64,
  MAX_HISTORY_SIZE: 1024 * 1024, MAX_REPORT_SIZE: 64 * 1024 });
export const NOTICE = "NO REAL MONEY OR EXTERNAL ACTION IS PERFORMED BY V10";
export const OBSERVATION_TYPES = ["traffic", "lead", "inquiry", "conversion_signal", "sale_claim", "expense_claim", "inventory", "asset_status", "external_action_result", "note", "risk", "blocker", "effort"] as const;
export type ObservationType = typeof OBSERVATION_TYPES[number];
export const METRICS = ["views", "clicks", "visitors", "inquiries", "leads", "orders_claimed", "units_remaining", "hours_spent_minutes"] as const;
const metricsByType: Partial<Record<ObservationType, readonly string[]>> = { traffic: ["views", "clicks", "visitors"], lead: ["leads"], inquiry: ["inquiries"],
  conversion_signal: ["orders_claimed"], inventory: ["units_remaining"], effort: ["hours_spent_minutes"] };
export const CHECKPOINTS = ["start", "day_1", "day_3", "day_5", "deadline"] as const;
export type Checkpoint = typeof CHECKPOINTS[number];
export type ObservationData = { metric: string; value: number } | { amount_cents: number } | { note: string } | { reported_status: string } | { execution_id: string };
interface Target { projectId: string; experimentId: string }
export type MonitoringCommand = Target & ({ kind: "status" | "timeline" } |
  { kind: "record" | "asset"; assetId: string | null; type: ObservationType; data: ObservationData; effectiveAt: string | null; preview: boolean } |
  { kind: "checkpoint"; checkpoint: Checkpoint; preview: boolean } |
  { kind: "reconcile"; observationId: string; ledgerEntryId: string; preview: boolean });
export interface ObservationEvent {
  version: 10; event_id: string; project_id: string; experiment_id: string; asset_id: string | null;
  recorded_at: string; effective_at: string; type: ObservationType | "checkpoint" | "reconciliation"; source: "human_confirmed";
  data: Record<string, unknown>;
  project_history_count: number; project_history_hash: string; ledger_count: number; ledger_hash: string;
}
export function monitoringTime(v: unknown): string {
  const s = time(v);
  if (s < "2000-01-01T00:00:00.000Z" || s >= "2100-01-01T00:00:00.000Z") throw new Error("Monitoring time outside supported 2000..2099 range"); return s;
}
export function boundedInteger(value: unknown, max: number, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) throw new Error("Bounded nonnegative integer required"); return value;
}
export function ledgerEntryId(v: unknown): string { if (typeof v !== "string" || !/^entry-[0-9]{6}$/.test(v)) throw new Error("Exact ledger entry ID required"); return v; }
export function parseObservationData(type: ObservationType, value: unknown): ObservationData {
  const allowed = metricsByType[type];
  if (allowed) {
    const d = exact(value, ["metric", "value"]);
    if (typeof d.metric !== "string" || !allowed.includes(d.metric)) throw new Error("Unknown/incompatible metric");
    return { metric: d.metric, value: boundedInteger(d.value, MONITORING_LIMITS.MAX_METRIC_VALUE) };
  }
  if (type === "sale_claim" || type === "expense_claim") {
    const d = exact(value, ["amount_cents"]); return { amount_cents: boundedInteger(d.amount_cents, MONITORING_LIMITS.MAX_CLAIM_CENTS, 1) };
  }
  if (["note", "risk", "blocker"].includes(type)) {
    const d = exact(value, ["note"]);
    if (typeof d.note !== "string" || !d.note.trim() || d.note.length > MONITORING_LIMITS.MAX_NOTE_LENGTH || /[\x00-\x1f\x7f]/.test(d.note)) throw new Error("Invalid/oversized observation note");
    return { note: d.note };
  }
  if (type === "asset_status") {
    const d = exact(value, ["reported_status"]);
    if (typeof d.reported_status !== "string" || !["available", "unavailable", "unknown"].includes(d.reported_status)) throw new Error("Unknown reported asset status");
    return { reported_status: d.reported_status };
  }
  if (type === "external_action_result") { const d = exact(value, ["execution_id"]); return { execution_id: uuid(d.execution_id, "execution") }; }
  throw new Error("Unknown observation type");
}
function parseDecimal(raw: unknown, max: number, min = 0): number {
  if (typeof raw !== "string" || !/^(?:0|[1-9][0-9]{0,9})$/.test(raw)) throw new Error("Unambiguous decimal integer required"); return boundedInteger(Number(raw), max, min);
}
export function parseMonitoringCommand(args: string[]): MonitoringCommand {
  const kinds: Record<string, MonitoringCommand["kind"]> = { "--status": "status", "--timeline": "timeline", "--record-observation": "record", "--asset-observation": "asset", "--checkpoint": "checkpoint", "--reconcile-observation": "reconcile" };
  if (!Object.hasOwn(kinds, args[0])) throw new Error("Unknown monitoring command");
  const kind = kinds[args[0]], projectId = uuid(args[1], "project"), fields: Record<string, string> = {}; let preview = false;
  for (let i = 2; i < args.length; i++) {
    const key = args[i];
    if (key === "--preview") { if (preview || kind === "status" || kind === "timeline") throw new Error("Invalid/duplicate preview"); preview = true; continue; }
    if (!/^--[a-z-]+$/.test(key) || Object.hasOwn(fields, key) || i + 1 >= args.length || typeof args[i + 1] !== "string") throw new Error("Unknown/duplicate/missing monitoring argument");
    fields[key] = args[++i];
  }
  const experimentId = hex(fields["--experiment-id"]), target = { projectId, experimentId };
  const keys = ["--experiment-id"];
  const check = () => exact(fields, keys);
  if (kind === "status" || kind === "timeline") { check(); return { kind, ...target }; }
  if (kind === "checkpoint") {
    keys.push("--checkpoint"); check(); const checkpoint = fields["--checkpoint"] as Checkpoint;
    if (!CHECKPOINTS.includes(checkpoint)) throw new Error("Unknown checkpoint"); return { kind, ...target, checkpoint, preview };
  }
  if (kind === "reconcile") {
    keys.push("--observation-id", "--ledger-entry-id"); check();
    return { kind, ...target, observationId: uuid(fields["--observation-id"], "observation"), ledgerEntryId: ledgerEntryId(fields["--ledger-entry-id"]), preview };
  }
  const type = fields["--type"] as ObservationType;
  if (!OBSERVATION_TYPES.includes(type)) throw new Error("Unknown observation type"); keys.push("--type");
  let assetId: string | null = null;
  if (kind === "asset") { keys.push("--asset-id"); assetId = uuid(fields["--asset-id"], "asset"); }
  let effectiveAt: string | null = null;
  if (Object.hasOwn(fields, "--effective-at")) { keys.push("--effective-at"); effectiveAt = monitoringTime(fields["--effective-at"]); }
  let data: ObservationData;
  if (metricsByType[type]) { keys.push("--metric", "--value"); data = { metric: fields["--metric"], value: parseDecimal(fields["--value"], MONITORING_LIMITS.MAX_METRIC_VALUE) }; }
  else if (type === "sale_claim" || type === "expense_claim") { keys.push("--amount-cents"); data = { amount_cents: parseDecimal(fields["--amount-cents"], MONITORING_LIMITS.MAX_CLAIM_CENTS, 1) }; }
  else if (type === "asset_status") { keys.push("--reported-status"); data = { reported_status: fields["--reported-status"] }; }
  else if (type === "external_action_result") { keys.push("--execution-id"); data = { execution_id: fields["--execution-id"] }; }
  else { keys.push("--note"); data = { note: fields["--note"] }; }
  check(); return { kind, ...target, assetId, type, data: parseObservationData(type, data), effectiveAt, preview };
}
export function validateMonitoringCommand(c: MonitoringCommand): MonitoringCommand {
  const keys = ["kind", "projectId", "experimentId"];
  if (c.kind === "record" || c.kind === "asset") keys.push("assetId", "type", "data", "effectiveAt", "preview");
  else if (c.kind === "checkpoint") keys.push("checkpoint", "preview");
  else if (c.kind === "reconcile") keys.push("observationId", "ledgerEntryId", "preview");
  else if (c.kind !== "status" && c.kind !== "timeline") throw new Error("Unknown monitoring command");
  exact(c, keys); uuid(c.projectId, "project"); hex(c.experimentId);
  if ("preview" in c && typeof c.preview !== "boolean") throw new Error("Strict preview boolean required");
  if (c.kind === "record" || c.kind === "asset") {
    if (c.kind === "asset") uuid(c.assetId, "asset"); else if (c.assetId !== null) throw new Error("Unexpected asset ID");
    if (c.effectiveAt !== null) monitoringTime(c.effectiveAt); parseObservationData(c.type, c.data);
  } else if (c.kind === "checkpoint" && !CHECKPOINTS.includes(c.checkpoint)) throw new Error("Unknown checkpoint");
  else if (c.kind === "reconcile") { uuid(c.observationId, "observation"); ledgerEntryId(c.ledgerEntryId); }
  return c;
}
export function checkpointSchedule(p: Project): { checkpoint: Checkpoint; at: string }[] {
  if (!p.started_at || !p.experiment_deadline) return [];
  const start = Date.parse(monitoringTime(p.started_at)), deadline = Date.parse(monitoringTime(p.experiment_deadline));
  const intermediate = ([1, 3, 5] as const).filter(day => start + day * 86400000 < deadline).map(day => ({ checkpoint: `day_${day}` as Checkpoint, at: new Date(start + day * 86400000).toISOString() }));
  return [{ checkpoint: "start", at: p.started_at }, ...intermediate, { checkpoint: "deadline", at: p.experiment_deadline }];
}
/** Validate the lifecycle that existed when a new observation was recorded. */
export function observationWindow(p: Project, assetId: string | null, type: string, effectiveAt: string, recordedAt: string): void {
  monitoringTime(effectiveAt); monitoringTime(recordedAt);
  if (effectiveAt > recordedAt || effectiveAt < p.plan.created_at || !p.started_at || effectiveAt < p.started_at) throw new Error("Incoherent effective_at/project start");
  if (assetId !== null) {
    if (p.status !== "experiment_closed" || !p.closed_at || !p.asset || p.asset.asset_id !== assetId || p.asset.status !== "passive_monitoring") throw new Error("Exact passive asset required; closed/retired observations prohibited");
    if (effectiveAt < p.closed_at || effectiveAt < p.asset.created_at) throw new Error("Asset observation predates passive monitoring");
    if (!["traffic", "inquiry", "lead", "sale_claim", "inventory", "note", "risk", "blocker", "asset_status"].includes(type)) throw new Error("Observation type forbidden in passive monitoring");
  } else {
    if (p.status !== "active" || p.closed_at) throw new Error("Experiment observations require an unclosed active experiment");
    if (effectiveAt > p.experiment_deadline!) throw new Error("Observation effective_at exceeds experiment deadline");
  }
}
export function monitoringStatus(p: Project, ledger: EconomicLedger, events: ObservationEvent[], now: string) {
  monitoringTime(now);
  const timeline = events.filter(e => e.project_id === p.plan.project_id && e.experiment_id === p.experiment_id);
  const checkpoints = checkpointSchedule(p).map(item => ({ ...item, state: timeline.some(e => e.type === "checkpoint" && e.data.checkpoint === item.checkpoint) ? "recorded" : now >= item.at ? "due" : "pending" }));
  const closed = p.closed_at !== null;
  const temporalState = closed ? "closed" : !p.started_at ? "not_started" : now >= p.experiment_deadline! ? "deadline_reached" : checkpoints.some(c => c.state === "due") ? "checkpoint_due" : "active";
  const claims = timeline.filter(e => e.type === "sale_claim" || e.type === "expense_claim").map(e => ({ observation_id: e.event_id, type: e.type, asset_id: e.asset_id,
    amount_cents: e.data.amount_cents as number, reconciled: timeline.some(r => r.type === "reconciliation" && r.data.observation_id === e.event_id) }));
  // Metrics are snapshots, never summed. Effective time wins; append order breaks ties.
  const snapshots = (asset: boolean) => {
    const output: Record<string, number> = {};
    for (const e of [...timeline].filter(e => (e.asset_id !== null) === asset).sort((a, b) => a.effective_at.localeCompare(b.effective_at))) {
      if (typeof e.data.metric === "string") output[e.data.metric] = e.data.value as number;
    }
    return output;
  };
  const observations = timeline.filter(e => e.type !== "checkpoint" && e.type !== "reconciliation");
  const alerts: string[] = [];
  if (!observations.length) alerts.push("NO_OBSERVATION_YET");
  if (!closed && checkpoints.some(c => c.state === "due")) alerts.push("CHECKPOINT_DUE");
  if (temporalState === "deadline_reached") alerts.push("DEADLINE_REACHED", "PENDING_HUMAN_RESULT");
  if (p.asset?.status === "passive_monitoring") alerts.push("ASSET_PASSIVE_MONITORING");
  if (claims.some(c => c.type === "sale_claim" && !c.reconciled)) alerts.push("UNRECONCILED_SALE_CLAIM");
  if (claims.some(c => c.type === "expense_claim" && !c.reconciled)) alerts.push("UNRECONCILED_EXPENSE_CLAIM");
  const reserved = ledger.entries.filter(e => e.experiment?.id === p.experiment_id).reduce((s, e) => s + (e.type === "reserve" ? e.amount_cents : -e.amount_cents), 0);
  return { project_id: p.plan.project_id, experiment_id: p.experiment_id, name: p.plan.name, as_of: now, temporal_state: temporalState,
    started_at: p.started_at, experiment_deadline: p.experiment_deadline, closed_at: p.closed_at,
    day: p.started_at ? Math.min(p.plan.duration_days, Math.max(0, Math.floor((Date.parse(now) - Date.parse(p.started_at)) / 86400000))) : null,
    duration_days: p.plan.duration_days, checkpoints, next_checkpoint: closed ? null : checkpoints.find(c => c.state !== "recorded") ?? null,
    confirmed_financial_data: { reserved_cents: reserved, ...projectMetrics(p), classification: p.result?.classification ?? null },
    observed_unconfirmed_signals: { experiment_metrics: snapshots(false), asset_metrics: snapshots(true), observation_count: observations.length, claims },
    asset: p.asset, alerts };
}
export function monitoringReport(status: ReturnType<typeof monitoringStatus>): string {
  const money = status.confirmed_financial_data, signals = status.observed_unconfirmed_signals;
  const output = ["Scout V10 — suivi expérience", `Projet : ${status.name} (${status.project_id})`, `Expérience : ${status.experiment_id}`,
    `État : ${status.temporal_state.toUpperCase()} ; jour ${status.day ?? "—"}/${status.duration_days}`, `À la date : ${status.as_of}`,
    `Prochain checkpoint : ${status.next_checkpoint ? `${status.next_checkpoint.checkpoint} (${status.next_checkpoint.state})` : "aucun"}`,
    "CONFIRMED FINANCIAL DATA — ledger V5 / résultat humain V9",
    `Réservé : ${formatCents(money.reserved_cents)} ; dépenses confirmées : ${formatCents(money.experiment_expense_cents)}`,
    `Revenus expérience : ${formatCents(money.experiment_revenue_cents)} ; revenus post-expérience : ${formatCents(money.post_experiment_revenue_cents)}`,
    `Résultat lifetime : ${formatCents(money.lifetime_net_result_cents)}`,
    "OBSERVED / UNCONFIRMED SIGNALS — ne constituent pas des ventes ou revenus",
    `Métriques expérience (dernières valeurs) : ${JSON.stringify(signals.experiment_metrics)}`, `Métriques actif : ${JSON.stringify(signals.asset_metrics)}`,
    `Claims : ${signals.claims.length} ; non rapprochées : ${signals.claims.filter(c => !c.reconciled).length}`,
    `Alertes : ${status.alerts.join(", ") || "aucune"}`,
    ...(status.temporal_state === "deadline_reached" ? ["DEADLINE_REACHED — HUMAN CLOSE REQUIRED"] : []),
    "Aucune conclusion économique automatique. Une observation ne constitue pas une preuve financière.", NOTICE, ""].join("\n");
  if (Buffer.byteLength(output) > MONITORING_LIMITS.MAX_REPORT_SIZE) throw new Error("Monitoring report size limit"); return output;
}
