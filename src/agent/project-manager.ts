/** Local V9 orchestration. No inference or network execution. */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { scoutWorkspaceRoot } from "./local-tools.js";
import { scoutMode } from "./opportunity-scout.js";
import { locked, readConfined } from "./ledger-runner.js";
import { parseEconomicLedger, ledgerPrefix, LEDGER_LIMITS, reserveProjectReference, recordAuthorizedEvent, type EconomicLedger } from "./economic-ledger.js";
import { PROJECT_LIMITS, experimentTiming } from "./asset-lifecycle.js";
import { loadProjectState, checkProjectViews, commitProjectState, type ProjectState } from "./project-store.js";
import { validateProjectCommand, canonicalHash, same, exact, hex, uuid, time, economicChanges, transition, findProject, requireLive, projectMetrics,
  type ProjectCommand, type ProjectEvent, type ProjectModel, type ExternalProjectLink, type ProjectOperation } from "./project-model.js";
export { parseProjectCommand } from "./project-model.js";
const empty = (): ProjectModel => ({ batch: null, projects: [] });
function checkpoint(ledger: EconomicLedger) { return { count: ledger.entries.length, hash: canonicalHash(ledger) }; }
/** Replay state transitions and cross-check every financial event with V5. */
export function auditProjects(events: ProjectEvent[], ledger: EconomicLedger): ProjectModel {
  if (events.length > PROJECT_LIMITS.MAX_EVENTS) throw new Error("Project history event limit");
  let model = empty(), lastCount = 1, lastTime = "";
  const ids = new Set<string>(), claimed = new Set<string>();
  for (const event of events) {
    exact(event, ["event_id", "at", "new_id", "command", "external", "ledger_before_count", "ledger_before_hash", "ledger_after_count", "ledger_after_hash", "ledger_entry_ids"]);
    uuid(event.event_id, "projectevent"); time(event.at);
    if (event.at < lastTime || ids.has(event.event_id) || (event.new_id !== null && ids.has(event.new_id))) throw new Error("Duplicate event/generated ID or clock rollback");
    ids.add(event.event_id); if (event.new_id !== null) ids.add(event.new_id);
    if (!Number.isSafeInteger(event.ledger_before_count) || !Number.isSafeInteger(event.ledger_after_count) || event.ledger_before_count < lastCount || event.ledger_after_count < event.ledger_before_count) throw new Error("Invalid project ledger counts");
    const before = ledgerPrefix(ledger, event.ledger_before_count), after = ledgerPrefix(ledger, event.ledger_after_count);
    if (event.at < before.entries.at(-1)!.timestamp) throw new Error("Project event predates ledger; clock rollback");
    if (canonicalHash(before) !== hex(event.ledger_before_hash) || canonicalHash(after) !== hex(event.ledger_after_hash)) throw new Error("Project ledger prefix mismatch");
    const changes = economicChanges(model, event.command, event.event_id), delta = after.entries.slice(before.entries.length);
    if (!same(event.ledger_entry_ids, delta.map(e => e.id)) || delta.length !== changes.length) throw new Error("Project ledger entry binding mismatch");
    delta.forEach((entry, i) => {
      const expected = changes[i];
      if (claimed.has(entry.id) || entry.type !== expected.type || entry.timestamp < event.at) throw new Error("Reused/mismatched project ledger event"); claimed.add(entry.id);
      if (expected.type === "reserve") {
        if (entry.amount_cents !== expected.reference.budget_cents || !same(entry.experiment, expected.reference) || entry.human_reference !== null || entry.description !== "Réservation V9 comptable ; aucun paiement") throw new Error("Project reservation mismatch");
      } else {
        if (entry.amount_cents !== expected.amount_cents || entry.human_reference !== expected.authorization.reference || entry.description !== expected.description ||
          (expected.type === "revenue" ? entry.experiment !== null : entry.experiment?.id !== expected.experiment_id)) throw new Error("Project financial event mismatch");
      }
    });
    model = transition(model, event, before, after);
    lastCount = event.ledger_after_count; lastTime = event.at;
  }
  const projectIds = new Set(model.projects.map(p => p.experiment_id));
  for (const e of ledger.entries) {
    if ((projectIds.has(e.experiment?.id ?? "") || e.human_reference?.startsWith("local-cli:v9:")) && !claimed.has(e.id)) throw new Error("Untracked mutation of a project reservation/revenue");
  }
  return model;
}
/** Caller holds shared lock. The history pins all prior ledger prefixes and views. */
export async function readProjectContext(root: string) {
  const loaded = await loadProjectState(root);
  const raw = await readConfined(root, "economic-ledger.json", LEDGER_LIMITS.maxBytes);
  if (!raw) throw new Error("Initialize existing V5 ledger explicitly first");
  const ledger = parseEconomicLedger(raw), model = auditProjects(loaded.state?.events ?? [], ledger);
  await checkProjectViews(root, model);
  return { ...loaded, raw, ledger, model };
}
function report(model: ProjectModel, command: ProjectCommand, now: string, ledger: EconomicLedger) {
  const items = command.operation === "inspect-project" ? [findProject(model, command.target)] : model.projects;
  return JSON.stringify({ version: 9, preview: command.preview, notice: "NO REAL MONEY IS SPENT BY V9", batch: model.batch,
    projects: items.map(p => ({ ...p, timing: experimentTiming(p.started_at, p.experiment_deadline, p.closed_at, now), metrics: projectMetrics(p) })),
    ledger: { available_cents: ledger.available_balance_cents, reserved_cents: ledger.reserved_balance_cents } }, null, 2) + "\n";
}
async function linkSnapshot(root: string, c: ProjectCommand): Promise<ExternalProjectLink | null> {
  if (c.operation !== "link-external-action") return null;
  const { readExternalBinding } = await import("./external-gateway.js");
  const entry = await readExternalBinding(root);
  if (!entry || entry.execution || entry.approval.request.status !== "pending" || entry.action.action_id !== c.fields["action-id"] || entry.approval.request.request_id !== c.fields["request-id"]) throw new Error("Exact pending unattempted V8 action required before approval");
  return { project_id: c.target!, experiment_id: c.fields["experiment-id"], action_id: entry.action.action_id, request_id: entry.approval.request.request_id,
    action_fingerprint: canonicalHash(entry.action), request_fingerprint: entry.approval.request.request_fingerprint };
}
export async function runProjectScout(options: { root?: string; command: ProjectCommand; onEvent?: (s: string) => void }): Promise<string> {
  const c = validateProjectCommand(options.command), decision = ["approve-project", "deny-project"].includes(c.operation);
  if (scoutMode() !== (decision ? "approval" : "projects")) throw new Error(decision ? "Project decisions require SCOUT_MODE=approval" : "Project manager requires SCOUT_MODE=projects");
  const root = path.resolve(options.root ?? scoutWorkspaceRoot());
  return locked(root, () => applyProjectCommand(root, c, options.onEvent));
}
async function applyProjectCommand(root: string, c: ProjectCommand, onEvent?: (s: string) => void): Promise<string> {
    const current = await readProjectContext(root), now = new Date().toISOString();
    if (current.state?.events.at(-1) && now < current.state.events.at(-1)!.at) throw new Error("Clock moved backwards");
    if (c.operation === "list-projects" || c.operation === "inspect-project") {
      const output = report(current.model, c, now, current.ledger); onEvent?.(output); return output;
    }
    if ((current.state?.events.length ?? 0) >= PROJECT_LIMITS.MAX_EVENTS) throw new Error("Project history event limit");
    const prefix: Partial<Record<ProjectOperation, string>> = { "create-batch": "batch", "create-project": "project", "reserve-project": "request", "approve-project": "approval", "create-asset": "asset" };
    const before = checkpoint(current.ledger), event: ProjectEvent = { event_id: `projectevent-${randomUUID()}`, at: now,
      new_id: prefix[c.operation] ? `${prefix[c.operation]}-${randomUUID()}` : null, command: { ...c, preview: false }, external: await linkSnapshot(root, c),
      ledger_before_count: before.count, ledger_before_hash: before.hash, ledger_after_count: before.count, ledger_after_hash: before.hash, ledger_entry_ids: [] };
    let ledger = current.ledger;
    for (const change of economicChanges(current.model, c, event.event_id)) ledger = change.type === "reserve" ? reserveProjectReference(ledger, change.reference) : recordAuthorizedEvent(ledger, change);
    const after = checkpoint(ledger); event.ledger_after_count = after.count; event.ledger_after_hash = after.hash;
    event.ledger_entry_ids = ledger.entries.slice(before.count).map(e => e.id);
    const events = [...(current.state?.events ?? []), event], model = auditProjects(events, ledger);
    const message = report(model, c, now, ledger);
    // Revalidate snapshots under the shared lock immediately before commit.
    const reread = await readProjectContext(root);
    if (reread.raw !== current.raw || !same(reread.state, current.state)) throw new Error("Project inputs changed");
    if (!same(await linkSnapshot(root, c), event.external)) throw new Error("V8 binding changed before project commit");
    if (!c.preview) {
      const state: ProjectState = { version: 9, workspace: root, phase: "complete", events };
      await commitProjectState(root, state, current.model, model, current.raw, ledger, current.key);
    }
    onEvent?.(message); return message;
}

