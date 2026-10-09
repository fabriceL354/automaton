/** Offline trusted operator host. V12.7 cannot start, pay, publish, open an
 * account, execute V8, or confirm bank transactions, even after approval. */
import path from "node:path";
import { locked, readConfined } from "./ledger-runner.js";
import { scoutWorkspaceRoot } from "./local-tools.js";
import { readAllocationSources, approvalPins, type AllocationSources } from "./allocation-sources.js";
import { calculateAllocation } from "./capital-allocator.js";
import { historicalSources, sourcePin, sourceTime } from "./evidence-builder.js";
import { canonicalHash, digest, exact, hex, same, time } from "./project-model.js";
import { integerCents } from "./asset-lifecycle.js";
import { PREPARATION_LIMITS, createPreparedProject, parsePreparationInput, preparationBlockers, reference, rejectSensitive, type Dossier, type PreparedProject } from "./pilot-preparation-model.js";
import { addPreparationEvent, loadPreparation, savePreparation, type PreparationState } from "./pilot-preparation-store.js";
export type PreparationCommand = { kind: "prepare" | "inspect" | "events" } |
  { kind: "approve" | "deny"; project_id: string; action_id: string; request_id: string; fingerprint: string } |
  { kind: "review"; project_id: string; dossier_hash: string; quote_cents: number; cost_proof_id: string } |
  { kind: "declare"; project_id: string; declaration_id: string; economic_kind: "expense" | "revenue"; amount_cents: number; phase: "experiment" | "post_experiment"; proof_id: string | null };
const number = (s: string) => { if (!/^(?:0|[1-9][0-9]{0,9})$/.test(s)) throw new Error("Integer cents required"); return integerCents(Number(s)); };
export function parsePreparationCommand(args: string[]): PreparationCommand {
  if (!args[0]?.startsWith("--")) throw new Error("Exact preparation flag required");
  const kind = args[0]?.slice(2);
  if (args.length === 1 && ["prepare", "inspect", "events"].includes(kind)) return { kind: kind as "prepare" | "inspect" | "events" };
  if (args.length === 5 && ["approve", "deny"].includes(kind)) return { kind: kind as "approve" | "deny", project_id: reference(args[1]), action_id: reference(args[2]), request_id: reference(args[3]), fingerprint: hex(args[4]) };
  if (args.length === 5 && kind === "review") return { kind, project_id: reference(args[1]), dossier_hash: hex(args[2]), quote_cents: number(args[3]), cost_proof_id: reference(args[4]) };
  if (args.length === 7 && kind === "declare" && ["expense", "revenue"].includes(args[3]) && ["experiment", "post_experiment"].includes(args[5])) return { kind, project_id: reference(args[1]), declaration_id: reference(args[2]), economic_kind: args[3] as "expense" | "revenue", amount_cents: number(args[4]), phase: args[5] as "experiment" | "post_experiment", proof_id: args[6] === "-" ? null : reference(args[6]) };
  throw new Error("Unsupported preparation command; all execution/payment/publication/account commands forbidden");
}
function validateCommand(c: PreparationCommand): void {
  const fields = c.kind === "approve" || c.kind === "deny" ? ["kind", "project_id", "action_id", "request_id", "fingerprint"] : c.kind === "review" ? ["kind", "project_id", "dossier_hash", "quote_cents", "cost_proof_id"] : c.kind === "declare" ? ["kind", "project_id", "declaration_id", "economic_kind", "amount_cents", "phase", "proof_id"] : ["kind"];
  exact(c, fields);
  const args = c.kind === "approve" || c.kind === "deny" ? [`--${c.kind}`, c.project_id, c.action_id, c.request_id, c.fingerprint] : c.kind === "review" ? ["--review", c.project_id, c.dossier_hash, String(c.quote_cents), c.cost_proof_id] : c.kind === "declare" ? ["--declare", c.project_id, c.declaration_id, c.economic_kind, String(c.amount_cents), c.phase, c.proof_id ?? "-"] : [`--${c.kind}`];
  if (!same(parsePreparationCommand(args), c)) throw new Error("Invalid preparation command");
}
function pins(sources: AllocationSources) {
  const approvals = approvalPins(sources.approvals ?? []);
  const pin = (items: unknown[]) => ({ count: items.length, hash: canonicalHash(items) });
  return { financial_pin: sourcePin(sources.financial), learning_pin: pin(sources.learning_events), approval_pins: { requests: pin(approvals.requests), decisions: pin(approvals.decisions) } };
}
function verifyPrefixes(state: PreparationState, sources: AllocationSources) {
  historicalSources(sources.financial, state.financial_pin);
  const approvals = approvalPins(sources.approvals ?? []);
  for (const [values, pin] of [[sources.learning_events, state.learning_pin], [approvals.requests, state.approval_pins.requests], [approvals.decisions, state.approval_pins.decisions]] as const) {
    if (values.length < pin.count || canonicalHash(values.slice(0, pin.count)) !== pin.hash) throw new Error("Canonical history rollback/rewrite");
  }
  if (sources.input_hash !== state.source_hash) throw new Error("Research changed; human inspection required");
  for (const p of state.projects) if (!sources.candidates.some(c => same(c, p.candidate))) throw new Error("Candidate source changed");
}
async function verifyProofs(root: string, dossiers: Dossier[]) {
  const missing: string[] = [];
  for (const d of dossiers) for (const proof of d.proofs) {
    const raw = await readConfined(root, proof.file, 32 * 1024);
    if (raw === undefined) { missing.push(`${d.opportunity_id}:${proof.proof_id}`); continue; }
    rejectSensitive(raw);
    if (!raw.trim() || digest(raw) !== proof.sha256) throw new Error("Evidence content changed; human inspection required");
  }
  return missing;
}
/** Conservative V9 lifetime batch limits plus V5 standalone exposure. Reference
 * capital and bookkeeping availability are neither bank balance nor funds proof. */
