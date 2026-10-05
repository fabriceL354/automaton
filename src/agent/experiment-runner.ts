/**
 * Scout V4 Experiment Runner.
 *
 * V4 is deliberately a planning-only control plane.  It reads the runtime
 * artifact produced by V3, asks Ollama for a few small data-only fragments,
 * validates each fragment immediately, and writes only the two fixed output
 * files.  No model output is ever interpreted as a tool call or a path.
 */
import {
  OPPORTUNITY_FIELDS,
  parseOpportunityAnalysis,
  scoreOpportunity,
  type OpportunityDraft,
  type ScoredOpportunity,
} from "./opportunity-scout.js";
import { reportMatchesLanguage, requestedReportLanguage, type ReportLanguage } from "./report-language.js";
import { validReportContent } from "./report-validation.js";
import { createLocalWorkspaceTools, scoutWorkspaceRoot } from "./local-tools.js";
import { DEFAULT_SCOUT_MODEL, loadLocalScoutSettings, localOllamaUrl } from "./local-runner.js";
import { scoutMode } from "./opportunity-scout.js";

export const EXPERIMENT_LIMITS = Object.freeze({
  maxBudgetEur: 10,
  maxDurationDays: 7,
  maxActions: 5,
  maxMetrics: 5,
  maxStopConditions: 5,
  maxAttemptsPerPhase: 2,
  maxTurns: 6,
  phaseNumPredict: 128,
  maxMissionChars: 1_800,
  maxOpportunityContextChars: 2_400,
  maxHypothesisChars: 600,
  maxActionChars: 240,
  maxMetricChars: 240,
  maxExpectedLearningChars: 600,
});

export interface ExperimentSettings {
  experimentBudgetEur: number;
}

export interface ValidatedOpportunitiesFile {
  budget_eur: number;
  opportunities: ScoredOpportunity[];
}

export interface ExperimentPlan {
  version: 4;
  status: "planned";
  opportunity_name: string;
  opportunity_score: number;
  hypothesis: string;
  experiment_budget_eur: number;
  duration_days: number;
  actions: string[];
  success_metrics: string[];
  stop_conditions: string[];
  expected_learning: string;
  requires_real_spending: boolean;
  requires_external_account: boolean;
  requires_publication: boolean;
  requires_human_approval: boolean;
}

const OPPORTUNITY_FILE_FIELDS = [...OPPORTUNITY_FIELDS, "score"] as const;
const HYPOTHESIS_FIELDS = ["hypothesis"] as const;
const ACTION_FIELDS = ["actions"] as const;
const CRITERIA_FIELDS = [
  "duration_days", "success_metrics", "stop_conditions", "expected_learning",
  "requires_real_spending", "requires_external_account", "requires_publication",
] as const;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every(key => expected.includes(key));
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${label} must be valid JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be an object`);
  return parsed as Record<string, unknown>;
}

function boundedText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} must be bounded nonempty text`);
  }
  // URLs and protocol-looking strings can only come from the runtime's
  // approved artifacts, never from a model-generated plan.
  if (/(?:https?|ftp|file|data):\/\//i.test(value) || /(?:^|\s)www\./i.test(value)) {
    throw new Error(`${name} must not contain a URL`);
  }
  return value.trim();
}

function boundedTextArray(value: unknown, name: string, maxItems: number, itemMax: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) throw new Error(`${name} must contain 1 to ${maxItems} items`);
  return value.map((item, index) => boundedText(item, `${name}[${index}]`, itemMax));
}

function strictBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function positiveBudget(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error(`${name} must be a positive integer up to 10000`);
  }
  return value;
}

/**
 * Strictly revalidates the JSON artifact written by V3.  Its score is checked
 * against the same deterministic scorer instead of being trusted from disk.
 */