/** Decision-only host adapter; caller holds the V5 lock. Never reserves/starts. */
export async function decideExistingProjectApproval(root: string, projectId: string, requestId: string, kind: "approve" | "deny"): Promise<void> {
  if (scoutMode() !== "control-api" || !["approve", "deny"].includes(kind)) throw new Error("Control decision required");
  uuid(requestId, "request");
  const current = await readProjectContext(root), p = findProject(current.model, projectId);
  if (!p.approval || p.approval.request.request_id !== requestId) throw new Error("Exact project approval required");
  const wanted = kind === "approve" ? "approved" : "denied";
  if (p.approval.request.status === wanted && (kind === "approve" ? p.status === "approved" : p.status === "reserved")) return;
  if (p.approval.request.status !== "pending" || p.status !== "reserved") throw new Error("Incompatible or consumed project approval");
  const c = validateProjectCommand({ operation: kind === "approve" ? "approve-project" : "deny-project", target: projectId,
    fields: { "experiment-id": p.experiment_id, "request-id": requestId }, preview: false });
  await applyProjectCommand(root, c);
}

/** V8 calls under the shared lock before intent/network. Unscoped V8 remains
 * compatible; a linked action requires both exact IDs and a live V9 approval. */
export async function verifyExternalProjectScope(root: string, actionId: string, requestId: string, actionFingerprint: string,
  requestFingerprint: string, scope?: { projectId: string; experimentId: string }): Promise<void> {
  const loaded = await loadProjectState(root);
  if (!loaded.state) {
    await checkProjectViews(root, empty());
    if (scope) throw new Error("No V9 project binding"); return;
  }
  const { model, state } = await readProjectContext(root);
  if (new Date().toISOString() < state!.events.at(-1)!.at) throw new Error("Clock moved backwards");
  const links = model.projects.flatMap(p => p.external_actions), link = links.find(a => a.action_id === actionId);
  if (!link) { if (scope) throw new Error("V8 action is not bound to this project"); return; }
  if (!scope || link.project_id !== scope.projectId || link.experiment_id !== scope.experimentId || link.request_id !== requestId ||
    link.action_fingerprint !== actionFingerprint || link.request_fingerprint !== requestFingerprint) throw new Error("Exact V8 project/experiment binding required");
  const p = findProject(model, scope.projectId, scope.experimentId); requireLive(p, new Date().toISOString());
  if (p.approval?.request.status !== "approved" || p.approval.decision?.status !== "approved") throw new Error("Project approval required for scoped V8 action");
}
