import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SafeWebClient, type HttpReply, type WebTransport } from "../scout-web/network.js";
import { WebResearchSession } from "../scout-web/session.js";
import {
  loadOpportunitySettings, parseOpportunityAnalysis, parseOpportunityCandidates, parseOpportunityDetail,
  rankOpportunities, runOpportunityScout, scoreOpportunity, scoutMode, type OpportunityDraft,
} from "../agent/opportunity-scout.js";
import { DEFAULT_SCOUT_MODEL, localOllamaUrl } from "../agent/local-runner.js";

const publicIp = { address: "93.184.216.34", family: 4 };
function reply(text: string, contentType = "text/plain", status = 200): HttpReply {
  return { status, headers: { "content-type": contentType }, body: (async function* () { yield Buffer.from(text); })(), close: vi.fn() };
}
function transportFor(text = "Evidence from a public page."): WebTransport {
  return {
    resolve: vi.fn().mockResolvedValue([publicIp]),
    get: vi.fn().mockImplementation(async (url: URL) => reply(url.hostname === "search.example" ? '{"ok":true}' : text, url.hostname === "search.example" ? "application/json" : "text/plain")),
  };
}
function validOpportunity(source = 0): OpportunityDraft {
  return {
    name: "Service de proximité", summary: "Une option testable avec peu de coûts et des risques explicites.",
    startup_cost_eur: 10, time_to_first_revenue_days: 14, weekly_time_hours: 6,
    difficulty_1_5: 2, risk_1_5: 2, margin_potential_1_5: 4, scalability_1_5: 3,
    requires_account: false, requires_paid_service: false,
    key_risks: ["Demande locale non confirmée"],
    first_three_steps: ["Parler à trois clients", "Proposer un test manuel", "Mesurer les réponses"],
    evidence_source_indexes: [source],
  };
}
function validDetail(overrides: Partial<Omit<OpportunityDraft, "name" | "evidence_source_indexes">> = {}) {
  const { name: _name, evidence_source_indexes: _sources, ...detail } = validOpportunity();
  return { ...detail, ...overrides };
}
function ollamaReply(value: unknown): Response {
  return new Response(JSON.stringify({ message: { content: JSON.stringify(value) } }), { status: 200 });
}

let temp: string;
let root: string;
beforeEach(async () => {
  for (const name of ["SCOUT_NUM_CTX", "SCOUT_NUM_PREDICT", "SCOUT_TIMEOUT_MS", "SCOUT_DEBUG_ACTIONS", "SCOUT_BUDGET_EUR", "SCOUT_COUNTRY", "SCOUT_CONTEXT", "SCOUT_PUBLIC_QUERIES", "SCOUT_PUBLIC_URLS", "SCOUT_SEARCH_PROVIDER", "SCOUT_SEARXNG_URL"]) vi.stubEnv(name, undefined);
  temp = await mkdtemp(path.join(os.tmpdir(), "scout-opportunity-test-"));
  root = path.join(temp, "workspace");
  await mkdir(root);
  vi.stubEnv("SCOUT_MODE", "opportunity");
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(temp, { recursive: true, force: true }); });