export function assertPreparationCapacity(s: AllocationSources, projects: PreparedProject[]) {
  const ledger = s.financial.ledger, legacy = s.financial.model.projects;
  const budget = integerCents(projects.reduce((sum, p) => sum + p.reserved_budget_cents, 0));
  const planned = integerCents(legacy.filter(p => p.status === "planned").reduce((sum, p) => sum + p.plan.budget_cents, 0));
  const exposure = integerCents(ledger.reserved_balance_cents + ledger.total_recorded_expenses_cents + planned + budget);
  if (legacy.length + projects.length > 2) throw new Error("PROJECT_LIMIT_EXCEEDED");
  if (exposure > 2000 || legacy.reduce((sum, p) => sum + p.plan.budget_cents, 0) + budget > 2000 || projects.some(p => p.reserved_budget_cents > 1000 || p.dossier.duration_days > 7)) throw new Error("SPENDING_CEILING_EXCEEDED");
  if (budget + planned > Math.min(PREPARATION_LIMITS.REFERENCE_CAPITAL_CENTS, ledger.available_balance_cents)) throw new Error("INSUFFICIENT_BUDGET");
}
function projection(state: PreparationState, now: string, missing: string[]) {
  const projects = state.projects.map(p => {
    const blockers = [...preparationBlockers(p, now), ...(missing.some(m => m.startsWith(p.dossier.opportunity_id + ":")) ? ["MISSING_EVIDENCE"] : [])];
    const total = (kind: string, phase?: string) => integerCents(p.declarations.filter(r => r.kind === kind && (!phase || r.phase === phase)).reduce((s, r) => s + r.amount_cents, 0));
    return { ...p, technical_readiness: "PREPARED_OFFLINE", commercial_validation: p.commercial_review ? "HUMAN_DOCUMENTED_REVIEW_NOT_BANK_VERIFICATION" : "REQUIRES_HUMAN_VERIFICATION",
      human_authorization: p.requests.every(r => r.status === "approved") && now < p.dossier.review_expires_at ? "APPROVED_FOR_EXACT_MANUAL_ACTIONS_ONLY" : "NOT_CURRENTLY_APPROVED",
      readiness: blockers.length ? "BLOCKED" : "READY_FOR_MANUAL_LAUNCH", blockers,
      economics: { reference_capital_cents: 10000, planned_budget_cents: p.dossier.budget_cents, preparation_reserved_cents: p.reserved_budget_cents,
        reservation_basis: "LOCAL_PREPARATION_EARMARK_NOT_V5_RESERVATION_OR_BANK_HOLD", estimated_cost_cents: p.candidate.estimated_cost_cents,
        human_documented_quote_cents: p.commercial_review?.confirmed_quote_cents ?? null, declared_expense_cents: total("expense"), evidence_confirmed_expense_cents: null,
        bank_verified_expense_cents: null, estimated_revenue_cents: p.dossier.estimated_revenue_cents, declared_revenue_cents: total("revenue"), confirmed_revenue_cents: null,
        post_experiment_declared_revenue_cents: total("revenue", "post_experiment"), experimental_result: null, lifetime_economic_result: null },
      experimental_period: { started_at: null, deadline: null, result: null }, action_authorized: false, automatic_execution_available: false };
  });
  return { version: "12.7", mode: "PREPARATION_ONLY", reference_capital_cents: 10000, capital_is_bank_balance: false, real_money_spent_by_v12_7_cents: 0,
    total_preparation_reserved_cents: projects.reduce((sum, p) => sum + p.reserved_budget_cents, 0), projects, events: state.events,
    notice: "NO_REAL_PILOT_STARTED; APPROVAL_IS_NOT_EXECUTION_OR_PAYMENT_PROOF; HUMAN_DECLARATIONS_ARE_UNVERIFIED" };
}
export async function runPilotPreparation(options: { root?: string; command: PreparationCommand; now?: () => string }) {
  if (process.env.SCOUT_MODE !== "pilot-preparation") throw new Error("Explicit SCOUT_MODE=pilot-preparation required");
  validateCommand(options.command);
  const root = options.root ?? scoutWorkspaceRoot();
  if (!path.isAbsolute(root) || root !== path.normalize(root) || root.split(path.sep).some(p => p === "." || p === "..") || root === path.parse(root).root) throw new Error("Normalized absolute preparation workspace required");
  return locked(root, async () => {
    const loaded = await loadPreparation(root), command = options.command, now = time((options.now ?? (() => new Date().toISOString()))());
    if (loaded.state && now < loaded.state.updated_at) throw new Error("Preparation clock rollback");
    const raw = await readConfined(root, "pilot-preparation-input.json", 128 * 1024);
    if (!raw) throw new Error("Explicit pilot-preparation-input.json required");
    const input = parsePreparationInput(raw), sources = await readAllocationSources(root, input.source);
    const researchRaw = input.source === "research.json" ? await readConfined(root, input.source, 128 * 1024) : undefined;
    const accountCandidates = new Set<string>(researchRaw ? JSON.parse(researchRaw).opportunities.filter((o: { account_required: boolean }) => o.account_required).map((o: { opportunity_id: string }) => o.opportunity_id) : []);
    if (now < sourceTime(sources.financial)) throw new Error("Clock predates canonical sources");
    if (loaded.state) { verifyPrefixes(loaded.state, sources); if (loaded.state.input_hash !== canonicalHash(raw) || loaded.state.source_file !== input.source) throw new Error("Preparation input changed; human inspection required"); }
    const state: PreparationState = loaded.state ? structuredClone(loaded.state) : { version: "12.7", mode: "PREPARATION_ONLY", workspace: root, updated_at: now,
      input_hash: canonicalHash(raw), source_file: input.source, source_hash: sources.input_hash, ...pins(sources), projects: [], events: [] };
    if (!loaded.state && command.kind !== "prepare") throw new Error("Prepare the batch explicitly first");
    const missing = await verifyProofs(root, input.dossiers);
    if (!loaded.state) {
      const allocation = calculateAllocation(sources, now);
      for (const candidate of [...sources.candidates].sort((a, b) => b.score - a.score || a.opportunity_id.localeCompare(b.opportunity_id, "en"))) {
        const dossier = input.dossiers.find(d => d.opportunity_id === candidate.opportunity_id);
        if (!dossier) continue;
        [candidate.title, ...candidate.risk_notes, ...candidate.uncertainties].forEach(rejectSensitive);
        if (dossier.candidate_fingerprint !== candidate.fingerprint) throw new Error("Exact candidate fingerprint required");
        if (dossier.review_expires_at <= now || Date.parse(dossier.review_expires_at) - Date.parse(now) > 7 * 86400000) throw new Error("Review expiry must be in the next seven days");
        const rejection = allocation.rejected_candidates.find(c => c.opportunity_id === candidate.opportunity_id)?.reason;
        const reason = accountCandidates.has(candidate.opportunity_id) ? "BLOCKED" : candidate.estimated_cost_cents === null ? "MISSING_EVIDENCE" : candidate.estimated_cost_cents > dossier.budget_cents ? "SPENDING_CEILING_EXCEEDED" : !allocation.selected_projects.some(p => p.opportunity_id === candidate.opportunity_id && p.project_id === null) ? rejection === "INSUFFICIENT_CONFIRMED_CAPITAL" ? "INSUFFICIENT_BUDGET" : rejection?.includes("BUDGET") || rejection?.includes("EXPOSURE") ? "SPENDING_CEILING_EXCEEDED" : "BLOCKED" : null;
        if (reason) { addPreparationEvent(state, reason, candidate.opportunity_id, now); continue; }
        const project = createPreparedProject(dossier, candidate, now);
        try { assertPreparationCapacity(sources, [...state.projects, project]); }
        catch (e) { const code = (e as Error).message; addPreparationEvent(state, code === "INSUFFICIENT_BUDGET" ? code : code === "SPENDING_CEILING_EXCEEDED" ? code : "BLOCKED", candidate.opportunity_id, now); continue; }
        state.projects.push(project);
        addPreparationEvent(state, "OPPORTUNITY_READY_FOR_REVIEW", project.project_id, now);
        for (const request of project.requests) addPreparationEvent(state, "APPROVAL_REQUIRED", request.request_id, now);
      }
      if (input.dossiers.some(d => !sources.candidates.some(c => c.opportunity_id === d.opportunity_id))) throw new Error("Unknown dossier candidate");
    }
    assertPreparationCapacity(sources, state.projects);
    if (command.kind === "review" || command.kind === "approve" || command.kind === "deny" || command.kind === "declare") {
      const project = state.projects.find(p => p.project_id === command.project_id);
      if (!project) throw new Error("Exact prepared project required");
      if (command.kind !== "declare" && (now >= project.dossier.review_expires_at || missing.some(m => m.startsWith(project.dossier.opportunity_id + ":")))) throw new Error("Expired approval or missing evidence");
      if (command.kind === "review") {
        if (project.dossier.fictional || project.dossier_hash !== command.dossier_hash || !project.dossier.proofs.some(p => p.proof_id === command.cost_proof_id && p.purpose === "cost") || !project.dossier.proofs.some(p => p.purpose === "market") || command.quote_cents > project.dossier.budget_cents) throw new Error("Commercial review requires exact scope and cost/market evidence");
        if (project.commercial_review) throw new Error("Commercial review already recorded");
        project.commercial_review = { reviewed_at: now, cost_proof_id: command.cost_proof_id, confirmed_quote_cents: command.quote_cents, scope_hash: project.dossier_hash, human_reference: `local-cli:v12.7:review:${project.project_id}` };
      } else if (command.kind === "approve" || command.kind === "deny") {
        const request = project.requests.find(r => r.request_id === command.request_id && r.action_id === command.action_id && r.fingerprint === command.fingerprint);
        if (!request || request.status !== "pending" || request.project_id !== project.project_id || request.dossier_hash !== project.dossier_hash) throw new Error("Wrong, denied or consumed approval scope");
        request.status = command.kind === "approve" ? "approved" : "denied"; request.decided_at = now; request.human_reference = `local-cli:v12.7:${request.status}:${request.request_id}`;
      } else if (command.kind === "declare") {
        if (project.declarations.length >= 100 || state.projects.some(p => p.declarations.some(d => d.declaration_id === command.declaration_id)) || command.proof_id !== null && !project.dossier.proofs.some(p => p.proof_id === command.proof_id) || command.economic_kind === "expense" && command.phase !== "experiment") throw new Error("Invalid/duplicate declaration");
        if (command.economic_kind === "expense" && project.declarations.filter(d => d.kind === "expense").reduce((sum, d) => sum + d.amount_cents, command.amount_cents) > project.reserved_budget_cents) throw new Error("SPENDING_CEILING_EXCEEDED");
        project.declarations.push({ declaration_id: command.declaration_id, kind: command.economic_kind, amount_cents: command.amount_cents, recorded_at: now, phase: command.phase, proof_id: command.proof_id, verification: "UNVERIFIED_HUMAN_DECLARATION" });
        addPreparationEvent(state, "ECONOMIC_RESULT_REVIEW_REQUIRED", command.declaration_id, now);
      }
    }
    for (const project of state.projects) {
      const blockers = preparationBlockers(project, now);
      if (missing.some(m => m.startsWith(project.dossier.opportunity_id + ":")) || blockers.includes("MISSING_EVIDENCE")) addPreparationEvent(state, "MISSING_EVIDENCE", project.project_id, now);
      if (blockers.includes("APPROVAL_EXPIRED")) addPreparationEvent(state, "BLOCKED", project.project_id, now);
      if (!blockers.length && !missing.some(m => m.startsWith(project.dossier.opportunity_id + ":"))) addPreparationEvent(state, "READY_FOR_MANUAL_LAUNCH", project.project_id, now);
    }
    // Only genuine historical V9 timestamps/results can produce these events.
    // A preparation expiry never masquerades as an experiment completion.
    for (const project of sources.financial.model.projects) {
      if (project.started_at && project.experiment_deadline && now >= project.experiment_deadline) addPreparationEvent(state, "EXPERIMENT_PERIOD_ENDED", project.plan.project_id, now);
      if (project.result) addPreparationEvent(state, "ECONOMIC_RESULT_REVIEW_REQUIRED", project.plan.project_id, now);
    }
    // No write on an unchanged repeat: restart cannot duplicate the earmark.
    const { updated_at: _old, ...previous } = loaded.state ?? {};
    const { updated_at: _new, ...next } = state;
    if (!loaded.state || !same(previous, next)) {
      state.updated_at = now; Object.assign(state, pins(sources));
      if (!same(await readAllocationSources(root, input.source), sources) || await readConfined(root, "pilot-preparation-input.json", 128 * 1024) !== raw || !same(await verifyProofs(root, input.dossiers), missing)) throw new Error("Sources changed before preparation commit");
      await savePreparation(root, state, loaded.key);
    }
    return projection(state, now, missing);
  }, "preparation");
}
/** V12.5 caller already holds V5 lock. Read only, no decisions or projections
 * containing arbitrary operator text are exported through HTTP. */
