/**
 * Scout V3.1 Opportunity mode.
 *
 * This module deliberately keeps the model out of the control plane: the
 * runtime performs all searches, page reads and file writes. Ollama receives
 * only bounded, already-read source text and returns data for validation.
 */
import { publicWebInputs, WebResearchSession } from "../scout-web/session.js";
import { WEB_LIMITS } from "../scout-web/network.js";
import { reportMatchesLanguage, requestedReportLanguage, type ReportLanguage } from "./report-language.js";
import { validReportContent } from "./report-validation.js";
import { createLocalWorkspaceTools, scoutWorkspaceRoot } from "./local-tools.js";
import { DEFAULT_SCOUT_MODEL, loadLocalScoutSettings, localOllamaUrl } from "./local-runner.js";

export const OPPORTUNITY_LIMITS = Object.freeze({
  budgetMaxEur: 10_000,
  maxOpportunities: 3,
  maxSources: 3,
  maxAnalysisAttempts: 3,
  maxCandidateAttempts: 2,
  candidateNumPredict: 128,
  detailNumPredict: 256,
  maxMissionChars: 1_800,
  maxSourceChars: 1_200,
  maxCountryChars: 120,
  maxContextChars: 500,
  maxNameChars: 120,
  maxSummaryChars: 1_000,
  maxRiskChars: 240,
  maxStepChars: 300,
});

export interface OpportunitySettings {
  budgetEur: number;
  country?: string;
  context?: string;
}

export interface OpportunityDraft {
  name: string;
  summary: string;
  startup_cost_eur: number;
  time_to_first_revenue_days: number;
  weekly_time_hours: number;
  difficulty_1_5: number;
  risk_1_5: number;
  margin_potential_1_5: number;
  scalability_1_5: number;
  requires_account: boolean;
  requires_paid_service: boolean;
  key_risks: string[];
  first_three_steps: string[];
  evidence_source_indexes: number[];
}

export interface ScoredOpportunity extends OpportunityDraft {
  score: number;
}

export interface OpportunityAnalysis {
  opportunities: OpportunityDraft[];
}

export interface OpportunityCandidate {
  name: string;
}

export const OPPORTUNITY_FIELDS = [
  "name", "summary", "startup_cost_eur", "time_to_first_revenue_days",
  "weekly_time_hours", "difficulty_1_5", "risk_1_5", "margin_potential_1_5",
  "scalability_1_5", "requires_account", "requires_paid_service", "key_risks",
  "first_three_steps", "evidence_source_indexes",
] as const;

const DETAIL_FIELDS = [
  "summary", "startup_cost_eur", "time_to_first_revenue_days", "weekly_time_hours",
  "difficulty_1_5", "risk_1_5", "margin_potential_1_5", "scalability_1_5",
  "requires_account", "requires_paid_service", "key_risks", "first_three_steps",
] as const;

const FULL_DETAIL_FIELDS = ["name", ...DETAIL_FIELDS, "evidence_source_indexes"] as const;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every(key => expected.includes(key));
}

function safeText(value: unknown, max: number, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} must be a bounded nonempty text value`);
  }
  return value.trim();
}

function boundedOptionalText(env: Record<string, string | undefined>, name: string, max: number): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  return safeText(raw, max, name);
}

function positiveInteger(raw: string | undefined, name: string, defaultValue: number, max: number): number {
  if (raw === undefined) return defaultValue;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive decimal integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be between 1 and ${max}`);
  return value;
}

function checkedBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > OPPORTUNITY_LIMITS.budgetMaxEur) {
    throw new Error(`budgetEur must be a positive integer up to ${OPPORTUNITY_LIMITS.budgetMaxEur}`);
  }
  return value;
}

export function loadOpportunitySettings(env: Record<string, string | undefined> = process.env): OpportunitySettings {
  return {
    budgetEur: positiveInteger(env.SCOUT_BUDGET_EUR, "SCOUT_BUDGET_EUR", 100, OPPORTUNITY_LIMITS.budgetMaxEur),
    country: boundedOptionalText(env, "SCOUT_COUNTRY", OPPORTUNITY_LIMITS.maxCountryChars),
    context: boundedOptionalText(env, "SCOUT_CONTEXT", OPPORTUNITY_LIMITS.maxContextChars),
  };
}

