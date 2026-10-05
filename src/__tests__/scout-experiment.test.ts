import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildExperimentReport,
  computeRequiresHumanApproval,
  loadExperimentSettings,
  parseExperimentActions,
  parseExperimentCriteria,
  parseExperimentHypothesis,
  parseExperimentSuccessMetrics,
  parseExperimentStopConditions,
  parseExperimentExpectedLearning,
  parseExperimentDuration,
  parseExperimentRequirements,
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

const noRequirements = { requires_real_spending: false, requires_external_account: false, requires_publication: false };
const microPhases = [
  { name: "success_metrics", value: { success_metrics: ["Trois réponses mesurées"] }, parse: parseExperimentSuccessMetrics },
  { name: "stop_conditions", value: { stop_conditions: ["Aucune réponse après trois échanges"] }, parse: parseExperimentStopConditions },
  { name: "expected_learning", value: { expected_learning: "Comprendre si le problème est réel." }, parse: parseExperimentExpectedLearning },
  { name: "duration_days", value: { duration_days: 3 }, parse: parseExperimentDuration },
  { name: "requirements", value: noRequirements, parse: parseExperimentRequirements },
];

function validOutputs(): unknown[] {
  return [
    { hypothesis: "La demande peut être testée sans dépense." },
    { actions: ["Parler à trois personnes", "Proposer un test manuel"] },
    ...microPhases.map(phase => phase.value),
  ];
}