export function parseOpportunitiesFile(raw: string): ValidatedOpportunitiesFile {
  const root = parseJsonObject(raw, "opportunities.json");
  if (!exactKeys(root, ["budget_eur", "opportunities"])) throw new Error("opportunities.json has unexpected fields");
  const budget = positiveBudget(root.budget_eur, "budget_eur");
  if (!Array.isArray(root.opportunities) || root.opportunities.length < 1 || root.opportunities.length > 3) {
    throw new Error("opportunities.json must contain one to three opportunities");
  }
  const opportunities = root.opportunities.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`opportunity ${index} must be an object`);
    const data = value as Record<string, unknown>;
    if (!exactKeys(data, OPPORTUNITY_FILE_FIELDS)) throw new Error(`opportunity ${index} has unexpected fields`);
    if (typeof data.evidence_source_indexes !== "object" || !Array.isArray(data.evidence_source_indexes)) {
      throw new Error(`opportunity ${index} has invalid source indexes`);
    }
    const evidence = data.evidence_source_indexes as unknown[];
    const maxEvidence = evidence.length ? Math.max(...evidence.map(item => typeof item === "number" ? item : -1)) : -1;
    const sourceCount = maxEvidence + 1;
    if (!Number.isSafeInteger(sourceCount) || sourceCount < 1) throw new Error(`opportunity ${index} has invalid source indexes`);
    const withoutScore = { ...data };
    delete withoutScore.score;
    const parsed = parseOpportunityAnalysis(JSON.stringify({ opportunities: [withoutScore] }), budget, sourceCount).opportunities[0];
    if (!parsed) throw new Error(`opportunity ${index} is empty`);
    const score = data.score;
    if (typeof score !== "number" || !Number.isSafeInteger(score) || score < 0 || score > 100) {
      throw new Error(`opportunity ${index} has an invalid score`);
    }
    const expectedScore = scoreOpportunity(parsed, budget);
    if (score !== expectedScore) throw new Error(`opportunity ${index} score does not match runtime scoring`);
    return { ...parsed, score };
  });
  if (new Set(opportunities.map(opportunity => opportunity.name.normalize("NFKC").toLocaleLowerCase())).size !== opportunities.length) {
    throw new Error("opportunities.json contains duplicate opportunity names");
  }
  return { budget_eur: budget, opportunities };
}

/** Select the highest runtime score, with stable name/index tie breakers. */
export function selectBestOpportunity(opportunities: readonly ScoredOpportunity[]): ScoredOpportunity {
  if (!opportunities.length) throw new Error("No validated opportunity is available");
  return opportunities.map((opportunity, index) => ({ opportunity, index }))
    .sort((a, b) => b.opportunity.score - a.opportunity.score || a.opportunity.name.localeCompare(b.opportunity.name) || a.index - b.index)[0]!.opportunity;
}

function nonNegativeInteger(raw: string | undefined, name: string, defaultValue: number, max: number): number {
  if (raw === undefined) return defaultValue;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${name} must be a decimal integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`${name} must be between 0 and ${max}`);
  return value;
}

export function loadExperimentSettings(
  env: Record<string, string | undefined> = process.env,
  v3BudgetEur?: number,
): ExperimentSettings {
  if (v3BudgetEur !== undefined && (!Number.isSafeInteger(v3BudgetEur) || v3BudgetEur < 1 || v3BudgetEur > 10_000)) {
    throw new Error("V3 budget is invalid");
  }
  const defaultBudget = Math.min(EXPERIMENT_LIMITS.maxBudgetEur, v3BudgetEur ?? EXPERIMENT_LIMITS.maxBudgetEur);
  const budget = nonNegativeInteger(env.SCOUT_EXPERIMENT_BUDGET_EUR, "SCOUT_EXPERIMENT_BUDGET_EUR", defaultBudget, EXPERIMENT_LIMITS.maxBudgetEur);
  if (v3BudgetEur !== undefined && budget > v3BudgetEur) throw new Error("SCOUT_EXPERIMENT_BUDGET_EUR cannot exceed the V3 budget");
  return { experimentBudgetEur: budget };
}