export async function preparationControlView(root: string) {
  const loaded = await loadPreparation(root); if (!loaded.state) return null;
  const state = loaded.state, raw = await readConfined(root, "pilot-preparation-input.json", 128 * 1024);
  if (!raw || canonicalHash(raw) !== state.input_hash) throw new Error("Preparation input changed");
  const input = parsePreparationInput(raw), sources = await readAllocationSources(root, state.source_file);
  verifyPrefixes(state, sources); assertPreparationCapacity(sources, state.projects);
  const missing = await verifyProofs(root, input.dossiers), now = new Date().toISOString();
  if (now < state.updated_at) throw new Error("Preparation clock rollback");
  const view = projection(state, now, missing);
  return { version: "12.7", mode: "PREPARATION_ONLY", total_reserved_cents: view.total_preparation_reserved_cents,
    projects: view.projects.map(p => ({ project_id: p.project_id, dossier_hash: p.dossier_hash, readiness: p.readiness, blockers: p.blockers,
      budget_cents: p.dossier.budget_cents, duration_days: p.dossier.duration_days, expires_at: p.dossier.review_expires_at,
      approvals: p.requests.map(r => ({ request_id: r.request_id, action_id: r.action_id, fingerprint: r.fingerprint, status: r.status, expires_at: r.expires_at, max_amount_cents: r.max_amount_cents })),
      confirmed_expense_cents: null, confirmed_revenue_cents: null, can_execute: false })), events: state.events };
}
export async function runPreparationCli(args: string[]) {
  try {
    const result = await runPilotPreparation({ command: parsePreparationCommand(args) });
    console.log(JSON.stringify(args[0] === "--events" ? result.events : result, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const event_type = message.includes("SPENDING_CEILING_EXCEEDED") ? "SPENDING_CEILING_EXCEEDED" : message.includes("INSUFFICIENT_BUDGET") ? "INSUFFICIENT_BUDGET" : "BLOCKED";
    // Arbitrary source/OS errors can contain paths or secrets. Only fixed codes.
    console.error(JSON.stringify({ version: "12.7", event_type, status: "BLOCKED", action_authorized: false, money_moved: false, reason: message === "SENSITIVE_INPUT_REJECTED" ? message : "LOCAL_OPERATOR_INSPECTION_REQUIRED" })); process.exitCode = 1;
  }
}