describe("Scout V3 opportunity data validation", () => {
  it("requires explicit, known modes and keeps local as the default", () => {
    expect(scoutMode({})).toBe("local");
    expect(scoutMode({ SCOUT_MODE: "opportunity" })).toBe("opportunity");
    expect(() => scoutMode({ SCOUT_MODE: "remote" })).toThrow("SCOUT_MODE");
  });

  it("uses a positive bounded budget and rejects noncanonical values", () => {
    expect(loadOpportunitySettings({})).toEqual({ budgetEur: 100, country: undefined, context: undefined });
    expect(loadOpportunitySettings({ SCOUT_BUDGET_EUR: "10000", SCOUT_COUNTRY: "France", SCOUT_CONTEXT: "test local" }).budgetEur).toBe(10000);
    for (const value of ["", "0", "-1", "+10", "10.0", "01", "10001", "1e2", " 100"]) {
      expect(() => loadOpportunitySettings({ SCOUT_BUDGET_EUR: value })).toThrow("SCOUT_BUDGET_EUR");
    }
    expect(() => loadOpportunitySettings({ SCOUT_CONTEXT: "bad\ncontext" })).toThrow("SCOUT_CONTEXT");
  });

  it("strictly validates costs, scores, evidence indexes and extra properties", () => {
    const valid = { opportunities: [validOpportunity()] };
    expect(parseOpportunityAnalysis(JSON.stringify(valid), 100, 1).opportunities).toHaveLength(1);
    expect(() => parseOpportunityAnalysis(JSON.stringify({ opportunities: [{ ...validOpportunity(), startup_cost_eur: 101 }] }), 100, 1)).toThrow();
    expect(() => parseOpportunityAnalysis(JSON.stringify({ opportunities: [{ ...validOpportunity(), risk_1_5: 6 }] }), 100, 1)).toThrow();
    expect(() => parseOpportunityAnalysis(JSON.stringify({ opportunities: [{ ...validOpportunity(), evidence_source_indexes: [1] }] }), 100, 1)).toThrow();
    expect(() => parseOpportunityAnalysis(JSON.stringify({ opportunities: [{ ...validOpportunity(), extra: "no" }] }), 100, 1)).toThrow();
    expect(() => parseOpportunityAnalysis("not json", 100, 1)).toThrow();
  });

  it("uses a compact candidate contract and never accepts a candidate URL", () => {
    expect(parseOpportunityCandidates(JSON.stringify({ candidates: ["A", { name: "B" }] }))).toEqual([{ name: "A" }, { name: "B" }]);
    expect(() => parseOpportunityCandidates(JSON.stringify({ candidates: ["https://example.com"] }))).toThrow();
    expect(() => parseOpportunityCandidates(JSON.stringify({ candidates: ["A", "a"] }))).toThrow();
    expect(() => parseOpportunityCandidates(JSON.stringify({ candidates: ["A", "B", "C", "D"] }))).toThrow();
    expect(() => parseOpportunityCandidates(JSON.stringify({ candidates: [{ name: "A", url: "https://example.com" }] }))).toThrow();
  });

  it("keeps detail scores integer-only and evidence indexes numeric", () => {
    const candidate = { name: "A" };
    expect(parseOpportunityDetail(JSON.stringify(validDetail()), candidate, 100, 2).evidence_source_indexes).toEqual([0, 1]);
    expect(() => parseOpportunityDetail(JSON.stringify({ ...validDetail(), margin_potential_1_5: 0.2 }), candidate, 100, 2)).toThrow();
    expect(() => parseOpportunityDetail(JSON.stringify({ ...validDetail(), evidence_source_indexes: ["https://example.com"] }), { name: "A" }, 100, 2)).toThrow();
  });

  it("computes a deterministic score and stable descending order", () => {
    const low = validOpportunity();
    const high = { ...validOpportunity(), name: "Rapide et robuste", startup_cost_eur: 0, time_to_first_revenue_days: 3, risk_1_5: 1, margin_potential_1_5: 5, scalability_1_5: 5, difficulty_1_5: 1 };
    expect(scoreOpportunity(high, 100)).toBeGreaterThan(scoreOpportunity(low, 100));
    expect(scoreOpportunity(high, 100)).toBeLessThanOrEqual(100);
    expect(rankOpportunities([low, high], 100).map(item => item.name)).toEqual(["Rapide et robuste", "Service de proximité"]);
  });
});

