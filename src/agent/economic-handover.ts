/** Trusted operator CLI only. No model, HTTP, payment, publication or execution. */
import { randomBytes, randomUUID } from "node:crypto";
import { locked, readConfined } from "./ledger-runner.js";
import { scoutWorkspaceRoot } from "./local-tools.js";
import { readPreparationSnapshot, assertPreparationCapacity } from "./pilot-preparation.js";
import { encodePreparation } from "./pilot-preparation-store.js";
import { encodeProjectState, PROJECT_FILES, projectViews } from "./project-store.js";
import { canonicalHash, exact, hex, same, structured, time } from "./project-model.js";
import { historicalSources } from "./evidence-builder.js";
import { buildHandoverPlan } from "./pilot-readiness-model.js";
import { preparationBlockers, reference } from "./pilot-preparation-model.js";
import { assertPilotNotStopped, normalizedPilotRoot, pilotStopped } from "./pilot-stop.js";
import { buildEconomicReport } from "./economic-ledger.js";
import { assertExactHandoverApproval, buildHandoverDelta, type HandoverRequest } from "./economic-handover-model.js";
import { loadHandover, saveHandover, installHandover, assertHandoverInstalled, writeDirectory, HANDOVER_MAX_BYTES, type HandoverState, type WriteImage } from "./economic-handover-store.js";

export type HandoverCommand = { kind: "inspect" } | { kind: "recover" } |
  { kind: "prepare"; project_id: string; dossier_hash: string } |
  { kind: "approve" | "deny" | "transfer"; project_id: string; dossier_hash: string; request_id: string; fingerprint: string };
