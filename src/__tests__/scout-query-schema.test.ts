import { afterEach, describe, expect, it, vi } from "vitest";
import { localResearchModel } from "../agent/research-controller.js";
import { FAMILIES, FOCUSES, parseIntents } from "../agent/research-model.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const validReply = '{"intents":[{"family":"micro_service","focus":"market","evidence_index":null}]}';

function mockOllama() {
  const requests: Record<string, any>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ message: { content: validReply } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }));
  return requests;
}

describe("Scout - Ollama query proposal schema", () => {
  it("applies a bounded schema to query proposals", async () => {
    const requests = mockOllama();
    const raw = await localResearchModel("http://127.0.0.1:11434")
      .ask("query_proposal", "public mission", new AbortController().signal);
    expect(parseIntents(raw, 0)).toHaveLength(1);
    expect(requests).toHaveLength(1);
    const format = requests[0].format;
    expect(format.type).toBe("object");
    expect(format.additionalProperties).toBe(false);
    expect(format.required).toEqual(["intents"]);
    expect(format.properties.intents.minItems).toBe(1);
    expect(format.properties.intents.maxItems).toBe(2);
    const intent = format.properties.intents.items;
    expect(intent.additionalProperties).toBe(false);
    expect(intent.required).toEqual(["family", "focus", "evidence_index"]);
    expect(intent.properties.family.enum).toEqual(Object.keys(FAMILIES));
    expect(intent.properties.focus.enum).toEqual(Object.keys(FOCUSES));
    expect(intent.properties.evidence_index.type).toEqual(["integer", "null"]);
  });

  it("keeps unmodified JSON mode for economics and other phases", async () => {
    const requests = mockOllama();
    await localResearchModel("http://127.0.0.1:11434")
      .ask("economics", "public mission", new AbortController().signal);
    expect(requests).toHaveLength(1);
    expect(requests[0].format).toBe("json");
  });

  it("never adds remote tools, execution permissions or cloud endpoints", async () => {
    const requests = mockOllama();
    await localResearchModel("http://127.0.0.1:11434")
      .ask("query_proposal", "public mission", new AbortController().signal);
    expect(requests[0].tools).toBeUndefined();
    expect(requests[0].stream).toBe(false);
    expect(requests[0].options.temperature).toBe(0);
  });
});