function mockOutputs(outputs: unknown[]) {
  const mock = vi.fn();
  for (const output of outputs) mock.mockResolvedValueOnce(ollamaReply(output));
  vi.stubGlobal("fetch", mock);
  return mock;
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
  it("uses seven small sequential calls and writes verified runtime artifacts", async () => {
    vi.stubEnv("SCOUT_NUM_PREDICT", "256");
    const fetchMock = mockOutputs(validOutputs());
    await runExperimentScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("http://127.0.0.1:11434/api/chat");
      expect(call[1].redirect).toBe("error");
      const body = JSON.parse(call[1].body as string);
      expect(body.format).toBe("json");
      expect(body.options.num_predict).toBeLessThanOrEqual(128);
      expect(body.model).toBe(DEFAULT_SCOUT_MODEL);
      expect(body.options.num_ctx).toBe(2048);
      expect(body.tools).toBeUndefined();
    }
    const plan = JSON.parse(await readFile(path.join(root, "experiment.json"), "utf8"));
    expect(plan.version).toBe(4);
    expect(plan.status).toBe("planned");
    expect(plan.opportunity_name).toBe("Option B");
    expect(plan.opportunity_score).toBeGreaterThan(0);
    expect(plan.experiment_budget_eur).toBe(0);
    expect(plan.requires_human_approval).toBe(false);
    expect(plan.duration_days).toBe(3);
    expect(plan.success_metrics).toEqual(microPhases[0].value.success_metrics);
    expect(plan.stop_conditions).toEqual(microPhases[1].value.stop_conditions);
    expect(plan.expected_learning).toEqual(microPhases[2].value.expected_learning);
    const report = await readFile(path.join(root, "experiment-report.txt"), "utf8");
    expect(report).toContain("Aucune dépense ni action externe n'a été exécutée par Scout.");
    expect(report).toContain("Option B");
    expect(await readFile(path.join(root, "opportunities.json"), "utf8")).toBe(opportunitiesArtifact());
    expect((await readdir(root)).sort()).toEqual(["MISSION.txt", "experiment-report.txt", "experiment.json", "opportunities.json"]);
  });

  it("retries one invalid phase output, then preserves strict sequencing", async () => {
    const events = vi.fn();
    const fetchMock = mockOutputs([{ wrong: "field" }, ...validOutputs()]);
    await runExperimentScout({ baseUrl: localOllamaUrl(), root, onEvent: events });
    expect(fetchMock).toHaveBeenCalledTimes(8);
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
    mockOutputs([
      { hypothesis: "Payer une petite annonce validerait la demande." },
      { actions: ["Acheter une annonce"] },
      ...microPhases.slice(0, 4).map(phase => phase.value),
      { ...noRequirements, requires_real_spending: true },
    ]);
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

describe("Scout V4.1 strict criteria micro-phases", () => {
  it.each(microPhases)("accepts only the minimal $name object", ({ value, parse }) => {
    expect(() => parse(JSON.stringify(value))).not.toThrow();
    for (const raw of ["not JSON", "{", "null", "[]", '"text"', "{}",
      JSON.stringify({ ...value, extra: true }), JSON.stringify({ ...value, tool: "write_file" }),
      JSON.stringify({ ...value, path: "MISSION.txt" }), JSON.stringify({ ...value, requires_human_approval: false })]) {
      expect(() => parse(raw)).toThrow();
    }
  });

  it("keeps array, text, duration and action limits strict", () => {
    for (const [field, parse] of [
      ["success_metrics", parseExperimentSuccessMetrics], ["stop_conditions", parseExperimentStopConditions],
    ] as const) {
      for (const value of [[], "text", [1], [""], ["x".repeat(241)], Array(6).fill("Mesurer"), ["https://example.com"]]) {
        expect(() => parse(JSON.stringify({ [field]: value }))).toThrow();
      }
    }
    for (const value of [0, 8, 1.5, "3", true, null]) {
      expect(() => parseExperimentDuration(JSON.stringify({ duration_days: value }))).toThrow();
    }
    for (const value of [1, 7]) expect(parseExperimentDuration(JSON.stringify({ duration_days: value }))).toBe(value);
    for (const value of [null, 3, [], "", "x".repeat(601)]) {
      expect(() => parseExperimentExpectedLearning(JSON.stringify({ expected_learning: value }))).toThrow();
    }
    for (const actions of [[], Array(6).fill("Mesurer"), ["x".repeat(241)], ["J'ai publié l'annonce"]]) {
      expect(() => parseExperimentActions(JSON.stringify({ actions }))).toThrow();
    }
  });

  it.each(Object.keys(noRequirements))("never defaults or coerces %s", field => {
    const missing: Record<string, unknown> = { ...noRequirements };
    delete missing[field];
    expect(() => parseExperimentRequirements(JSON.stringify(missing))).toThrow();
    for (const value of ["false", "true", 0, 1, null, []]) {
      expect(() => parseExperimentRequirements(JSON.stringify({ ...noRequirements, [field]: value }))).toThrow();
    }
  });

  it.each(microPhases)("retries only $name without repeating validated phases", async phase => {
    const outputs = validOutputs();
    const index = microPhases.indexOf(phase) + 2;
    outputs.splice(index, 0, { ...phase.value, extra: true });
    const fetchMock = mockOutputs(outputs);
    const events: string[] = [];
    await runExperimentScout({ baseUrl: localOllamaUrl(), root, onEvent: message => events.push(message) });
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(events.filter(event => event === `experiment ${phase.name}: validated`)).toHaveLength(1);
    expect(events.filter(event => event.startsWith(`ERROR: experiment ${phase.name} rejected`))).toHaveLength(1);
    expect(events.filter(event => event === "experiment hypothesis: validated")).toHaveLength(1);
    expect(events.filter(event => event === "experiment actions: validated")).toHaveLength(1);
    const retryBody = JSON.parse(fetchMock.mock.calls[index + 1][1].body);
    expect(retryBody.messages[1].content).toContain("Previous output was rejected");
    expect(retryBody.messages[1].content).toContain(phase.name === "requirements" ? "requires_real_spending" : phase.name);
  });

  it.each(microPhases)("fails closed when $name exhausts its retries", async phase => {
    const index = microPhases.indexOf(phase) + 2;
    const fetchMock = mockOutputs([...validOutputs().slice(0, index), {}, {}]);
    await expect(runExperimentScout({ baseUrl: localOllamaUrl(), root })).rejects.toThrow(`Experiment ${phase.name} exhausted`);
    expect(fetchMock).toHaveBeenCalledTimes(index + 2);
    expect((await readdir(root)).sort()).toEqual(["MISSION.txt", "opportunities.json"]);
  });

  it("waits for every validation before writing, with no concurrent model calls", async () => {
    const outputs = validOutputs();
    let active = false;
    const fetchMock = vi.fn(async () => {
      expect(active).toBe(false);
      active = true;
      expect((await readdir(root)).sort()).toEqual(["MISSION.txt", "opportunities.json"]);
      active = false;
      return ollamaReply(outputs.shift());
    });
    vi.stubGlobal("fetch", fetchMock);
    await runExperimentScout({ baseUrl: localOllamaUrl(), root });
    expect(outputs).toHaveLength(0);
    const plan = JSON.parse(await readFile(path.join(root, "experiment.json"), "utf8"));
    expect(plan.status).toBe("planned");
  });

  it("allows at most two attempts per phase and fourteen calls overall", async () => {
    const fetchMock = mockOutputs(validOutputs().flatMap(output => [{}, output]));
    await runExperimentScout({ baseUrl: localOllamaUrl(), root });
    expect(fetchMock).toHaveBeenCalledTimes(14);
  });

  it("honors a smaller global call budget and preserves existing artifacts on failure", async () => {
    await writeFile(path.join(root, "experiment.json"), "previous JSON");
    await writeFile(path.join(root, "experiment-report.txt"), "previous report");
    const fetchMock = mockOutputs(validOutputs());
    await expect(runExperimentScout({ baseUrl: localOllamaUrl(), root, maxTurns: 6 })).rejects.toThrow("requirements exhausted");
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(await readFile(path.join(root, "experiment.json"), "utf8")).toBe("previous JSON");
    expect(await readFile(path.join(root, "experiment-report.txt"), "utf8")).toBe("previous report");
  });

  it.each(Object.keys(noRequirements))("calculates approval in runtime for %s", async field => {
    const outputs = validOutputs();
    outputs[6] = { ...noRequirements, [field]: true };
    mockOutputs(outputs);
    await runExperimentScout({ baseUrl: localOllamaUrl(), root });
    const plan = JSON.parse(await readFile(path.join(root, "experiment.json"), "utf8"));
    expect(plan[field]).toBe(true);
    expect(plan.requires_human_approval).toBe(true);
  });

  it("retains runtime sensitive-action detection even with explicit false model flags", async () => {
    const outputs = validOutputs();
    outputs[1] = { actions: ["Acheter une annonce"] };
    mockOutputs(outputs);
    await runExperimentScout({ baseUrl: localOllamaUrl(), root });
    const plan = JSON.parse(await readFile(path.join(root, "experiment.json"), "utf8"));
    expect(plan.requires_real_spending).toBe(true);
    expect(plan.requires_human_approval).toBe(true);
    expect(plan.experiment_budget_eur).toBe(10);
  });

  it("keeps loopback and workspace confinement before model inference", async () => {
    const fetchMock = mockOutputs(validOutputs());
    await expect(runExperimentScout({ baseUrl: "https://example.com", root })).rejects.toThrow("loopback");
    await writeFile(path.join(temp, "outside.json"), opportunitiesArtifact());
    await rm(path.join(root, "opportunities.json"));
    await symlink(path.join(temp, "outside.json"), path.join(root, "opportunities.json"));
    await expect(runExperimentScout({ baseUrl: localOllamaUrl(), root })).rejects.toThrow("readable opportunities.json");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps rejected micro-phase output in optional local debug only", async () => {
    vi.stubEnv("SCOUT_DEBUG_ACTIONS", "1");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const outputs = validOutputs();
    const rejected = { expected_learning: "private rejected text", extra: true };
    outputs.splice(4, 0, rejected);
    const fetchMock = mockOutputs(outputs);
    await runExperimentScout({ baseUrl: localOllamaUrl(), root });
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(rejected));
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("http://127.0.0.1:11434/api/chat");
      expect(call[1].body).not.toContain("private rejected text");
    }
  });
});