export function parseHandoverCommand(args: string[]): HandoverCommand {
  if (args.length === 1 && ["--inspect", "--recover"].includes(args[0])) return { kind: args[0].slice(2) as "inspect" };
  if (args.length === 3 && args[0] === "--prepare") return { kind: "prepare", project_id: reference(args[1]), dossier_hash: hex(args[2]) };
  if (args.length === 5 && ["--approve", "--deny", "--transfer"].includes(args[0])) return { kind: args[0].slice(2) as "approve", project_id: reference(args[1]), dossier_hash: hex(args[2]), request_id: reference(args[3]), fingerprint: hex(args[4]) };
  throw new Error("HANDOVER_COMMAND_FORBIDDEN");
}
function validateCommand(c: HandoverCommand) {
  exact(c, c.kind === "inspect" || c.kind === "recover" ? ["kind"] : c.kind === "prepare" ? ["kind", "project_id", "dossier_hash"] : ["kind", "project_id", "dossier_hash", "request_id", "fingerprint"]);
  const args = c.kind === "inspect" || c.kind === "recover" ? [`--${c.kind}`] : c.kind === "prepare" ? ["--prepare", c.project_id, c.dossier_hash] : [`--${c.kind}`, c.project_id, c.dossier_hash, c.request_id, c.fingerprint];
  if (!same(parseHandoverCommand(args), c)) throw new Error("HANDOVER_COMMAND_FORBIDDEN");
}
type Snapshot = Awaited<ReturnType<typeof readPreparationSnapshot>>;
const sourceHash = (s: Snapshot) => canonicalHash([s.state, s.sources, s.missing]);
function validateSnapshot(s: Snapshot) {
  if (!s.state.supervision) throw new Error("HANDOVER_V12_8_REQUIRED");
  // Preserve V12.8/V13's ORIGINAL authenticated plan. It never becomes executable.
  const historical = historicalSources(s.sources.financial, s.state.financial_pin);
  // Existing canonicalHash uses JSON field order. Keep readLearningSources'
  // original contract ordering when reconstructing its pinned prefix.
  const originalFinancial = { ...s.sources.financial, ledger: historical.ledger, model: historical.model,
    projects: historical.projects, observations: historical.observations, revenues: historical.revenues };
  const originalProjects = s.state.projects.map(p => { const { accounting_transfer: _receipt, ...original } = p; return original; });
  const original = buildHandoverPlan({ ...s.sources, financial: originalFinancial }, originalProjects);
  if (canonicalHash(original) !== s.state.supervision.plan_hash || original.capacity_blockers.length) throw new Error("HANDOVER_SOURCE_PLAN_INVALID");
  assertPreparationCapacity(s.sources, s.state.projects);
  const legacy = s.sources.financial.model.projects, ids = new Set(legacy.map(p => p.experiment_id));
  const standalone = s.sources.financial.ledger.entries.filter(e => e.type === "reserve" && !ids.has(e.experiment!.id));
  if (legacy.length + standalone.length + s.state.projects.filter(p => !p.accounting_transfer).length > 2) throw new Error("PROJECT_LIMIT_EXCEEDED");
  if (s.missing.length) throw new Error("HANDOVER_MISSING_EVIDENCE");
}
function view(s: HandoverState, snapshot?: Snapshot) {
  return { version: "14.2", mode: "LOCAL_ACCOUNTING_ONLY", requests: s.requests,
    transfers: s.transactions.map(t => ({ request_id: t.request_id, committed_at: t.committed_at,
      status: t.installed ? "ACCOUNTING_TRANSFER_INSTALLED" : "COMMITTED_RECOVERY_REQUIRED", scope: s.requests.find(r => r.scope.request_id === t.request_id)!.scope })),
    active_preparation_reserved_cents: snapshot?.state.projects.filter(p => !p.accounting_transfer).reduce((n, p) => n + p.reserved_budget_cents, 0) ?? null,
    available_bookkeeping_cents: snapshot?.sources.financial.ledger.available_balance_cents ?? null,
    v5_reserved_cents: snapshot?.sources.financial.ledger.reserved_balance_cents ?? null,
    capital_is_bank_balance: false, bank_verified_available_cents: null,
    execution_allowed: false, project_started: false, money_moved_cents: 0, payment_performed: false, publication_performed: false,
    notice: "ACCOUNTING_RECLASSIFICATION_ONLY; V9_APPROVAL_REMAINS_PENDING; LEGACY_WRITERS_REMAIN_SEALED; NO_REAL_BUSINESS_LAUNCH" };
}
export async function runEconomicHandover(options: { root?: string; command: HandoverCommand; now?: () => string }) {
  if (process.env.SCOUT_MODE !== "economic-handover") throw new Error("Explicit SCOUT_MODE=economic-handover required");
  validateCommand(options.command);
  const root = normalizedPilotRoot(options.root ?? scoutWorkspaceRoot()), c = options.command;
  return locked(root, async () => {
    const loaded = await loadHandover(root), s = structuredClone(loaded.state);
    const clock = () => time((options.now ?? (() => new Date().toISOString()))());
    const now = clock();
    const pending = s.transactions.find(t => !t.installed);
    if (pending) {
      if (c.kind === "inspect") return view(s);
      if (c.kind !== "recover" || !loaded.key) throw new Error("HANDOVER_RECOVERY_REQUIRED");
      // Completes a previously committed local transaction, even after expiry or
      // stop. It never accepts a new decision or starts an external operation.
      await installHandover(root, s, loaded.key);
    }
    await assertHandoverInstalled(root);
    const snapshot = await readPreparationSnapshot(root, now, await pilotStopped(root));
    validateSnapshot(snapshot);
    if (c.kind === "inspect" || c.kind === "recover") return view(s, snapshot);
    await assertPilotNotStopped(root);
    if (s.requests.some(r => now < r.scope.created_at || r.decided_at && now < r.decided_at) || s.transactions.some(t => now < t.committed_at)) throw new Error("HANDOVER_CLOCK_ROLLBACK");
    const p = snapshot.state.projects.find(p => p.project_id === c.project_id && p.dossier_hash === c.dossier_hash);
    if (!p) throw new Error("HANDOVER_EXACT_PROJECT_REQUIRED");
    let r: HandoverRequest;
    if (c.kind === "prepare") {
      const previous = s.requests.filter(r => r.scope.project_id === p.project_id).at(-1);
      if (p.accounting_transfer) return view(s, snapshot);
      if (preparationBlockers(p, now).length) throw new Error("HANDOVER_DOSSIER_BLOCKED");
      if (p.reserved_budget_cents <= 0) throw new Error("HANDOVER_POSITIVE_RESERVATION_REQUIRED");
      if (previous && previous.status !== "denied") {
        if (previous.scope.source_hash !== sourceHash(snapshot) || now >= previous.scope.expires_at) throw new Error("HANDOVER_REQUEST_STALE; no implicit renewal");
        return view(s, snapshot);
      }
      // One unconsumed request at a time: otherwise committing A would stale B's
      // exact source fingerprint. No implicit renewal of an approved request.
      if (s.requests.some(r => r.status !== "denied" && !s.transactions.some(t => t.request_id === r.scope.request_id))) throw new Error("HANDOVER_OTHER_REQUEST_OUTSTANDING");
      if (s.requests.length >= 8) throw new Error("HANDOVER_REQUEST_LIMIT");
      const scope = { transfer_id: `handover-${canonicalHash([p.project_id, p.dossier_hash]).slice(0, 32)}`,
        project_id: p.project_id, dossier_hash: p.dossier_hash, request_id: `handover-request-${randomUUID()}`, source_hash: sourceHash(snapshot),
        created_at: now, expires_at: p.dossier.review_expires_at, amount_cents: p.reserved_budget_cents,
        target_plan: { project_id: `project-${randomUUID()}`, batch_id: snapshot.sources.financial.model.batch?.batch_id ?? `batch-${randomUUID()}`,
          name: p.candidate.title, hypothesis: p.dossier.description, budget_cents: p.reserved_budget_cents, duration_days: p.dossier.duration_days, created_at: now },
        reservation_request_id: `request-${randomUUID()}` };
      r = { scope, fingerprint: canonicalHash(scope), status: "pending", decided_at: null, human_reference: null };
      s.requests.push(r);
    } else {
      const found = s.requests.find(r => r.scope.project_id === c.project_id && r.scope.dossier_hash === c.dossier_hash && r.scope.request_id === c.request_id && r.fingerprint === c.fingerprint);
      if (!found) throw new Error("HANDOVER_SCOPE_MISMATCH"); r = found;
      const committed = s.transactions.find(t => t.request_id === r.scope.request_id);
      if (committed && c.kind === "transfer") return view(s, snapshot); // receipt, never renewed permission
      if (committed || now >= r.scope.expires_at) throw new Error("HANDOVER_APPROVAL_EXPIRED_OR_CONSUMED");
      if (r.scope.source_hash !== sourceHash(snapshot)) throw new Error("HANDOVER_SOURCES_CHANGED");
      if (c.kind === "approve" || c.kind === "deny") {
        if (r.status !== "pending") throw new Error("HANDOVER_DECISION_TERMINAL");
        r.status = c.kind === "approve" ? "approved" : "denied"; r.decided_at = now;
        r.human_reference = `local-cli:v14.2:${r.status}:${r.scope.request_id}`;
      } else {
        assertExactHandoverApproval(r, p, now);
        const delta = buildHandoverDelta(snapshot.sources.financial.ledger, snapshot.sources.financial.projects, r, now,
          Array.from({ length: snapshot.sources.financial.model.batch ? 2 : 3 }, () => `projectevent-${randomUUID()}`));
        const next = structuredClone(snapshot.state), target = next.projects.find(p => p.project_id === c.project_id)!;
        target.accounting_transfer = { transfer_id: r.scope.transfer_id, request_id: r.scope.request_id, fingerprint: r.fingerprint, transferred_at: now,
          target_project_id: r.scope.target_plan.project_id, experiment_id: delta.entry.experiment!.id,
          ledger_entry_id: delta.entry.id, ledger_entry_hash: delta.entry.hash, amount_cents: r.scope.amount_cents };
        next.updated_at = now;
        const nextSources = { ...snapshot.sources, financial: { ...snapshot.sources.financial, ledger: delta.ledger, model: delta.model, projects: delta.events } };
        assertPreparationCapacity(nextSources, next.projects);
        const ledger = snapshot.sources.financial.ledger;
        const exposureBefore = ledger.reserved_balance_cents + ledger.total_recorded_expenses_cents + snapshot.state.projects.filter(p => !p.accounting_transfer).reduce((n, p) => n + p.reserved_budget_cents, 0) + snapshot.sources.financial.model.projects.filter(p => p.status === "planned").reduce((n, p) => n + p.plan.budget_cents, 0);
        const exposureAfter = delta.ledger.reserved_balance_cents + delta.ledger.total_recorded_expenses_cents + next.projects.filter(p => !p.accounting_transfer).reduce((n, p) => n + p.reserved_budget_cents, 0) + delta.model.projects.filter(p => p.status === "planned").reduce((n, p) => n + p.plan.budget_cents, 0);
        if (exposureBefore !== exposureAfter || exposureAfter > 2000) throw new Error("HANDOVER_EXPOSURE_INVARIANT");
        const oldKey = await readConfined(writeDirectory(root, "projects"), "integrity-key", 65).catch(e => { if (e.code === "ENOENT") return undefined; throw e; });
        const projectKey = oldKey ? Buffer.from(oldKey.trim(), "hex") : randomBytes(32);
        const writes: WriteImage[] = [];
        const add = async (area: WriteImage["area"], name: string, after: string) => {
          const before = await readConfined(writeDirectory(root, area), name, HANDOVER_MAX_BYTES).catch(e => { if (e.code === "ENOENT") return undefined; throw e; });
          writes.push({ area, name, before: before ?? null, after });
        };
        await add("workspace", "economic-ledger.json", structured(delta.ledger));
        await add("workspace", "economic-report.txt", buildEconomicReport(delta.ledger));
        for (const [i, name] of PROJECT_FILES.entries()) await add("workspace", name, projectViews(delta.model)[i]!);
        await add("preparation", "state.json", encodePreparation(root, next, snapshot.key));
        await add("projects", "integrity-key", projectKey.toString("hex") + "\n");
        await add("projects", "state.json", encodeProjectState(root, { version: 9, workspace: root, phase: "complete", events: delta.events }, projectKey));
        // Revalidate every source and exact authorization immediately before the
        // single durable commit. No file in the write set has been changed yet.
        const commitAt = clock();
        if (commitAt < now || commitAt < delta.entry.timestamp) throw new Error("HANDOVER_CLOCK_ROLLBACK");
        const current = await readPreparationSnapshot(root, commitAt);
        if (sourceHash(current) !== r.scope.source_hash) throw new Error("HANDOVER_SOURCES_CHANGED_BEFORE_COMMIT");
        assertExactHandoverApproval(r, current.state.projects.find(p => p.project_id === r.scope.project_id)!, commitAt);
        target.accounting_transfer.transferred_at = commitAt; next.updated_at = commitAt;
        writes.find(w => w.area === "preparation")!.after = encodePreparation(root, next, snapshot.key);
        await assertPilotNotStopped(root);
        s.transactions.push({ request_id: r.scope.request_id, committed_at: commitAt, writes, installed: false });
        await saveHandover(root, s, snapshot.key); // linearization: signed intent durable before ANY V5/V9 write
        await installHandover(root, s, snapshot.key);
        await assertPilotNotStopped(root);
        const result = await readPreparationSnapshot(root, clock()); validateSnapshot(result);
        return view(s, result);
      }
    }
    const decisionAt = clock();
    if (decisionAt < now || decisionAt >= r.scope.expires_at) throw new Error("HANDOVER_APPROVAL_EXPIRED_OR_CLOCK_ROLLBACK");
    if (c.kind === "approve" || c.kind === "deny") r.decided_at = decisionAt;
    if (sourceHash(await readPreparationSnapshot(root, decisionAt)) !== sourceHash(snapshot)) throw new Error("HANDOVER_SOURCES_CHANGED_BEFORE_DECISION");
    await assertPilotNotStopped(root);
    await saveHandover(root, s, snapshot.key);
    await assertPilotNotStopped(root);
    return view(s, snapshot);
  }, c.kind === "inspect" || c.kind === "recover" ? "handover-read" : "handover");
}
export async function runHandoverCli(args: string[]) {
  try { console.log(JSON.stringify(await runEconomicHandover({ command: parseHandoverCommand(args) }), null, 2)); }
  catch { console.error(JSON.stringify({ version: "14.2", status: "BLOCKED_LOCAL_INSPECTION_REQUIRED", execution_allowed: false, money_moved_cents: 0 })); process.exitCode = 1; }
}
