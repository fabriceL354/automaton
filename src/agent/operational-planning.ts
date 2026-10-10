/** V13 trusted local planning host. Writes only authenticated proposals/audit;
 * exact approvals are checked but never consumed or dispatched. */
import { locked } from "./ledger-runner.js";
import { scoutWorkspaceRoot } from "./local-tools.js";
import { canonicalHash, exact, same, time } from "./project-model.js";
import { reference } from "./pilot-preparation-model.js";
import { readPreparationSnapshot } from "./pilot-preparation.js";
import { savePreparation } from "./pilot-preparation-store.js";
import { buildHandoverPlan, validateCheckScope, type CheckScope } from "./pilot-readiness-model.js";
import { assertPilotNotStopped, haltPilot, normalizedPilotRoot, pilotStopView, STOP_REASONS, type StopReason } from "./pilot-stop.js";
import { appendPlanningEvent, buildOperationalPlan, PLANNING_LIMITS, type OperationalPlan, type PlanningResult } from "./operational-planning-model.js";

export type PlanningCommand = { kind: "plan" | "report" | "report-markdown" | "events" | "stop-status" } |
  { kind: "halt"; reason: StopReason } | { kind: "check-action"; plan_id: string; scope: CheckScope };
export function parsePlanningCommand(args: string[]): PlanningCommand {
  if (args.length === 1 && ["--plan", "--report", "--report-markdown", "--events", "--stop-status"].includes(args[0])) return { kind: args[0].slice(2) as "plan" };
  if (args.length === 2 && args[0] === "--halt" && STOP_REASONS.includes(args[1] as StopReason)) return { kind: "halt", reason: args[1] as StopReason };
  if (args.length === 7 && args[0] === "--check-action") return { kind: "check-action", plan_id: reference(args[1]), scope: validateCheckScope({ project_id: args[2], dossier_hash: args[3], action_id: args[4], request_id: args[5], fingerprint: args[6] }) };
  throw new Error("PLANNING_COMMAND_FORBIDDEN");
}
function validateCommand(c: PlanningCommand) {
  exact(c, c.kind === "halt" ? ["kind", "reason"] : c.kind === "check-action" ? ["kind", "plan_id", "scope"] : ["kind"]);
  const args = c.kind === "halt" ? ["--halt", c.reason] : c.kind === "check-action" ? ["--check-action", c.plan_id, c.scope.project_id, c.scope.dossier_hash, c.scope.action_id, c.scope.request_id, c.scope.fingerprint] : [`--${c.kind}`];
  if (!same(c, parsePlanningCommand(args))) throw new Error("PLANNING_COMMAND_FORBIDDEN");
}
type Snapshot = Awaited<ReturnType<typeof readPreparationSnapshot>>;
function currentPlan(s: Snapshot): OperationalPlan {
  if (!s.state.supervision) throw new Error("V12_8_HANDOVER_REQUIRED");
  const handover = buildHandoverPlan(s.sources, s.state.projects);
  if (s.state.supervision.plan_hash !== canonicalHash(handover)) throw new Error("HANDOVER_SOURCE_CHANGED");
  if (handover.capacity_blockers.length) throw new Error("HANDOVER_CAPACITY_BLOCKED");
  if (!s.state.projects.length) throw new Error("NO_PREPARED_PROJECTS");
  const { planning: _planning, updated_at: _at, ...sourceState } = s.state;
  return buildOperationalPlan({ preparation_state_hash: canonicalHash(sourceState),
    allocation_sources_hash: canonicalHash({ sources: s.sources, missing: s.missing }),
    input_hash: s.state.input_hash, handover_plan_hash: s.state.supervision.plan_hash }, s.state.projects);
}
function checkResult(s: Snapshot, plan: OperationalPlan, plan_id: string, scope: CheckScope, now: string): PlanningResult {
  const stored = s.state.planning?.plans.find(r => r.plan.plan_id === plan_id);
  if (!stored) return "SCOPE_MISMATCH";
  const p = s.view.projects.find(p => p.project_id === scope.project_id);
  const r = p?.requests.find(r => r.request_id === scope.request_id && r.action_id === scope.action_id && r.fingerprint === scope.fingerprint);
  if (!p || !r || p.dossier_hash !== scope.dossier_hash || r.dossier_hash !== scope.dossier_hash) return "SCOPE_MISMATCH";
  if (now >= r.expires_at || now >= p.dossier.review_expires_at) return "APPROVAL_EXPIRED";
  if (stored.plan.plan_hash !== plan.plan_hash) return "PLAN_SOURCE_CHANGED";
  if (r.status !== "approved") return "APPROVAL_REQUIRED";
  if (p.blockers.some(b => b !== "ATOMIC_HANDOVER_NOT_IMPLEMENTED")) return "DOSSIER_BLOCKED";
  const proposal = plan.projects.find(v => v.input.project_id === p.project_id)!;
  if (proposal.economics.scenarios.some(v => v.exceeds_budget)) return "DOSSIER_BLOCKED";
  return "EXACT_AUTHORIZATION_CURRENT_NO_EXECUTION";
}
function decisionReport(s: Snapshot, plan: OperationalPlan, stop: Awaited<ReturnType<typeof pilotStopView>>, at: string) {
  const record = s.state.planning?.plans.find(r => r.plan.plan_id === plan.plan_id);
  return { version: "13", generated_at: at, mode: "SUPERVISED_OPERATIONAL_PLANNING_ONLY", plan,
    plan_recorded: !!record, created_at: record?.created_at ?? null, emergency_stop: stop,
    verification_trace: ["V12_7_HMAC_AND_WORKSPACE_VERIFIED", "INPUT_AND_SOURCE_PROVENANCE_VERIFIED", "HISTORY_PREFIXES_VERIFIED", "CURATED_PROOF_HASHES_CHECKED", "V12_8_HANDOVER_HASH_VERIFIED", "HISTORICAL_EXPOSURE_AND_CAPACITY_CHECKED", "CLOCK_ROLLBACK_CHECKED", "EXPIRATION_AND_EXACT_DECISION_SCOPES_CHECKED", "EMERGENCY_STOP_CHECKED"],
    decision_dossiers: s.view.projects.map(p => ({ project_id: p.project_id, dossier_hash: p.dossier_hash,
      authorization_status: p.human_authorization, exact_authorizations: p.requests,
      blockers: [...new Set([...p.blockers, ...(!record ? ["PLAN_NOT_RECORDED"] : []), ...(stop.stopped ? ["EMERGENCY_STOP"] : []),
        ...(plan.projects.find(v => v.input.project_id === p.project_id)!.economics.scenarios.some(v => v.exceeds_budget) ? ["SCENARIO_COST_EXCEEDS_BUDGET"] : []), "ATOMIC_HANDOVER_NOT_IMPLEMENTED", "V13_EXECUTION_NOT_IMPLEMENTED"])],
      declarations: p.declarations, verified_expense_cents: null, confirmed_revenue_cents: null,
      decision_required: "HUMAN_REVIEW_OF_PROPOSED_EXPERIMENT_ONLY", execution_allowed: false, manual_launch_status: "NOT_RECORDED" })),
    audit: s.state.planning?.events ?? [], archived_plan_ids: s.state.planning?.plans.map(r => r.plan.plan_id) ?? [],
    execution_allowed: false, financial_transfer_performed: false, money_moved_cents: 0,
    notice: "SIMULATIONS_ARE_HYPOTHESES; REVENUE_IS_NOT_ACQUIRED; APPROVAL_IS_NOT_EXECUTION; NO_REAL_PILOT_STARTED" };
}
export type PlanningReport = ReturnType<typeof decisionReport>;
export async function runOperationalPlanning(options: { root?: string; command: PlanningCommand; now?: () => string }): Promise<PlanningReport> {
  if (process.env.SCOUT_MODE !== "operational-planning") throw new Error("Explicit SCOUT_MODE=operational-planning required");
  validateCommand(options.command);
  const root = normalizedPilotRoot(options.root ?? scoutWorkspaceRoot()), c = options.command;
  if (c.kind === "halt" || c.kind === "stop-status") throw new Error("Use stopOperationalPlanning for independent stop commands");
  const readOnly = ["report", "report-markdown", "events"].includes(c.kind);
  return locked(root, async () => {
    const now = time((options.now ?? (() => new Date().toISOString()))()), stop = await pilotStopView(root);
    const initial = await readPreparationSnapshot(root, now, stop.stopped), s = structuredClone(initial), plan = currentPlan(s);
    let changed = false, result: PlanningResult | undefined;
    if (c.kind === "plan") {
      if (s.state.projects.some(p => now >= p.dossier.review_expires_at)) throw new Error("APPROVAL_EXPIRED");
      if (s.missing.length) throw new Error("MISSING_EVIDENCE");
      s.state.planning ??= { version: "13", plans: [], events: [] };
      if (!s.state.planning.plans.some(r => r.plan.plan_id === plan.plan_id)) {
        if (s.state.planning.plans.length >= PLANNING_LIMITS.MAX_PLANS) throw new Error("Planning history full; human inspection required");
        s.state.planning.plans.push({ created_at: now, plan });
        changed = appendPlanningEvent(s.state.planning, now, plan.plan_id, null, "PLAN_RECORDED_NO_EXECUTION");
      }
    } else if (c.kind === "check-action") {
      if (!s.state.planning) throw new Error("PLAN_NOT_RECORDED");
      result = checkResult(s, plan, c.plan_id, c.scope, now);
      changed = appendPlanningEvent(s.state.planning, now, c.plan_id, c.scope, result);
    } else if (s.state.planning && !s.state.planning.plans.some(r => r.plan.plan_id === plan.plan_id)) {
      throw new Error("PLAN_SOURCE_CHANGED");
    }
    if (changed) {
      const current = await readPreparationSnapshot(root, now);
      if (!same(current.state, initial.state) || !same(current.sources, initial.sources) || !same(current.missing, initial.missing)) throw new Error("PLANNING_SOURCES_CHANGED_BEFORE_COMMIT");
      await assertPilotNotStopped(root);
      s.state.updated_at = now;
      await savePreparation(root, s.state, initial.key);
      await assertPilotNotStopped(root);
    }
    if (!readOnly) await assertPilotNotStopped(root);
    if (result && result !== "EXACT_AUTHORIZATION_CURRENT_NO_EXECUTION") throw new Error(result);
    return decisionReport(s, plan, await pilotStopView(root), now);
  }, readOnly ? "planning-read" : "planning");
}
export async function stopOperationalPlanning(options: { root?: string; command: PlanningCommand; now?: () => string }) {
  if (process.env.SCOUT_MODE !== "operational-planning") throw new Error("Explicit SCOUT_MODE=operational-planning required");
  validateCommand(options.command);
  const root = normalizedPilotRoot(options.root ?? scoutWorkspaceRoot());
  if (options.command.kind === "stop-status") return pilotStopView(root);
  if (options.command.kind !== "halt") throw new Error("Exact halt command required");
  return haltPilot(root, options.command.reason, time((options.now ?? (() => new Date().toISOString()))()));
}
const md = (v: unknown) => String(v).replace(/[\\`*_{}\[\]()#+.!|<>~-]/g, "\\$&");
export function renderPlanningReport(r: PlanningReport): string {
  const lines = ["# Scout V13 — Dossier de décision supervisée", "", `Plan : ${r.plan.plan_id}. État au ${r.generated_at}.`, "",
    "**Plan non exécutable. Aucun paiement, achat, transfert, compte, publication ni lancement.**", "",
    "Les revenus sont des hypothèses, jamais acquis ni ajoutés aux fonds disponibles. Autorisation ≠ exécution. Les déclarations et devis ne sont pas des preuves bancaires.", "",
    `Arrêt d'urgence : ${r.emergency_stop.stopped ? "ACTIF — terminal" : "non déclenché"}. Plan enregistré : ${r.plan_recorded ? "oui" : "non"}.`, ""];
  for (const p of r.plan.projects) {
    const d = r.decision_dossiers.find(d => d.project_id === p.input.project_id)!;
    lines.push(`## ${md(p.offer)}`, "", `Projet ${md(p.input.project_id)} ; dossier ${p.input.dossier_hash}. Public : ${md(p.target_customers)}.`, "",
      `Durée proposée : ${p.planned_duration_days} jours. Aucune date de début ou échéance réelle.`, "",
      "| Scénario | Coût estimé (centimes) | Revenu hypothétique | Résultat prévisionnel |", "|---|---:|---:|---:|",
      ...p.economics.scenarios.map(s => `| ${s.name} | ${s.estimated_cost_cents ?? "inconnu"} | ${s.hypothetical_revenue_cents ?? "inconnu"} | ${s.projected_result_cents ?? "inconnu"} |`), "",
      `Base de coût : ${p.economics.cost_basis}. Hypothèses de sensibilité fixes : coût pessimiste au moins égal au plafond ; revenu pessimiste zéro ; coût optimiste 80 %, revenu optimiste 150 %, arrondis au centime inférieur. Une donnée inconnue reste inconnue.`, "",
      "Actions proposées, toutes non exécutables :", "",
      ...p.actions.map(a => `- ${md(a.action_id)} : ${md(a.description)}. Dépendances : ${a.depends_on.map(md).join(", ") || "aucune"}. Maximum : ${a.max_amount_cents} centimes. Critères : ${a.success_criteria.map(md).join(" ; ")}. Risques : ${a.risks.map(md).join(" ; ")}.`), "",
      "Critères de réussite :", "", ...p.success_criteria.map(v => `- ${md(v)}`), "", "Conditions d'arrêt :", "", ...p.stop_conditions.map(v => `- ${md(v)}`), "",
      "Autorisations exactes à examiner, jamais consommées :", "",
      ...d.exact_authorizations.map(a => `- ${md(a.action_id)} ; ${a.request_id} ; empreinte ${a.fingerprint} ; ${a.status} ; échéance ${a.expires_at}. Décision ${a.decided_at ?? "aucune"} ; référence ${md(a.human_reference ?? "aucune")}.`), "",
      "Blocages :", "", ...d.blockers.map(v => `- ${md(v)}`), "");
  }
  lines.push("## Vérifications et audit", "", ...r.verification_trace.map(v => `- ${v}`), "",
    `Événements authentifiés : ${r.audit.length}. Le rapport exporté est informatif ; seules les données locales authentifiées sont vérifiables.`, "");
  return lines.join("\n");
}
export async function runPlanningCli(args: string[]) {
  try {
    const command = parsePlanningCommand(args);
    if (command.kind === "halt" || command.kind === "stop-status") { console.log(JSON.stringify(await stopOperationalPlanning({ command }), null, 2)); return; }
    const r = await runOperationalPlanning({ command });
    console.log(command.kind === "report-markdown" ? renderPlanningReport(r) : JSON.stringify(command.kind === "events" ? r.audit : r, null, 2));
  } catch {
    console.error(JSON.stringify({ version: "13", status: "BLOCKED", execution_allowed: false, money_moved_cents: 0, reason: "LOCAL_OPERATOR_INSPECTION_REQUIRED" })); process.exitCode = 1;
  }
}