describe("Scout V3 deterministic Web-to-report path", () => {
  it("searches and reads sources before one analysis call, then writes both artifacts", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Analyser des opportunités en français.");
    const transport = transportFor("Données publiques sur le marché local.");
    const provider = { search: vi.fn(async (_query: string, client: SafeWebClient) => {
      await client.readSearchJson("https://search.example/");
      return { consultedUrl: "https://search.example/", results: [{ title: "Source", url: "https://source.example/article", snippet: "Public" }] };
    }) };
    const web = new WebResearchSession({ queries: ["opportunités locales"], urls: [] }, new SafeWebClient(transport), provider);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ollamaReply({ candidates: ["Service de proximité"] }))
      .mockResolvedValueOnce(ollamaReply(validDetail()));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SCOUT_NUM_PREDICT", "1024");
    const events = vi.fn();
    await runOpportunityScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root, webSession: web, onEvent: events });
    expect(provider.search).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).format).toBe("json");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).options.num_predict).toBeLessThanOrEqual(128);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).options.num_predict).toBeLessThanOrEqual(256);
    expect(await readFile(path.join(root, "opportunities.json"), "utf8")).toContain('"budget_eur": 100');
    expect(JSON.parse(await readFile(path.join(root, "opportunities.json"), "utf8")).opportunities[0].evidence_source_indexes).toEqual([0]);
    const report = await readFile(path.join(root, "rapport.txt"), "utf8");
    expect(report).toContain("Budget analysé : 100 €");
    expect(report).toContain("Sources\n- https://search.example/");
    expect(report).toContain("https://source.example/article");
    expect(events).toHaveBeenCalledWith("Scout completed: opportunities.json and rapport.txt verified.");
  });

  it("supports a no-viable-opportunity result without inventing a source", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Analyser en français.");
    const web = new WebResearchSession({ queries: [], urls: ["https://example.com/source"] }, new SafeWebClient(transportFor()));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ollamaReply({ candidates: [] })));

    await runOpportunityScout({ baseUrl: localOllamaUrl(), root, webSession: web });
    expect(JSON.parse(await readFile(path.join(root, "opportunities.json"), "utf8")).opportunities).toEqual([]);
    expect(await readFile(path.join(root, "rapport.txt"), "utf8")).toContain("Aucune opportunité viable");
  });

  it("runs at most three candidate analyses sequentially", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Analyser en français.");
    const web = new WebResearchSession({ queries: [], urls: ["https://example.com/source"] }, new SafeWebClient(transportFor()));
    const responses = [
      ollamaReply({ candidates: ["A", "B", "C"] }),
      ollamaReply(validDetail()), ollamaReply(validDetail()), ollamaReply(validDetail()),
    ];
    let active = 0;
    const fetchMock = vi.fn(async () => {
      expect(active).toBe(0);
      active++;
      await Promise.resolve();
      const response = responses.shift()!;
      active--;
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    await runOpportunityScout({ baseUrl: localOllamaUrl(), root, webSession: web });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(await readFile(path.join(root, "opportunities.json"), "utf8")).opportunities).toHaveLength(3);
  });

  it("retries invalid analysis without repeating Web, then succeeds", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Analyser en français.");
    const transport = transportFor();
    const provider = { search: vi.fn(async (_query: string, client: SafeWebClient) => {
      await client.readSearchJson("https://search.example/");
      return { consultedUrl: "https://search.example/", results: [{ title: "Source", url: "https://source.example/article", snippet: "Public" }] };
    }) };
    const web = new WebResearchSession({ queries: ["public"], urls: [] }, new SafeWebClient(transport), provider);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ollamaReply({ candidates: ["Service de proximité"] }))
      .mockResolvedValueOnce(ollamaReply(validDetail({ margin_potential_1_5: 0.2 })))
      .mockResolvedValueOnce(ollamaReply(validDetail()));
    vi.stubGlobal("fetch", fetchMock);
    await runOpportunityScout({ baseUrl: localOllamaUrl(), root, webSession: web, maxTurns: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(provider.search).toHaveBeenCalledOnce();
  });

  it("stops after bounded invalid-analysis attempts without writing a report", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Analyser en français.");
    const web = new WebResearchSession({ queries: [], urls: ["https://example.com/source"] }, new SafeWebClient(transportFor()));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ollamaReply({ candidates: ["A"] }))
      .mockResolvedValueOnce(ollamaReply(validDetail({ margin_potential_1_5: 0.2 })))
      .mockResolvedValueOnce(ollamaReply(validDetail({ margin_potential_1_5: 0.2 })));
    vi.stubGlobal("fetch", fetchMock);
    await runOpportunityScout({ baseUrl: localOllamaUrl(), root, webSession: web, maxTurns: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(await readFile(path.join(root, "opportunities.json"), "utf8")).opportunities).toEqual([]);
    expect(await readFile(path.join(root, "rapport.txt"), "utf8")).toContain("Aucune opportunité viable");
  });

  it("skips a timed-out candidate and preserves the next valid candidate", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Analyser en français.");
    const web = new WebResearchSession({ queries: [], urls: ["https://example.com/source"] }, new SafeWebClient(transportFor()));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ollamaReply({ candidates: ["Lent", "Valide"] }))
      .mockRejectedValueOnce(new DOMException("candidate timed out", "TimeoutError"))
      .mockResolvedValueOnce(ollamaReply(validDetail()));
    vi.stubGlobal("fetch", fetchMock);
    await runOpportunityScout({ baseUrl: localOllamaUrl(), root, webSession: web });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const output = JSON.parse(await readFile(path.join(root, "opportunities.json"), "utf8"));
    expect(output.opportunities).toHaveLength(1);
    expect(output.opportunities[0].name).toBe("Valide");
  });

  it("fails closed on Web search and never asks Ollama", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Analyser.");
    const provider = { search: vi.fn().mockRejectedValue(new Error("blocked")) };
    const web = new WebResearchSession({ queries: ["public"], urls: [] }, new SafeWebClient(transportFor()), provider);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(runOpportunityScout({ baseUrl: localOllamaUrl(), root, webSession: web })).rejects.toThrow("search failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