export function parseExperimentHypothesis(raw: string): string {
  const data = parseJsonObject(raw, "hypothesis");
  if (!exactKeys(data, HYPOTHESIS_FIELDS)) throw new Error("hypothesis output has unexpected fields");
  return boundedText(data.hypothesis, "hypothesis", EXPERIMENT_LIMITS.maxHypothesisChars);
}

function claimsExecution(value: string): boolean {
  const normalized = value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  return /\b(?:already|has been|have been|was executed|were executed|completed|performed|purchased|bought|paid|published|posted|sent|i['’]?ve|we have|j['’]?ai|nous avons|a ete|ont ete|deja|executee?|effectuee?|realisee?|achetee?|payee?|publiee?|envoyee?)\b/.test(normalized);
}

export function parseExperimentActions(raw: string): string[] {
  const data = parseJsonObject(raw, "actions");
  if (!exactKeys(data, ACTION_FIELDS)) throw new Error("actions output has unexpected fields");
  const actions = boundedTextArray(data.actions, "actions", EXPERIMENT_LIMITS.maxActions, EXPERIMENT_LIMITS.maxActionChars);
  if (actions.some(claimsExecution)) throw new Error("actions must describe plans, not completed execution");
  return actions;
}

export interface ExperimentCriteria {
  duration_days: number;
  success_metrics: string[];
  stop_conditions: string[];
  expected_learning: string;
  requires_real_spending: boolean;
  requires_external_account: boolean;
  requires_publication: boolean;
}

export function parseExperimentCriteria(raw: string): ExperimentCriteria {
  const data = parseJsonObject(raw, "criteria");
  if (!exactKeys(data, CRITERIA_FIELDS)) throw new Error("criteria output has unexpected fields");
  if (typeof data.duration_days !== "number" || !Number.isSafeInteger(data.duration_days) || data.duration_days < 1 || data.duration_days > EXPERIMENT_LIMITS.maxDurationDays) {
    throw new Error("duration_days must be an integer from 1 to 7");
  }
  return {
    duration_days: data.duration_days,
    success_metrics: boundedTextArray(data.success_metrics, "success_metrics", EXPERIMENT_LIMITS.maxMetrics, EXPERIMENT_LIMITS.maxMetricChars),
    stop_conditions: boundedTextArray(data.stop_conditions, "stop_conditions", EXPERIMENT_LIMITS.maxStopConditions, EXPERIMENT_LIMITS.maxMetricChars),
    expected_learning: boundedText(data.expected_learning, "expected_learning", EXPERIMENT_LIMITS.maxExpectedLearningChars),
    requires_real_spending: strictBoolean(data.requires_real_spending, "requires_real_spending"),
    requires_external_account: strictBoolean(data.requires_external_account, "requires_external_account"),
    requires_publication: strictBoolean(data.requires_publication, "requires_publication"),
  };
}

function positiveSensitive(text: string, pattern: RegExp): boolean {
  if (!pattern.test(text)) return false;
  // Explicitly planned non-actions do not turn the plan into a sensitive one.
  return !/\b(?:sans|aucun(?:e)?|ne\s+(?:pas|jamais)|without|no|never)\b/i.test(text);
}

function deriveRequirements(criteria: ExperimentCriteria, hypothesis: string, actions: string[], metrics: string[], stops: string[], learning: string) {
  const all = [hypothesis, ...actions, ...metrics, ...stops, learning];
  const spending = /\b(?:acheter|achat|payer|paiement|depense|depenser|purchase|buy|pay|spend|spending|transaction|wallet|portefeuille)\b/i;
  const account = /\b(?:compte|authentification|connexion|login|account|credential|inscription|register)\b/i;
  const publication = /\b(?:publier|publication|poster|post|message|email|courriel|formulaire|publish|send|sending)\b/i;
  const other = /\b(?:shell|commande|terminal|wallet|portefeuille|transaction|external action|action externe)\b/i;
  return {
    requires_real_spending: criteria.requires_real_spending || all.some(text => positiveSensitive(text, spending)),
    requires_external_account: criteria.requires_external_account || all.some(text => positiveSensitive(text, account)),
    requires_publication: criteria.requires_publication || all.some(text => positiveSensitive(text, publication)),
    otherSensitive: all.some(text => positiveSensitive(text, other)),
  };
}

