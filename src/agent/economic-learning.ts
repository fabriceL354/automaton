/** V11 orchestration: read-only economic analysis + explicitly requested local
 * hypothesis events. No inference, finance writer, scheduler or action executor. */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { scoutWorkspaceRoot } from "./local-tools.js";
import { scoutMode } from "./opportunity-scout.js";
import { locked } from "./ledger-runner.js";
import { exact, same, uuid, structured, canonicalHash } from "./project-model.js";
import { monitoringTime } from "./monitoring-model.js";
import { formatCents } from "./economic-ledger.js";
import { readLearningSources, historicalSources, sourcePin, sourceTime, evaluateHypothesis, buildProjectEvidence, buildLegacyEvidence,
  batchEvidence, compareEvidence, type Sources, type ProjectEvidence } from "./evidence-builder.js";
import { loadLearningState, checkLearningViews, saveLearning } from "./learning-store.js";
import { LEARNING_LIMITS, LEARNING_NOTICE, NO_AUTHORIZATION, validateLearningCommand, validateDefinition, evidenceLevel, boundedReport, strictStatus,
  type LearningCommand, type LearningEvent, type Hypothesis, type EvidenceLink } from "./learning-model.js";
export { parseLearningCommand } from "./learning-model.js";
const merge = (a: EvidenceLink[], b: EvidenceLink[]) => [...new Map([...a, ...b].map(e => [e.evidence_hash, e])).values()];
/** Historical source pins are replayed, never replaced by current summaries. */
export function auditLearning(events: LearningEvent[], sources: Sources): Hypothesis[] {
  if (events.length > LEARNING_LIMITS.MAX_HISTORY_ENTRIES) throw new Error("Learning history event limit");
  const hypotheses = new Map<string, Hypothesis>(), ids = new Set<string>(); let lastTime = "", links = 0;
  let lastCounts = [0, 0, 0, 0]; const cache = new Map<string, Sources>();
  for (const event of events) {
    exact(event, ["version", "event_id", "at", "operation", "definition", "sources", "evaluation"]);
    if (event.version !== 11 || !["create", "refresh", "retire"].includes(event.operation)) throw new Error("Invalid learning event");
    uuid(event.event_id, "learningevent"); monitoringTime(event.at); validateDefinition(event.definition);
    if (ids.has(event.event_id) || event.at < lastTime) throw new Error("Learning duplicate event or clock rollback");
    ids.add(event.event_id); lastTime = event.at;
    const counts = [event.sources.ledger_count, event.sources.project_count, event.sources.observation_count, event.sources.revenue_count];
    if (counts.some((v, i) => v < lastCounts[i])) throw new Error("Learning source history rollback"); lastCounts = counts;
    const key = canonicalHash(event.sources);
    let historical = cache.get(key); if (!historical) { historical = historicalSources(sources, event.sources); cache.set(key, historical); }
    if (event.at < sourceTime(historical)) throw new Error("Learning event predates evidence");
    const expected = evaluateHypothesis(historical, event.definition);
    if (!same(expected, event.evaluation)) throw new Error("Learning evidence does not match authenticated sources");
    links += expected.evidence_for.length + expected.evidence_against.length;
    if (links > LEARNING_LIMITS.MAX_EVIDENCE_LINKS) throw new Error("Learning evidence link limit");
    const d = event.definition, previous = hypotheses.get(d.hypothesis_id);
    if (event.operation === "create") {
      if (previous) throw new Error("Duplicate hypothesis ID");
      if (hypotheses.size >= LEARNING_LIMITS.MAX_HYPOTHESES) throw new Error("Learning hypothesis limit");
    } else {
      if (!previous || previous.status === "retired") throw new Error("Exact non-retired hypothesis required");
      if (!same(d, { hypothesis_id: previous.hypothesis_id, batch_id: previous.batch_id, statement: previous.statement, rule: previous.rule, min_inquiries: previous.min_inquiries })) throw new Error("Hypothesis definition is immutable");
    }
    const evidence_for = merge(previous?.evidence_for ?? [], expected.evidence_for), evidence_against = merge(previous?.evidence_against ?? [], expected.evidence_against);
    const sample_size = new Set([...evidence_for, ...evidence_against].map(e => e.project_id)).size;
    const status = strictStatus(event.operation === "retire" ? "retired" : evidence_for.length && evidence_against.length ? "mixed" : evidence_for.length ? "supported_weakly" : evidence_against.length ? "contradicted_weakly" : "open");
    hypotheses.set(d.hypothesis_id, { ...d, status, evidence_for, evidence_against, sample_size, confidence: evidenceLevel(sample_size),
      created_at: previous?.created_at ?? event.at, updated_at: event.at, current_evaluation: expected });
  }
  return [...hypotheses.values()];
}
function hypothesisView(hypotheses: Hypothesis[], events: LearningEvent[]) { return events.length ? structured({ version: 11, hypotheses, notice: NO_AUTHORIZATION }) : undefined; }
export function learningReport(items: ProjectEvidence[], hypotheses: Hypothesis[]): string {
  const money = (v: number | null) => v === null ? "inconnu" : formatCents(v);
  return boundedReport(["Scout V11 — Economic Learning", LEARNING_NOTICE,
    ...items.flatMap(e => ["", `PROJECT ${e.name} (${e.project_id})`, `Expérience : ${e.experiment_id}`, `Snapshot sources : ${e.as_of}`,
      "FACTS — déclarations humaines authentifiées, pas une vérification bancaire",
      `Dépense confirmée : ${money(e.facts.experiment_expense_cents)}`, `Revenu expérimental confirmé : ${money(e.facts.experiment_revenue_cents)}`,
      `Revenu post-expérience confirmé : ${money(e.facts.post_experiment_revenue_cents)}`, `Clôture : ${e.facts.closed_at ?? "absente"}`,
      "OBSERVATIONS — signaux non financiers",
      `Métriques expérience : ${JSON.stringify(e.observations.experiment_metrics)}`, `Métriques actif : ${JSON.stringify(e.observations.asset_metrics)}`,
      `Claims : ${e.observations.claims.length}, réconciliées : ${e.observations.claims.filter(c => c.reconciliation).length} ; jamais ajoutées aux revenus`,
      `Risques : ${e.observations.risks.length} ; blockers : ${e.observations.blockers.length}`,
      "DERIVED METRICS",
      `Résultat expérimental à la clôture : ${money(e.derived_metrics.experiment_net_cents)} (${e.derived_metrics.experiment_outcome})`,
      `Résultat à la deadline exacte : ${money(e.derived_metrics.deadline_net_cents)}`,
      `Revenu lifetime confirmé : ${money(e.derived_metrics.lifetime_revenue_cents)}`,
      `Résultat lifetime au snapshot : ${money(e.derived_metrics.lifetime_net_cents)} (${e.derived_metrics.lifetime_outcome})`,
      `Délai premier revenu enregistré (ms) : ${e.derived_metrics.time_to_first_confirmed_revenue_ms ?? "inconnu"}`,
      `Score descriptif : ${e.derived_metrics.score.value ?? "inconnu"} ; pas une probabilité`,
      "HYPOTHESES",
      `Hypothèse initiale humaine : ${e.original_hypothesis.statement} ; classification humaine : ${e.original_hypothesis.human_classification ?? "absente"} ; validité non inférée automatiquement`,
      ...hypotheses.filter(h => h.batch_id === e.batch_id).map(h => `${h.hypothesis_id} : ${h.statement} ; ${h.status} ; ${h.confidence} ; ${h.sample_size} projet(s) distinct(s), mémoire au ${h.updated_at}`),
      "RECOMMENDATION — suggestion pour examen humain uniquement",
      `${e.derived_metrics.recommendation.kind} ; autorisation : NON`,
      "CONFIDENCE", `${e.derived_metrics.recommendation.confidence} ; ${e.facts.financial_status === "confirmed_closed" ? 1 : 0} résultat confirmé pour ce projet ; données insuffisantes pour généraliser`,
      `SOURCE REFS : ${JSON.stringify(e.source_refs)}`]), NO_AUTHORIZATION, ""].join("\n"));
}
export async function runLearningScout(options: { root?: string; command: LearningCommand; now?: () => string; onEvent?: (s: string) => void }) {
  if (scoutMode() !== "learning") throw new Error("Learning requires SCOUT_MODE=learning");
  const command = validateLearningCommand(options.command), root = path.resolve(options.root ?? scoutWorkspaceRoot());
  return locked(root, async () => {
    const sources = await readLearningSources(root), loaded = await loadLearningState(root), events = loaded.state?.events ?? [];
    let hypotheses = auditLearning(events, sources);
    const previousView = hypothesisView(hypotheses, events); await checkLearningViews(root, events, previousView);
    let items: ProjectEvidence[] = [], legacy: ReturnType<typeof buildLegacyEvidence> | null = null;
    let comparison: ReturnType<typeof compareEvidence> | null = null, event: LearningEvent | null = null, next = events;
    if (command.kind === "analyze-project" || command.kind === "learning-report") items = [buildProjectEvidence(sources, command.projectId, command.experimentId)];
    else if (command.kind === "analyze-batch") items = batchEvidence(sources, command.batchId);
    else if (command.kind === "analyze-experiment") legacy = buildLegacyEvidence(sources, command.experimentId);
    else if (command.kind === "compare") { items = [buildProjectEvidence(sources, command.projectA), buildProjectEvidence(sources, command.projectB)]; comparison = compareEvidence(items); }
    else if (command.kind === "create-hypothesis" || command.kind === "refresh-hypothesis" || command.kind === "retire-hypothesis") {
      const previous = command.kind === "create-hypothesis" ? undefined : hypotheses.find(h => h.hypothesis_id === command.hypothesisId);
      if (command.kind !== "create-hypothesis" && !previous) throw new Error("Exact existing hypothesis required");
      const definition = command.kind === "create-hypothesis" ? command.definition : {
        hypothesis_id: previous!.hypothesis_id, batch_id: previous!.batch_id, statement: previous!.statement, rule: previous!.rule, min_inquiries: previous!.min_inquiries };
      event = { version: 11, event_id: `learningevent-${randomUUID()}`, at: monitoringTime((options.now ?? (() => new Date().toISOString()))()),
        operation: command.kind === "create-hypothesis" ? "create" : command.kind === "refresh-hypothesis" ? "refresh" : "retire", definition,
        sources: sourcePin(sources), evaluation: evaluateHypothesis(sources, definition) };
      next = [...events, event]; hypotheses = auditLearning(next, sources);
    }
    const selected = command.kind === "inspect-hypothesis" ? hypotheses.filter(h => h.hypothesis_id === command.hypothesisId) : hypotheses;
    if (command.kind === "inspect-hypothesis" && !selected.length) throw new Error("Exact existing hypothesis required");
    const samples = items.filter(e => e.facts.financial_status === "confirmed_closed").length + (legacy ? 1 : 0);
    const preview = "preview" in command && command.preview;
    const output = { version: 11, notice: LEARNING_NOTICE, authorization: NO_AUTHORIZATION, action_authorized: false, preview,
      sources: sourcePin(sources), evidence: items, legacy_evidence: legacy, comparison, sample_size: samples, confidence: evidenceLevel(samples),
      generalization: "insufficient_evidence", hypotheses: selected,
      hypothesis_history: command.kind === "inspect-hypothesis" ? next.filter(e => e.definition.hypothesis_id === command.hypothesisId) : undefined,
      event, report: learningReport(items, selected) };
    const rendered = boundedReport(command.kind === "learning-report" ? output.report : output);
    const verify = async () => { if (!same(await readLearningSources(root), sources)) throw new Error("Learning sources changed during operation"); };
    await verify();
    if (event && !preview) await saveLearning(root, loaded.state, next, previousView, hypothesisView(hypotheses, next)!, loaded.key, verify);
    options.onEvent?.(rendered); return output;
  });
}
