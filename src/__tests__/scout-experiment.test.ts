import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildExperimentReport,
  computeRequiresHumanApproval,
  loadExperimentSettings,
  parseExperimentActions,
  parseExperimentCriteria,
  parseExperimentHypothesis,
  parseOpportunitiesFile,
  runExperimentScout,
  selectBestOpportunity,
  type ExperimentPlan,
} from "../agent/experiment-runner.js";
import { rankOpportunities, type OpportunityDraft } from "../agent/opportunity-scout.js";
import { DEFAULT_SCOUT_MODEL, localOllamaUrl } from "../agent/local-runner.js";

function validOpportunity(name: string, cost = 0): OpportunityDraft {
  return {
    name,
    summary: "Une hypothèse testable avec peu de coûts et un risque explicite.",
    startup_cost_eur: cost,
    time_to_first_revenue_days: 14,
    weekly_time_hours: 5,
    difficulty_1_5: 2,
    risk_1_5: 2,
    margin_potential_1_5: 4,
    scalability_1_5: 3,
    requires_account: false,
    requires_paid_service: false,
    key_risks: ["Demande locale à vérifier"],
    first_three_steps: ["Parler à trois personnes", "Proposer un test manuel", "Mesurer les réponses"],
    evidence_source_indexes: [0],
  };
}

function opportunitiesArtifact(): string {
  const opportunities = rankOpportunities([
    validOpportunity("Option A", 5),
    { ...validOpportunity("Option B", 0), risk_1_5: 1, margin_potential_1_5: 5, scalability_1_5: 5, difficulty_1_5: 1 },
  ], 100);
  return JSON.stringify({ budget_eur: 100, opportunities }, null, 2) + "\n";
}

function ollamaReply(value: unknown): Response {
  return new Response(JSON.stringify({ message: { content: JSON.stringify(value) } }), { status: 200 });
}

let temp: string;
let root: string;
beforeEach(async () => {
  for (const name of ["SCOUT_MODE", "SCOUT_EXPERIMENT_BUDGET_EUR", "SCOUT_NUM_CTX", "SCOUT_NUM_PREDICT", "SCOUT_TIMEOUT_MS", "SCOUT_DEBUG_ACTIONS"]) vi.stubEnv(name, undefined);
  vi.stubEnv("SCOUT_MODE", "experiment");
  temp = await mkdtemp(path.join(os.tmpdir(), "scout-experiment-test-"));
  root = path.join(temp, "workspace");
  await mkdir(root);
  await writeFile(path.join(root, "MISSION.txt"), "Préparer un plan d'expérience en français.");
  await writeFile(path.join(root, "opportunities.json"), opportunitiesArtifact());
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(temp, { recursive: true, force: true });
});

describe("Scout V4 artifact and plan validation", () => {
  it("loads a valid artifact and selects the best deterministic score", () => {
    const parsed = parseOpportunitiesFile(opportunitiesArtifact());
    expect(parsed.opportunities).toHaveLength(2);
    expect(selectBestOpportunity(parsed.opportunities).name).toBe("Option B");
  });

  it("rejects malformed, extra-field and stale-score artifacts", () => {
    const parsed = JSON.parse(opportunitiesArtifact()) as { budget_eur: number; opportunities: Record<string, unknown>[] };
    expect(() => parseOpportunitiesFile(JSON.stringify({ budget_eur: 100, opportunities: [] }))).toThrow();
    expect(() => parseOpportunitiesFile(JSON.stringify({ ...parsed, extra: true }))).toThrow();
    expect(() => parseOpportunitiesFile(JSON.stringify({ ...parsed, opportunities: [{ ...parsed.opportunities[0], score: 1 }] }))).toThrow();
    expect(() => parseOpportunitiesFile(JSON.stringify({ ...parsed, opportunities: [{ ...parsed.opportunities[0], evidence_source_indexes: ["https://example.com"] }] }))).toThrow();
  });

  it("bounds the planning budget and never lets it exceed V3", () => {
    expect(loadExperimentSettings({})).toEqual({ experimentBudgetEur: 10 });
    expect(loadExperimentSettings({ SCOUT_EXPERIMENT_BUDGET_EUR: "0" }, 5)).toEqual({ experimentBudgetEur: 0 });
    expect(() => loadExperimentSettings({ SCOUT_EXPERIMENT_BUDGET_EUR: "11" }, 100)).toThrow();
    expect(() => loadExperimentSettings({ SCOUT_EXPERIMENT_BUDGET_EUR: "10" }, 5)).toThrow("V3 budget");
    for (const value of ["", "-1", "+1", "01", "1.5", "1e1", " 1"]) {
      expect(() => loadExperimentSettings({ SCOUT_EXPERIMENT_BUDGET_EUR: value }, 100)).toThrow();
    }
  });

  it("strictly validates short phase schemas, bounds and booleans", () => {
    expect(parseExperimentHypothesis(JSON.stringify({ hypothesis: "Tester la demande sans dépense." }))).toContain("Tester");
    expect(parseExperimentActions(JSON.stringify({ actions: ["Parler à trois personnes"] }))).toHaveLength(1);
    expect(() => parseExperimentActions(JSON.stringify({ actions: ["https://example.com"] }))).toThrow();
    expect(() => parseExperimentActions(JSON.stringify({ actions: ["The experiment was already completed"] }))).toThrow();
    expect(parseExperimentCriteria(JSON.stringify({ duration_days: 1, success_metrics: ["Trois réponses"], stop_conditions: ["Aucune réponse"], expected_learning: "Comprendre la demande.", requires_real_spending: false, requires_external_account: false, requires_publication: false })).duration_days).toBe(1);
    expect(() => parseExperimentCriteria(JSON.stringify({ duration_days: 8, success_metrics: ["x"], stop_conditions: ["y"], expected_learning: "z", requires_real_spending: false, requires_external_account: false, requires_publication: false }))).toThrow();
    expect(() => parseExperimentCriteria(JSON.stringify({ duration_days: 1, success_metrics: ["x"], stop_conditions: ["y"], expected_learning: "z", requires_real_spending: "false", requires_external_account: false, requires_publication: false }))).toThrow();
    expect(() => parseExperimentCriteria(JSON.stringify({ duration_days: 1, success_metrics: [], stop_conditions: ["y"], expected_learning: "z", requires_real_spending: false, requires_external_account: false, requires_publication: false }))).toThrow();
  });

  it("computes the approval gate from strict plan booleans", () => {
    expect(computeRequiresHumanApproval({ requires_real_spending: false, requires_external_account: false, requires_publication: false })).toBe(false);
    expect(computeRequiresHumanApproval({ requires_real_spending: true, requires_external_account: false, requires_publication: false })).toBe(true);
  });
});