export function computeRequiresHumanApproval(plan: Pick<ExperimentPlan, "requires_real_spending" | "requires_external_account" | "requires_publication"> & { other_sensitive?: boolean }): boolean {
  return plan.requires_real_spending || plan.requires_external_account || plan.requires_publication || Boolean(plan.other_sensitive);
}

function selectedContext(opportunity: ScoredOpportunity): string {
  const compact = {
    name: opportunity.name,
    summary: opportunity.summary.slice(0, 600),
    score: opportunity.score,
    startup_cost_eur: opportunity.startup_cost_eur,
    time_to_first_revenue_days: opportunity.time_to_first_revenue_days,
    weekly_time_hours: opportunity.weekly_time_hours,
    risk_1_5: opportunity.risk_1_5,
    margin_potential_1_5: opportunity.margin_potential_1_5,
    scalability_1_5: opportunity.scalability_1_5,
    key_risks: opportunity.key_risks.slice(0, 3).map(risk => risk.slice(0, 140)),
    first_three_steps: opportunity.first_three_steps.map(step => step.slice(0, 160)),
    requires_account: opportunity.requires_account,
    requires_paid_service: opportunity.requires_paid_service,
  };
  return JSON.stringify(compact).slice(0, EXPERIMENT_LIMITS.maxOpportunityContextChars);
}

async function askOllamaJson(baseUrl: string, model: string, system: string, prompt: string,
  inference: ReturnType<typeof loadLocalScoutSettings>): Promise<string> {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(inference.timeoutMs),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      stream: false, format: "json", options: { temperature: 0, num_predict: Math.min(inference.numPredict, EXPERIMENT_LIMITS.phaseNumPredict), num_ctx: inference.numCtx } }),
  });
  if (!response.ok) throw new Error(`Local Ollama error ${response.status}: ${await response.text()}`);
  const data = await response.json() as { message?: { content?: unknown }; error?: string };
  if (data.error) throw new Error(`Local Ollama: ${data.error}`);
  if (typeof data.message?.content !== "string") throw new Error("Invalid Ollama experiment response");
  return data.message.content;
}

function languageInstruction(language: ReportLanguage | undefined): string {
  return language === "en" ? "Use English." : language === "fr" ? "Réponds en français." : "Use the mission language.";
}

export function buildExperimentReport(plan: ExperimentPlan, language: ReportLanguage | undefined): string {
  const english = language === "en";
  const lines = english ? [
    "Scout V4 Experiment Runner — plan only", "", `Selected opportunity: ${plan.opportunity_name}`,
    `V3 score: ${plan.opportunity_score}/100`, `Hypothesis: ${plan.hypothesis}`,
    `Maximum planned budget: ${plan.experiment_budget_eur} EUR`, `Duration: ${plan.duration_days} days`, "",
    "Actions:", ...plan.actions.map(action => `- ${action}`), "", "Success metrics:",
    ...plan.success_metrics.map(metric => `- ${metric}`), "", "Stop conditions:",
    ...plan.stop_conditions.map(stop => `- ${stop}`), "", `Expected learning: ${plan.expected_learning}`,
    `Future human approval: ${plan.requires_human_approval ? "required before any sensitive action" : "not currently required"}`,
    "No spending or external action was executed by Scout.",
  ] : [
    "Scout V4 Experiment Runner — planification uniquement", "", `Opportunité sélectionnée : ${plan.opportunity_name}`,
    `Score V3 : ${plan.opportunity_score}/100`, `Hypothèse : ${plan.hypothesis}`,
    `Budget maximum planifié : ${plan.experiment_budget_eur} €`, `Durée : ${plan.duration_days} jours`, "",
    "Actions :", ...plan.actions.map(action => `- ${action}`), "", "Critères de succès :",
    ...plan.success_metrics.map(metric => `- ${metric}`), "", "Conditions d'arrêt :",
    ...plan.stop_conditions.map(stop => `- ${stop}`), "", `Apprentissage attendu : ${plan.expected_learning}`,
    `Approbation humaine future : ${plan.requires_human_approval ? "requise avant toute action sensible" : "non requise actuellement"}`,
    "Aucune dépense ni action externe n'a été exécutée par Scout.",
  ];
  return lines.join("\n").trim() + "\n";
}