function finiteNumber(value: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${name} is outside its allowed range`);
  }
  return value;
}

function boundedStringArray(value: unknown, name: string, min: number, max: number, itemMax: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${name} must be a bounded array`);
  return value.map((item, index) => safeText(item, itemMax, `${name}[${index}]`));
}

function validateOpportunityFields(data: Record<string, unknown>, budgetEur: number, sourceCount: number,
  name: string, evidenceSourceIndexes: number[]): OpportunityDraft {
  if (!exactKeys(data, DETAIL_FIELDS)) throw new Error("Opportunity detail has unexpected fields");
  const startup = finiteNumber(data.startup_cost_eur, "startup_cost_eur", 0, budgetEur);
  if (Math.round(startup * 100) !== startup * 100) throw new Error("startup_cost_eur must have at most two decimals");
  const time = finiteNumber(data.time_to_first_revenue_days, "time_to_first_revenue_days", 0, 3650, true);
  const hours = finiteNumber(data.weekly_time_hours, "weekly_time_hours", 0, 168);
  const score = (field: string) => finiteNumber(data[field], field, 1, 5, true);
  if (evidenceSourceIndexes.length < 1 || evidenceSourceIndexes.length > sourceCount ||
      evidenceSourceIndexes.some(item => !Number.isSafeInteger(item) || item < 0 || item >= sourceCount) ||
      new Set(evidenceSourceIndexes).size !== evidenceSourceIndexes.length) {
    throw new Error("evidence_source_indexes must point to distinct read sources");
  }
  return {
    name: safeText(name, OPPORTUNITY_LIMITS.maxNameChars, "name"),
    summary: safeText(data.summary, OPPORTUNITY_LIMITS.maxSummaryChars, "summary"),
    startup_cost_eur: startup,
    time_to_first_revenue_days: time,
    weekly_time_hours: hours,
    difficulty_1_5: score("difficulty_1_5"),
    risk_1_5: score("risk_1_5"),
    margin_potential_1_5: score("margin_potential_1_5"),
    scalability_1_5: score("scalability_1_5"),
    requires_account: typeof data.requires_account === "boolean" ? data.requires_account : (() => { throw new Error("requires_account must be boolean"); })(),
    requires_paid_service: typeof data.requires_paid_service === "boolean" ? data.requires_paid_service : (() => { throw new Error("requires_paid_service must be boolean"); })(),
    key_risks: boundedStringArray(data.key_risks, "key_risks", 1, 5, OPPORTUNITY_LIMITS.maxRiskChars),
    first_three_steps: boundedStringArray(data.first_three_steps, "first_three_steps", 3, 3, OPPORTUNITY_LIMITS.maxStepChars),
    evidence_source_indexes: [...evidenceSourceIndexes],
  };
}