describe("Scout V4 planning-only runner", () => {
  it("uses three small sequential calls and writes verified runtime artifacts", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ollamaReply({ hypothesis: "La demande peut être testée sans dépense." }))
      .mockResolvedValueOnce(ollamaReply({ actions: ["Parler à trois personnes", "Proposer un test manuel"] }))
      .mockResolvedValueOnce(ollamaReply({ duration_days: 3, success_metrics: ["Trois réponses mesurées"], stop_conditions: ["Aucune réponse après trois échanges"], expected_learning: "Comprendre si le problème est réel.", requires_real_spending: false, requires_external_account: false, requires_publication: false }));
    vi.stubGlobal("fetch", fetchMock);
    await runExperimentScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(call[1].body as string);
      expect(body.format).toBe("json");
      expect(body.options.num_predict).toBeLessThanOrEqual(128);
      expect(body.model).toBe(DEFAULT_SCOUT_MODEL);
    }
    const plan = JSON.parse(await readFile(path.join(root, "experiment.json"), "utf8"));
    expect(plan.version).toBe(4);
    expect(plan.status).toBe("planned");
    expect(plan.opportunity_name).toBe("Option B");
    expect(plan.opportunity_score).toBeGreaterThan(0);
    expect(plan.experiment_budget_eur).toBe(0);
    expect(plan.requires_human_approval).toBe(false);
    const report = await readFile(path.join(root, "experiment-report.txt"), "utf8");
    expect(report).toContain("Aucune dépense ni action externe n'a été exécutée par Scout.");
    expect(report).toContain("Option B");
  });

  it("retries one invalid phase output, then preserves strict sequencing", async () => {
    const events = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ollamaReply({ wrong: "field" }))
      .mockResolvedValueOnce(ollamaReply({ hypothesis: "Tester la demande localement." }))
      .mockResolvedValueOnce(ollamaReply({ actions: ["Interroger trois personnes"] }))
      .mockResolvedValueOnce(ollamaReply({ duration_days: 2, success_metrics: ["Trois réponses"], stop_conditions: ["Aucune réponse"], expected_learning: "Apprendre.", requires_real_spending: false, requires_external_account: false, requires_publication: false }));
    vi.stubGlobal("fetch", fetchMock);
    await runExperimentScout({ baseUrl: localOllamaUrl(), root, onEvent: events });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(events).toHaveBeenCalledWith(expect.stringContaining("experiment hypothesis: validated"));
  });

  it("stops after bounded retries and writes no experiment artifacts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ollamaReply({ wrong: "field" })));
    await expect(runExperimentScout({ baseUrl: localOllamaUrl(), root })).rejects.toThrow("bounded retries");
    await expect(readFile(path.join(root, "experiment.json"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(root, "experiment-report.txt"), "utf8")).rejects.toThrow();
  });

  it("marks a plan requiring spending as approval-gated while still doing no external action", async () => {
    vi.stubEnv("SCOUT_EXPERIMENT_BUDGET_EUR", "5");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(ollamaReply({ hypothesis: "Payer une petite annonce validerait la demande." }))
      .mockResolvedValueOnce(ollamaReply({ actions: ["Acheter une annonce"] }))
      .mockResolvedValueOnce(ollamaReply({ duration_days: 1, success_metrics: ["Mesurer trois réponses"], stop_conditions: ["Arrêter si le coût dépasse 5 euros"], expected_learning: "Mesurer la demande.", requires_real_spending: true, requires_external_account: false, requires_publication: false })));
    await runExperimentScout({ baseUrl: localOllamaUrl(), root });
    const plan = JSON.parse(await readFile(path.join(root, "experiment.json"), "utf8"));
    expect(plan.experiment_budget_eur).toBe(5);
    expect(plan.requires_real_spending).toBe(true);
    expect(plan.requires_human_approval).toBe(true);
    expect(plan.status).toBe("planned");
  });

  it("renders a bounded human-readable report without executing actions", () => {
    const plan: ExperimentPlan = {
      version: 4, status: "planned", opportunity_name: "Option", opportunity_score: 80,
      hypothesis: "Tester", experiment_budget_eur: 0, duration_days: 1,
      actions: ["Mesurer"], success_metrics: ["Une mesure"], stop_conditions: ["Arrêter"],
      expected_learning: "Apprendre", requires_real_spending: false,
      requires_external_account: false, requires_publication: false, requires_human_approval: false,
    };
    const report = buildExperimentReport(plan, "fr");
    expect(report).toContain("planification uniquement");
    expect(report).toContain("Actions");
    expect(report).toContain("Aucune dépense");
  });
});
