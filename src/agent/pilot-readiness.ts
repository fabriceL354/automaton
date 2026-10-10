/** V12.8 trusted local operator host. Checks and reports cannot dispatch work,
 * consume permissions, transfer reservations, or confirm any bank movement. */
import { locked } from "./ledger-runner.js";
import { scoutWorkspaceRoot } from "./local-tools.js";
import { canonicalHash, exact, same, time } from "./project-model.js";
import { readPreparationSnapshot } from "./pilot-preparation.js";
import { savePreparation } from "./pilot-preparation-store.js";
import { appendReadinessEvent, buildHandoverPlan, validateCheckScope, type CheckResult, type CheckScope } from "./pilot-readiness-model.js";
import { assertPilotNotStopped, haltPilot, normalizedPilotRoot, pilotStopView, STOP_REASONS, type StopReason } from "./pilot-stop.js";
export type ReadinessCommand = { kind: "prepare-handover" | "report" | "report-markdown" | "events" | "stop-status" } |
  { kind: "halt"; reason: StopReason } | { kind: "check-action"; scope: CheckScope };
export function parseReadinessCommand(args: string[]): ReadinessCommand {
  if (args.length === 1 && ["--prepare-handover", "--report", "--report-markdown", "--events", "--stop-status"].includes(args[0])) return { kind: args[0].slice(2) as "report" };
  if (args.length === 2 && args[0] === "--halt" && STOP_REASONS.includes(args[1] as StopReason)) return { kind: "halt", reason: args[1] as StopReason };
  if (args.length === 6 && args[0] === "--check-action") return { kind: "check-action", scope: validateCheckScope({ project_id: args[1], dossier_hash: args[2], action_id: args[3], request_id: args[4], fingerprint: args[5] }) };
  throw new Error("READINESS_COMMAND_FORBIDDEN");
}
function validateCommand(c: ReadinessCommand) {
  exact(c, c.kind === "halt" ? ["kind", "reason"] : c.kind === "check-action" ? ["kind", "scope"] : ["kind"]);
  const args = c.kind === "halt" ? ["--halt", c.reason] : c.kind === "check-action" ? ["--check-action", c.scope.project_id, c.scope.dossier_hash, c.scope.action_id, c.scope.request_id, c.scope.fingerprint] : [`--${c.kind}`];
  if (!same(c, parseReadinessCommand(args))) throw new Error("READINESS_COMMAND_FORBIDDEN");
}
type Snapshot = Awaited<ReturnType<typeof readPreparationSnapshot>>;
function checkResult(s: Snapshot, scope: CheckScope, now: string): CheckResult {
  const p = s.view.projects.find(p => p.project_id === scope.project_id);
  const r = p?.requests.find(r => r.request_id === scope.request_id && r.action_id === scope.action_id && r.fingerprint === scope.fingerprint);
  if (!p || !r || p.dossier_hash !== scope.dossier_hash || r.dossier_hash !== scope.dossier_hash) return "SCOPE_MISMATCH";
  if (now >= r.expires_at || now >= p.dossier.review_expires_at) return "APPROVAL_EXPIRED";
  if (r.status !== "approved") return "APPROVAL_REQUIRED";
  if (p.blockers.some(b => b !== "ATOMIC_HANDOVER_NOT_IMPLEMENTED")) return "DOSSIER_BLOCKED";
  if (buildHandoverPlan(s.sources, s.state.projects).capacity_blockers.length) return "HANDOVER_CAPACITY_BLOCKED";
  return "EXACT_AUTHORIZATION_CURRENT_NO_EXECUTION";
}
function report(s: Snapshot, stop: Awaited<ReturnType<typeof pilotStopView>>, at: string) {
  const handover = buildHandoverPlan(s.sources, s.state.projects);
  if (s.state.supervision && s.state.supervision.plan_hash !== canonicalHash(handover)) throw new Error("Handover source changed; human inspection required");
  return { version: "12.8", generated_at: at, mode: "SUPERVISED_READINESS_ONLY", emergency_stop: stop,
    handover_prepared: !!s.state.supervision, handover, audit: s.state.supervision?.events ?? [],
    projects: s.view.projects.map(p => {
      const blockers = [...new Set([...p.blockers, ...handover.capacity_blockers,
        ...(!s.state.supervision ? ["HANDOVER_NOT_PREPARED"] : []), ...(stop.stopped ? ["EMERGENCY_STOP"] : []), "ATOMIC_HANDOVER_NOT_IMPLEMENTED"])];
      const sum = (kind: string, phase: string) => p.declarations.filter(d => d.kind === kind && d.phase === phase).reduce((n, d) => n + d.amount_cents, 0);
      return { project_id: p.project_id, dossier_hash: p.dossier_hash, opportunity: p.candidate.title, offer: p.dossier.offer,
        dossier: p.dossier, technical_readiness: "DOSSIER_INTEGRITY_VERIFIED_HANDOVER_BLOCKED",
        commercially_documented: p.commercial_review !== null && !p.blockers.includes("MISSING_EVIDENCE"), commercial_review: p.commercial_review,
        authorization_status: p.human_authorization, manual_launch_status: "NOT_RECORDED", ready_for_real_launch: false,
        exact_authorizations: p.requests, remaining_manual_actions: p.requests.map(r => ({ ...r, execution_status: "NOT_RECORDED", perform_now: false })),
        stop_conditions: p.dossier.stop_conditions, blockers,
        economics: { ...p.economics, budget_assigned_cents: p.reserved_budget_cents,
          expense_really_verified_cents: null, revenue_really_confirmed_cents: null,
          experiment_declared_expense_cents: sum("expense", "experiment"), experiment_declared_revenue_cents: sum("revenue", "experiment"),
          post_experiment_declared_revenue_cents: sum("revenue", "post_experiment"), declarations: p.declarations },
        experiment: { planned_duration_days: p.dossier.duration_days, started_at: null, deadline: null, actual_result: null },
        asset_after_experiment: { tracking_is_separate: true, income_end_date: null, confirmed_revenue_cents: null },
      };
    }), execution_allowed: false, financial_transfer_performed: false, real_money_spent_by_v12_8_cents: 0,
    notice: "NO_PILOT_STARTED_BY_SCOUT; NO_MANUAL_LAUNCH_RECORDED; AUTHORIZATION_IS_NOT_EXECUTION; DECLARATIONS_AND_ARCHIVES_ARE_NOT_BANK_PROOF" };
}
export type ReadinessReport = ReturnType<typeof report>;
/** Escape arbitrary operator text in Markdown; report is descriptive, never commands. */
const md = (v: unknown) => String(v).replace(/[\\`*_{}\[\]()#+.!|<>~-]/g, "\\$&");
export function renderReadinessReport(r: ReadinessReport): string {
  const lines = ["# Scout V12.8 — Rapport de préparation supervisée", "", `État au ${r.generated_at}.`, "",
    "**Aucun pilote démarré par Scout. Aucun lancement manuel enregistré. Aucun transfert, paiement, achat, compte ou publication.**", "",
    `Arrêt d'urgence : **${r.emergency_stop.stopped ? "ACTIF — terminal" : "non déclenché"}**. Plan de transfert : **non exécutable**.`, "",
    "Les 100 € sont une référence simulée, jamais un solde bancaire. Autorisation ≠ exécution. Archive et déclaration ≠ preuve bancaire.", "",
    "## Transition V12.7 → V5/V9", "", "| Affectation / historique | Centimes |", "|---|---:|",
    `| Affectations V12.7 (conservées) | ${r.handover.current_preparation_earmarked_cents} |`,
    `| Réservations V5 historiques | ${r.handover.historical_v5_reserved_cents} |`,
    `| Dépenses historiques enregistrées (qualification V5/V9, pas bancaire) | ${r.handover.historical_recorded_expense_cents} |`,
    `| Projets V9 planifiés non réservés | ${r.handover.historical_v9_unreserved_planned_cents} |`,
    `| Exposition comptable totale | ${r.handover.current_total_exposure_cents} |`, "",
    `Projets historiques distincts : ${r.handover.historical_project_count}. Limites : 2 projets, 1 000 centimes/projet, 2 000 centimes au total.`, "",
    "Le futur transfert doit reclasser l'affectation existante, jamais la compter deux fois. Les identités V5/V9 restent non attribuées. L'atomicité entre les historiques n'est pas implémentée ; les writers restent verrouillés.", ""];
  for (const p of r.projects) {
    lines.push(`## ${md(p.opportunity)}`, "", `Projet : ${md(p.project_id)}. Dossier : ${p.dossier_hash}.`, "",
      `Offre : ${md(p.offer)}. Public : ${md(p.dossier.target_customers)}.`, "",
      `Technique : intégrité vérifiée, transfert bloqué. Commercial : ${p.commercially_documented ? "revue humaine documentée" : "à documenter / vérifier"}. Autorisations : ${md(p.authorization_status)}.`, "",
      "**Lancement réel : bloqué.**", "", "| Indicateur | Centimes / état |", "|---|---|",
      `| Budget prévu | ${p.economics.planned_budget_cents} |`, `| Budget affecté V12.7 | ${p.economics.budget_assigned_cents} |`,
      `| Coût estimé | ${p.economics.estimated_cost_cents ?? "inconnu"} |`, `| Devis examiné humainement | ${p.economics.human_documented_quote_cents ?? "non examiné"} |`,
      `| Dépense déclarée | ${p.economics.declared_expense_cents} |`, "| Dépense réellement vérifiée | inconnue — non implémenté |",
      `| Revenu estimé | ${p.economics.estimated_revenue_cents ?? "inconnu"} |`, `| Revenu déclaré pendant l'expérience | ${p.economics.experiment_declared_revenue_cents} |`,
      `| Revenu déclaré après l'expérience | ${p.economics.post_experiment_declared_revenue_cents} |`, "| Revenu réellement confirmé | inconnu — non implémenté |", "",
      `Expérience prévue : ${p.experiment.planned_duration_days} jours maximum, non démarrée par Scout, aucune échéance réelle calculée. Les revenus ultérieurs d'un actif sont suivis séparément, sans limite fictive à sept jours.`, "",
      "Preuves de coût et commerciales (archives publiques, non bancaires) :", "", ...p.dossier.proofs.map(e => `- ${md(e.proof_id)} — ${e.purpose} — ${md(e.file)} — SHA-256 ${e.sha256}.`), "",
      "Risques et incertitudes :", "", ...[...p.dossier.operational_risks, ...p.dossier.commercial_uncertainties].map(v => `- ${md(v)}`), "",
      "Actions manuelles restantes — à examiner seulement, ne pas exécuter dans cette version :", "");
    for (const a of p.remaining_manual_actions) lines.push(`- ${md(a.action_id)} : ${md(a.description)} ; ${md(a.kind)} ; maximum ${a.max_amount_cents} centimes.`,
      `  Fournisseur : ${md(a.supplier ?? "sans objet")}. Bénéficiaire : ${md(a.beneficiary ?? "sans objet")}. État : ${a.status} ; échéance ${a.expires_at}.`,
      `  Demande : ${a.request_id} ; empreinte ${a.fingerprint} ; dossier ${a.dossier_hash}.`,
      `  Décision : ${a.decided_at ?? "aucune"} ; référence ${md(a.human_reference ?? "aucune")}. Exécution non enregistrée.`);
    lines.push("", "Conditions d'arrêt :", "", ...p.stop_conditions.map(v => `- ${md(v)}`), "", "Blocages :", "", ...p.blockers.map(v => `- ${md(v)}`), "");
  }
  lines.push("## Historique local", "", `Plan enregistré : ${r.handover_prepared ? "oui" : "non"}. Contrôles V12.8 : ${r.audit.length}. L'historique est authentifié dans l'état V12.7 ; ce rapport exporté n'est pas une autorisation.`, "",
    "L'arrêt est persistant et sans commande de reprise. Un verrou abandonné, une ancre incomplète, une donnée altérée ou une horloge reculée exige une inspection humaine ; aucune réparation automatique.", "");
  return lines.join("\n");
}
export async function runPilotReadiness(options: { root?: string; command: ReadinessCommand; now?: () => string }): Promise<ReadinessReport> {
  if (process.env.SCOUT_MODE !== "pilot-readiness") throw new Error("Explicit SCOUT_MODE=pilot-readiness required");
  validateCommand(options.command);
  const root = normalizedPilotRoot(options.root ?? scoutWorkspaceRoot()), c = options.command;
  if (c.kind === "halt" || c.kind === "stop-status") throw new Error("Use stopPilotReadiness for lock-independent stop commands");
  const readOnly = ["report", "report-markdown", "events"].includes(c.kind);
  return locked(root, async () => {
    const now = time((options.now ?? (() => new Date().toISOString()))()), stop = await pilotStopView(root);
    const initial = await readPreparationSnapshot(root, now, stop.stopped), s = structuredClone(initial);
    const handover = buildHandoverPlan(s.sources, s.state.projects);
    if (s.state.supervision && s.state.supervision.plan_hash !== canonicalHash(handover)) throw new Error("Handover source changed; human inspection required");
    let changed = false, result: CheckResult | undefined;
    if (c.kind === "prepare-handover" && !s.state.supervision) {
      s.state.supervision = { version: "12.8", prepared_at: now, plan_hash: canonicalHash(handover), events: [] };
      appendReadinessEvent(s.state.supervision, now, null, "HANDOVER_PLANNED_NO_TRANSFER"); changed = true;
    } else if (c.kind === "check-action") {
      if (!s.state.supervision) throw new Error("HANDOVER_NOT_PREPARED");
      result = checkResult(s, c.scope, now);
      appendReadinessEvent(s.state.supervision, now, c.scope, result); changed = true;
    }
    if (changed) {
      const current = await readPreparationSnapshot(root, now);
      if (!same(current.state, initial.state) || !same(current.sources, initial.sources) || !same(current.missing, initial.missing)) throw new Error("Readiness sources changed before commit");
      await assertPilotNotStopped(root);
      s.state.updated_at = now;
      await savePreparation(root, s.state, initial.key);
      await assertPilotNotStopped(root);
    }
    if (result && result !== "EXACT_AUTHORIZATION_CURRENT_NO_EXECUTION") throw new Error(result);
    return report(s, await pilotStopView(root), now);
  }, readOnly ? "readiness-read" : "readiness");
}
export async function stopPilotReadiness(options: { root?: string; command: ReadinessCommand; now?: () => string }) {
  if (process.env.SCOUT_MODE !== "pilot-readiness") throw new Error("Explicit SCOUT_MODE=pilot-readiness required");
  validateCommand(options.command);
  const root = normalizedPilotRoot(options.root ?? scoutWorkspaceRoot());
  if (options.command.kind === "stop-status") return pilotStopView(root);
  if (options.command.kind !== "halt") throw new Error("Exact halt command required");
  return haltPilot(root, options.command.reason, time((options.now ?? (() => new Date().toISOString()))()));
}
export async function runReadinessCli(args: string[]) {
  try {
    const command = parseReadinessCommand(args);
    if (command.kind === "halt" || command.kind === "stop-status") { console.log(JSON.stringify(await stopPilotReadiness({ command }), null, 2)); return; }
    const r = await runPilotReadiness({ command });
    console.log(command.kind === "report-markdown" ? renderReadinessReport(r) : JSON.stringify(command.kind === "events" ? r.audit : r, null, 2));
  } catch {
    console.error(JSON.stringify({ version: "12.8", status: "BLOCKED", execution_allowed: false, money_moved: false, reason: "LOCAL_OPERATOR_INSPECTION_REQUIRED" })); process.exitCode = 1;
  }
}