/** Parse and validate the legacy complete analysis contract (kept for V3 callers/tests). */
export function parseOpportunityAnalysis(raw: string, budgetEur: number, sourceCount: number): OpportunityAnalysis {
  checkedBudget(budgetEur);
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 0 || sourceCount > WEB_LIMITS.pages) throw new Error("sourceCount is outside its allowed range");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Opportunity analysis must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Opportunity analysis must be an object");
  const root = parsed as Record<string, unknown>;
  if (!exactKeys(root, ["opportunities"]) || !Array.isArray(root.opportunities) || root.opportunities.length > OPPORTUNITY_LIMITS.maxOpportunities) {
    throw new Error("Opportunity analysis must contain only up to three opportunities");
  }
  const opportunities = root.opportunities.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Opportunity ${index} must be an object`);
    const data = value as Record<string, unknown>;
    if (!exactKeys(data, OPPORTUNITY_FIELDS)) throw new Error(`Opportunity ${index} has unexpected fields`);
    const name = safeText(data.name, OPPORTUNITY_LIMITS.maxNameChars, "name");
    const evidence = data.evidence_source_indexes;
    if (!Array.isArray(evidence)) throw new Error("evidence_source_indexes must be an array");
    return validateOpportunityFields(dataWithout(data, "name", "evidence_source_indexes"), budgetEur, sourceCount, name, evidence as number[]);
  });
  return { opportunities };
}

function dataWithout(data: Record<string, unknown>, ...fields: string[]): Record<string, unknown> {
  const copy = { ...data };
  for (const field of fields) delete copy[field];
  return copy;
}

function rejectCandidateUrl(name: string): void {
  if (/\b(?:https?|ftp):\/\//i.test(name) || /\bwww\./i.test(name)) throw new Error("Candidate must not contain a URL");
}

/** Candidate list contract: short names only, with no model-generated URL/query. */
export function parseOpportunityCandidates(raw: string): OpportunityCandidate[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Candidate list must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Candidate list must be an object");
  const root = parsed as Record<string, unknown>;
  if (!exactKeys(root, ["candidates"]) || !Array.isArray(root.candidates) || root.candidates.length > OPPORTUNITY_LIMITS.maxOpportunities) {
    throw new Error("Candidate list must contain at most three candidates");
  }
  const names = root.candidates.map((value, index) => {
    const name = typeof value === "string" ? value : value && typeof value === "object" && !Array.isArray(value) && exactKeys(value as Record<string, unknown>, ["name"])
      ? (value as Record<string, unknown>).name : undefined;
    const text = safeText(name, OPPORTUNITY_LIMITS.maxNameChars, `candidate[${index}]`);
    rejectCandidateUrl(text);
    return text;
  });
  if (new Set(names.map(name => name.toLocaleLowerCase())).size !== names.length) throw new Error("Candidate names must be unique");
  return names.map(name => ({ name }));
}

/** Parse one compact detail object. Evidence is supplied by the runtime when omitted. */
export function parseOpportunityDetail(raw: string, candidate: OpportunityCandidate, budgetEur: number,
  sourceCount: number): OpportunityDraft {
  checkedBudget(budgetEur);
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 1 || sourceCount > WEB_LIMITS.pages) throw new Error("sourceCount is outside its allowed range");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Opportunity detail must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Opportunity detail must be an object");
  const data = parsed as Record<string, unknown>;
  if (exactKeys(data, DETAIL_FIELDS)) return validateOpportunityFields(data, budgetEur, sourceCount, candidate.name, Array.from({ length: sourceCount }, (_, index) => index));
  if (exactKeys(data, FULL_DETAIL_FIELDS)) {
    const name = safeText(data.name, OPPORTUNITY_LIMITS.maxNameChars, "name");
    if (name !== candidate.name) throw new Error("Opportunity detail name does not match its candidate");
    if (!Array.isArray(data.evidence_source_indexes)) throw new Error("evidence_source_indexes must be an array");
    return validateOpportunityFields(dataWithout(data, "name", "evidence_source_indexes"), budgetEur, sourceCount, candidate.name, data.evidence_source_indexes as number[]);
  }
  throw new Error("Opportunity detail must use the compact one-opportunity contract");
}

function costScore(cost: number, budget: number): number {
  return Math.max(1, Math.min(5, Math.ceil((1 - cost / budget) * 5)));
}

function speedScore(days: number): number {
  if (days <= 7) return 5;
  if (days <= 30) return 4;
  if (days <= 90) return 3;
  if (days <= 180) return 2;
  return 1;
}

/** Deterministic 0–100 score; the model never supplies or changes this value. */
export function scoreOpportunity(opportunity: OpportunityDraft, budgetEur: number): number {
  checkedBudget(budgetEur);
  if (opportunity.startup_cost_eur > budgetEur) throw new Error("startup cost exceeds budget");
  // Each 1–5 component is normalized to its percentage weight; the maximum is 100.
  return costScore(opportunity.startup_cost_eur, budgetEur) * 4 +
    speedScore(opportunity.time_to_first_revenue_days) * 4 +
    (6 - opportunity.risk_1_5) * 4 + opportunity.margin_potential_1_5 * 4 +
    opportunity.scalability_1_5 * 2 + (6 - opportunity.difficulty_1_5) * 2;
}

export function rankOpportunities(opportunities: OpportunityDraft[], budgetEur: number): ScoredOpportunity[] {
  checkedBudget(budgetEur);
  return opportunities.map((opportunity, index) => ({ ...opportunity, score: scoreOpportunity(opportunity, budgetEur), _index: index }))
    .sort((a, b) => b.score - a.score || a._index - b._index || a.name.localeCompare(b.name))
    .slice(0, OPPORTUNITY_LIMITS.maxOpportunities)
    .map(({ _index: _ignored, ...opportunity }) => opportunity);
}

function languageLabels(language: ReportLanguage | undefined) {
  return language === "en" ? {
    title: "Opportunity Scout V3.1", budget: "Budget analyzed", top: "Top 3 ranked opportunities",
    why: "Why it is interesting", cost: "Startup cost", time: "Time to first revenue",
    hours: "Weekly time", risk: "Risks", first: "First experiment (maximum 10 EUR)",
    recommendation: "Recommendation", assumptions: "Assumptions and missing data",
    noViable: "No viable opportunity was validated from the read sources.",
    noGuarantee: "Revenue estimates are hypotheses, never guarantees.",
    noSpend: "Scout performs no purchase or spending.", steps: "Steps", days: "days", hoursUnit: "h", sourcesRead: "sources read",
    account: "Account required", paid: "Paid service required", yes: "yes", no: "no",
    evidence: "Evidence",
  } : {
    title: "Opportunity Scout V3.1", budget: "Budget analysé", top: "Top 3 des opportunités classées",
    why: "Pourquoi cette option est intéressante", cost: "Coût de démarrage", time: "Délai avant premiers revenus",
    hours: "Temps hebdomadaire", risk: "Risques", first: "Première expérience (maximum 10 €)",
    recommendation: "Recommandation", assumptions: "Hypothèses et données manquantes",
    noViable: "Aucune opportunité viable n'a été validée à partir des sources lues.",
    noGuarantee: "Les estimations de revenus sont des hypothèses, jamais des garanties.",
    noSpend: "Scout n'effectue aucun achat et aucune dépense.", steps: "Étapes", days: "jours", hoursUnit: "h", sourcesRead: "sources lues",
    account: "Compte requis", paid: "Service payant requis", yes: "oui", no: "non",
    evidence: "Preuves",
  };
}

export function buildOpportunityReport(
  opportunities: ScoredOpportunity[], budgetEur: number, mission: string,
  language: ReportLanguage | undefined, sourceCount: number, sourceUrls: string[] = [],
): string {
  const labels = languageLabels(language);
  const lines = [labels.title, "", `${labels.budget} : ${budgetEur} €`, "", labels.top, ""];
  if (!opportunities.length) lines.push(labels.noViable);
  opportunities.slice(0, 3).forEach((opportunity, index) => {
    const sources = opportunity.evidence_source_indexes.map(source => `[${source}]`).join(", ");
    lines.push(`${index + 1}. ${opportunity.name} — score ${opportunity.score}/100`);
    lines.push(`${labels.why} : ${opportunity.summary}`);
    lines.push(`${labels.cost} : ${opportunity.startup_cost_eur} € ; ${labels.time} : ${opportunity.time_to_first_revenue_days} ${labels.days} ; ${labels.hours} : ${opportunity.weekly_time_hours} ${labels.hoursUnit}`);
    lines.push(`${labels.account} : ${opportunity.requires_account ? labels.yes : labels.no} ; ${labels.paid} : ${opportunity.requires_paid_service ? labels.yes : labels.no}`);
    lines.push(`${labels.risk} : ${opportunity.key_risks.join(" ; ")} (${labels.sourcesRead} ${sources})`);
    lines.push(`${labels.evidence} : ${opportunity.evidence_source_indexes.map(source => `[${source}] ${sourceUrls[source] ?? "source lue"}`).join(" ; ")}`);
    lines.push(`${labels.steps} : ${opportunity.first_three_steps.join(" → ")}`);
    lines.push("");
  });
  const best = opportunities[0];
  const experiment = best?.first_three_steps[0] ?? (language === "en" ? "Interview one potential user without spending money." : "Interroger un utilisateur potentiel sans dépenser.");
  lines.push(labels.first + " : " + experiment + ". " + labels.noSpend);
  lines.push("");
  lines.push(`${labels.recommendation} : ${best ? `${best.name} (score ${best.score}/100)` : labels.noViable}`);
  lines.push("");
  lines.push(`${labels.assumptions} : ${language === "en" ? "Market demand, costs and timing must be checked locally; the sources do not verify future revenue." : "La demande, les coûts et les délais doivent être vérifiés localement ; les sources ne vérifient pas les revenus futurs."}`);
  lines.push(labels.noGuarantee);
  // Keep mission only as the context for the check; never copy it into the report.
  void mission;
  void sourceCount;
  return lines.join("\n").trim() + "\n";
}

function parseReadSource(value: string): { url: string; text: string } | undefined {
  try {
    const data = JSON.parse(value) as Record<string, unknown>;
    if (!data || typeof data.url !== "string" || typeof data.text !== "string" || !data.text.trim()) return undefined;
    return { url: data.url, text: data.text.slice(0, OPPORTUNITY_LIMITS.maxSourceChars) };
  } catch { return undefined; }
}

function debugSetting(): string | undefined {
  const value = process.env.SCOUT_DEBUG_ACTIONS;
  if (value !== undefined && value !== "0" && value !== "1") throw new Error("SCOUT_DEBUG_ACTIONS must be 0 or 1");
  return value;
}

function sourcePrompt(sources: Array<{ url: string; text: string }>): string {
  return sources.map((source, index) => `[${index}] ${source.url}\n${source.text}`).join("\n\n");
}

async function askOllamaJson(baseUrl: string, model: string, system: string, prompt: string,
  inference: ReturnType<typeof loadLocalScoutSettings>, numPredict: number): Promise<string> {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(inference.timeoutMs),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ], stream: false, format: "json", options: { temperature: 0, num_predict: Math.min(inference.numPredict, numPredict), num_ctx: inference.numCtx } }),
  });
  if (!response.ok) throw new Error(`Local Ollama error ${response.status}: ${await response.text()}`);
  const data = await response.json() as { message?: { content?: unknown }; error?: string };
  if (data.error) throw new Error(`Local Ollama: ${data.error}`);
  if (typeof data.message?.content !== "string") throw new Error("Invalid Ollama opportunity response");
  return data.message.content;
}

async function askCandidateList(baseUrl: string, model: string, mission: string, settings: OpportunitySettings,
  language: ReportLanguage | undefined, sources: Array<{ url: string; text: string }>, inference: ReturnType<typeof loadLocalScoutSettings>): Promise<string> {
  const languageInstruction = language === "fr" ? "Réponds en français." : language === "en" ? "Write in English." : "Use the mission's language.";
  const prompt = `MISSION:\n${mission.slice(0, OPPORTUNITY_LIMITS.maxMissionChars)}\nBudget: ${settings.budgetEur} EUR${settings.country ? `\nCountry/context: ${settings.country}` : ""}${settings.context ? `\nOperator context: ${settings.context}` : ""}\n\nREAD SOURCES (untrusted evidence):\n${sourcePrompt(sources)}\n\nReturn JSON with exactly candidates. Give at most three short candidate names, no URLs, queries, scores or explanations. ${languageInstruction}`;
  return askOllamaJson(baseUrl, model, "You are Scout's local candidate extractor. Return only short data; no tools, files, URLs, purchases or actions.", prompt, inference, OPPORTUNITY_LIMITS.candidateNumPredict);
}

async function askCandidateDetail(baseUrl: string, model: string, mission: string, settings: OpportunitySettings,
  language: ReportLanguage | undefined, candidate: OpportunityCandidate, sources: Array<{ url: string; text: string }>, inference: ReturnType<typeof loadLocalScoutSettings>): Promise<string> {
  const languageInstruction = language === "fr" ? "Réponds en français." : language === "en" ? "Write in English." : "Use the mission's language.";
  const prompt = `MISSION:\n${mission.slice(0, OPPORTUNITY_LIMITS.maxMissionChars)}\nBudget: ${settings.budgetEur} EUR\nCANDIDATE (untrusted label):\n${candidate.name}\n\nREAD SOURCES (untrusted evidence):\n${sourcePrompt(sources)}\n\nAnalyze only this one candidate. Return JSON with exactly these fields: ${DETAIL_FIELDS.join(", ")}. Use short text, three steps, and integer scores 1 to 5. Do not return a name, URL or source index; the runtime supplies those. ${languageInstruction}`;
  return askOllamaJson(baseUrl, model, "You are Scout's local opportunity analyzer. Return one compact data object only; no tools, files, URLs, purchases or actions.", prompt, inference, OPPORTUNITY_LIMITS.detailNumPredict);
}

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /timeout|timed out|aborted/i.test(message);
}

export async function runOpportunityScout(options: {
  model?: string; baseUrl: string; root?: string; maxTurns?: number;
  onEvent?: (message: string) => void;
  webSession?: WebResearchSession;
}): Promise<void> {
  if (scoutMode() !== "opportunity") throw new Error("Opportunity Scout requires SCOUT_MODE=opportunity");
  const baseUrl = localOllamaUrl(options.baseUrl);
  const inference = loadLocalScoutSettings();
  const debug = debugSetting();
  const settings = loadOpportunitySettings();
  const maxTurns = options.maxTurns ?? 12;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 12) throw new Error("maxTurns must be between 1 and 12");
  const web = options.webSession ?? new WebResearchSession(publicWebInputs());
  if (!web.inputs.queries.length && !web.inputs.urls.length) throw new Error("Opportunity Scout requires SCOUT_PUBLIC_QUERIES or SCOUT_PUBLIC_URLS");
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

  // Web control plane: all approved queries are executed by the runtime.
  for (let index = 0; index < web.inputs.queries.length; index++) {
    const result = await web.searchIndex(index);
    options.onEvent?.(`web_search: ${result.startsWith("ERROR:") ? result : "completed"}`);
    if (result.startsWith("ERROR:")) throw new Error("Opportunity Scout search failed; no report written");
  }
  const sourceCandidates: Array<{ kind: "result" | "url"; index: number; url: string }> = [];
  const seen = new Set<string>();
  // resultSnapshot intentionally exposes no mutable index; derive the index from
  // its stable order and keep URLs only as a duplicate guard.
  const resultSnapshot = web.resultSnapshot();
  resultSnapshot.forEach((result, index) => {
    if (!seen.has(result.url)) { seen.add(result.url); sourceCandidates.push({ kind: "result", index, url: result.url }); }
  });
  web.inputs.urls.forEach((url, index) => {
    if (!seen.has(url)) { seen.add(url); sourceCandidates.push({ kind: "url", index, url }); }
  });
  const sources: Array<{ url: string; text: string }> = [];
  for (const sourceCandidate of sourceCandidates.slice(0, WEB_LIMITS.pages)) {
    const tool = sourceCandidate.kind === "result" ? "read_search_result" : "read_public_url";
    const value = await web.readIndex(tool, sourceCandidate.index);
    options.onEvent?.(`${tool}: ${value.startsWith("ERROR:") ? value : "completed"}`);
    const source = value.startsWith("ERROR:") ? undefined : parseReadSource(value);
    if (source) sources.push(source);
    if (sources.length >= OPPORTUNITY_LIMITS.maxSources) break;
  }
  if (!sources.length || !web.canWriteReport()) throw new Error("Opportunity Scout could not read a public source; no report written");

  const model = options.model ?? DEFAULT_SCOUT_MODEL;
  if (!/^[a-zA-Z0-9_.:-]+$/.test(model) || /(?:cloud|latest-cloud)$/i.test(model)) throw new Error("Use a locally installed Ollama model");
  let inferenceCalls = 0;
  const call = <T>(operation: () => Promise<T>): Promise<T> => {
    if (inferenceCalls >= maxTurns) throw new Error("Scout model-call budget exhausted");
    inferenceCalls++;
    return operation();
  };

  let opportunityCandidates: OpportunityCandidate[] | undefined;
  let candidateReason = "invalid candidate list";
  for (let attempt = 0; attempt < OPPORTUNITY_LIMITS.maxAnalysisAttempts && inferenceCalls < maxTurns; attempt++) {
    let raw = "";
    try {
      raw = await call(() => askCandidateList(baseUrl, model, mission, settings, language, sources, inference));
      opportunityCandidates = parseOpportunityCandidates(raw);
      options.onEvent?.(`opportunity_candidates: ${opportunityCandidates.length} candidate(s)`);
      break;
    } catch (error) {
      candidateReason = error instanceof Error ? error.message : "invalid candidate list";
      if (debug === "1" && raw) console.error(raw);
      options.onEvent?.(`ERROR: candidate list rejected before analysis (${candidateReason})`);
    }
  }
  if (!opportunityCandidates) throw new Error(`Scout could not obtain a valid candidate list: ${candidateReason}`);

  const valid: OpportunityDraft[] = [];
  for (const opportunityCandidate of opportunityCandidates.slice(0, OPPORTUNITY_LIMITS.maxOpportunities)) {
    let accepted = false;
    let detailReason = "invalid opportunity detail";
    for (let attempt = 0; attempt < OPPORTUNITY_LIMITS.maxCandidateAttempts && inferenceCalls < maxTurns; attempt++) {
      let raw = "";
      try {
        raw = await call(() => askCandidateDetail(baseUrl, model, mission, settings, language, opportunityCandidate, sources, inference));
        const detail = parseOpportunityDetail(raw, opportunityCandidate, settings.budgetEur, sources.length);
        valid.push(detail);
        accepted = true;
        options.onEvent?.(`opportunity: ${opportunityCandidate.name} validated`);
        break;
      } catch (error) {
        detailReason = error instanceof Error ? error.message : "invalid opportunity detail";
        if (debug === "1" && raw) console.error(raw);
        options.onEvent?.(`ERROR: opportunity ${opportunityCandidate.name} rejected (${detailReason})`);
        // A slow candidate must not consume the rest of the run or invalidate
        // candidates already validated. Move on immediately after a timeout.
        if (isTimeoutError(error)) break;
      }
    }
    if (!accepted && inferenceCalls >= maxTurns) {
      options.onEvent?.(`ERROR: model-call budget exhausted after candidate ${opportunityCandidate.name}`);
      break;
    }
  }

  // The report phase is runtime-controlled and does not ask the model for a
  // second large prose response. It can therefore complete with zero valid
  // candidates or with the valid subset when one candidate failed.
  const ranked = rankOpportunities(valid, settings.budgetEur);
  const body = buildOpportunityReport(ranked, settings.budgetEur, mission, language, sources.length, sources.map(source => source.url));
  const report = web.report(body);
  if (!validReportContent(body, mission) || !validReportContent(report, mission) || !reportMatchesLanguage(body, language) || !reportMatchesLanguage(report, language)) {
    throw new Error("Opportunity report validation failed");
  }
  const structured = JSON.stringify({ budget_eur: settings.budgetEur, opportunities: ranked }, null, 2) + "\n";
  const opportunityWrite = await execute("write_file", { path: "opportunities.json", content: structured });
  options.onEvent?.(`write_file opportunities.json: ${opportunityWrite.startsWith("ERROR:") ? opportunityWrite : "completed"}`);
  if (!opportunityWrite.startsWith("File written:")) throw new Error("Opportunity JSON write failed");
  const opportunityRead = await execute("read_file", { path: "opportunities.json" });
  if (opportunityRead !== structured) throw new Error("Opportunity JSON verification failed");
  const reportWrite = await execute("write_file", { path: "rapport.txt", content: report });
  options.onEvent?.(`write_file rapport.txt: ${reportWrite.startsWith("ERROR:") ? reportWrite : "completed"}`);
  if (!reportWrite.startsWith("File written:")) throw new Error("Opportunity report write failed");
  const reportRead = await execute("read_file", { path: "rapport.txt" });
  if (reportRead !== report || !validReportContent(reportRead, mission) || !reportMatchesLanguage(reportRead, language)) throw new Error("Opportunity report verification failed");
  options.onEvent?.("Scout completed: opportunities.json and rapport.txt verified.");
}

/** Explicit mode parsing used by the CLI; no implicit mode or fallback. */
export function scoutMode(env: Record<string, string | undefined> = process.env): "local" | "opportunity" {
  const value = env.SCOUT_MODE ?? "local";
  if (value !== "local" && value !== "opportunity") throw new Error("SCOUT_MODE must be local or opportunity");
  return value;
}