export async function runExperimentScout(options: {
  model?: string;
  baseUrl: string;
  root?: string;
  maxTurns?: number;
  onEvent?: (message: string) => void;
}): Promise<void> {
  if (scoutMode() !== "experiment") throw new Error("Experiment Runner requires SCOUT_MODE=experiment");
  const baseUrl = localOllamaUrl(options.baseUrl);
  const inference = loadLocalScoutSettings();
  const debug = process.env.SCOUT_DEBUG_ACTIONS;
  if (debug !== undefined && debug !== "0" && debug !== "1") throw new Error("SCOUT_DEBUG_ACTIONS must be 0 or 1");
  const maxTurns = options.maxTurns ?? EXPERIMENT_LIMITS.maxTurns;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > EXPERIMENT_LIMITS.maxTurns) throw new Error("maxTurns must be between 1 and 6");
  const model = options.model ?? DEFAULT_SCOUT_MODEL;
  if (!/^[a-zA-Z0-9_.:-]+$/.test(model) || /(?:cloud|latest-cloud)$/i.test(model)) throw new Error("Use a locally installed Ollama model");

  const tools = createLocalWorkspaceTools(options.root ?? scoutWorkspaceRoot());
  const execute = (name: string, args: Record<string, unknown>) => {
    const tool = tools.find(candidate => candidate.name === name);
    if (!tool) return Promise.resolve("ERROR: tool unavailable");
    return (tool.execute as (input: Record<string, unknown>) => Promise<string>)(args);
  };
  await execute("list_files", {});
  const mission = await execute("read_file", { path: "MISSION.txt" });
  if (mission.startsWith("ERROR:") || !mission.trim()) throw new Error("Create a nonempty MISSION.txt in ~/.automaton/scout-workspace before starting Scout");
  const language = requestedReportLanguage(mission);
  const artifact = await execute("read_file", { path: "opportunities.json" });
  if (artifact.startsWith("ERROR:")) throw new Error("Experiment Runner requires a readable opportunities.json");
  const validated = parseOpportunitiesFile(artifact);
  const selected = selectBestOpportunity(validated.opportunities);
  const settings = loadExperimentSettings(process.env, validated.budget_eur);
  const context = selectedContext(selected);
  const languageHint = languageInstruction(language);
  const system = "You are Scout V4. Return only the requested small JSON object. This is a plan, not execution. No tools, paths, URLs, accounts, payments or external actions.";
  let calls = 0;
  const call = async (prompt: string): Promise<string> => {
    if (calls >= maxTurns) throw new Error("Scout model-call budget exhausted");
    calls++;
    return askOllamaJson(baseUrl, model, system, prompt, inference);
  };
  const runPhase = async <T>(name: string, prompt: string, parse: (raw: string) => T): Promise<T> => {
    let reason = "invalid output";
    for (let attempt = 0; attempt < EXPERIMENT_LIMITS.maxAttemptsPerPhase; attempt++) {
      let raw = "";
      try {
        raw = await call(`${prompt}${attempt ? `\nPrevious output was rejected: ${reason}. Retry with the exact minimal schema.` : ""}`);
        const parsed = parse(raw);
        options.onEvent?.(`experiment ${name}: validated`);
        return parsed;
      } catch (error) {
        reason = error instanceof Error ? error.message : "invalid output";
        if (debug === "1" && raw) console.error(raw);
        options.onEvent?.(`ERROR: experiment ${name} rejected (${reason})`);
      }
    }
    throw new Error(`Experiment ${name} exhausted its bounded retries`);
  };

  const hypothesis = await runPhase("hypothesis", `MISSION.txt:\n${mission.slice(0, EXPERIMENT_LIMITS.maxMissionChars)}\nSelected V3 opportunity (runtime-selected; do not choose another):\n${context}\nReturn exactly {"hypothesis":"..."}. Keep it short, testable and ${languageHint}`, parseExperimentHypothesis);
  const actions = await runPhase("actions", `Selected opportunity:\n${context}\nHypothesis:\n${hypothesis}\nReturn exactly {"actions":["..."]} with 1 to 5 planned, reversible, non-executed actions. ${languageHint}`, parseExperimentActions);
  const criteria = await runPhase("criteria", `Selected opportunity:\n${context}\nHypothesis:\n${hypothesis}\nPlanned actions:\n${actions.join(" | ")}\nReturn exactly {"duration_days":1,"success_metrics":["..."],"stop_conditions":["..."],"expected_learning":"...","requires_real_spending":false,"requires_external_account":false,"requires_publication":false}. Use an integer duration from 1 to 7 and strict booleans. ${languageHint}`, parseExperimentCriteria);

  const requirements = deriveRequirements(criteria, hypothesis, actions, criteria.success_metrics, criteria.stop_conditions, criteria.expected_learning);
  const requiresHumanApproval = computeRequiresHumanApproval({ ...requirements, other_sensitive: requirements.otherSensitive });
  const plan: ExperimentPlan = {
    version: 4,
    status: "planned",
    opportunity_name: selected.name,
    opportunity_score: selected.score,
    hypothesis,
    // If no real spending is in the plan, prefer a zero-euro experiment even
    // when the operator supplied a larger planning ceiling.
    experiment_budget_eur: requirements.requires_real_spending ? settings.experimentBudgetEur : 0,
    duration_days: criteria.duration_days,
    actions,
    success_metrics: criteria.success_metrics,
    stop_conditions: criteria.stop_conditions,
    expected_learning: criteria.expected_learning,
    requires_real_spending: requirements.requires_real_spending,
    requires_external_account: requirements.requires_external_account,
    requires_publication: requirements.requires_publication,
    requires_human_approval: requiresHumanApproval,
  };
  const report = buildExperimentReport(plan, language);
  if (!validReportContent(report, mission) || !reportMatchesLanguage(report, language)) throw new Error("Experiment report validation failed");
  const structured = JSON.stringify(plan, null, 2) + "\n";
  const jsonWrite = await execute("write_file", { path: "experiment.json", content: structured });
  options.onEvent?.(`write_file experiment.json: ${jsonWrite.startsWith("ERROR:") ? jsonWrite : "completed"}`);
  if (!jsonWrite.startsWith("File written:")) throw new Error("experiment.json write failed");
  if (await execute("read_file", { path: "experiment.json" }) !== structured) throw new Error("experiment.json verification failed");
  const reportWrite = await execute("write_file", { path: "experiment-report.txt", content: report });
  options.onEvent?.(`write_file experiment-report.txt: ${reportWrite.startsWith("ERROR:") ? reportWrite : "completed"}`);
  if (!reportWrite.startsWith("File written:")) throw new Error("experiment-report.txt write failed");
  const verifiedReport = await execute("read_file", { path: "experiment-report.txt" });
  if (verifiedReport !== report || !validReportContent(verifiedReport, mission) || !reportMatchesLanguage(verifiedReport, language)) {
    throw new Error("experiment-report.txt verification failed");
  }
  options.onEvent?.("Scout completed: experiment.json and experiment-report.txt verified.");
}

// Keep this type import/use visible to declaration consumers without widening
// the runtime contract.
export type { OpportunityDraft };
