import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { progressiveModel, selectBlock, LIMITS } from '../../experiments/v14-6-1/progressive.js';
import { diagnoseContent, observeModel, withOllamaMetrics, type Diagnostic } from '../../experiments/v14-6-1/diagnostics.js';
import { frozenNetwork, runArm, scriptedModel } from '../../experiments/v14-6-1/benchmark.js';
import { SCENARIOS, QUICK } from '../../experiments/v14-6-1/corpus.js';
import { controlledResearch, localResearchModel } from '../agent/research-controller.js';
import { coordinatePreview } from '../agent/coordination-preview.js';
import { parseCoordinationInput } from '../agent/coordination-model.js';
import { fixtureModel, fixtureNetwork } from './scout-research-fixtures.js';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
const signal = () => new AbortController().signal;
const candidatePrompt = (index = 0, text: string = SCENARIOS[0].texts[0]) =>
  `PUBLIC MISSION: Services en France\nUNTRUSTED READ EVIDENCE: ${JSON.stringify([{ index, source_id: `research-source-${index + 1}`, text }])}\nReturn exact candidates.`;
const context = (phase: string, quote: string = QUICK) => `PUBLIC MISSION: Services en France\nCandidate: {"name":"Correction de textes","kind":"QUICK_SERVICE","source_index":0}\nUNTRUSTED READ PAGE: ${SCENARIOS[0].texts[0]}\nReturn ${phase}: ${quote}`;

describe('V14.6.1 preparatory source boundaries', () => {
  it('selects literal contiguous text with exact offsets and stable global index', () => {
    const text = 'Introduction générale. '.repeat(30) + SCENARIOS[0].texts[0];
    const block = selectBlock(text, 7, 'research-source-8');
    expect(block.index).toBe(7); expect(block.source_id).toBe('research-source-8');
    expect(block.text).toBe(text.slice(block.start, block.end)); expect(block.text.length).toBeLessThanOrEqual(250);
    expect(block.start).toBeGreaterThan(0); expect(selectBlock(text, 7, 'research-source-8')).toEqual(block);
  });
  it.each(['', 'x'.repeat(2401), 'Texte\u200bprivé', 'Texte\nligne'])(
    'refuses invalid source without normalization or fabricated text', text => expect(() => selectBlock(text, 0, 'research-source-1')).toThrow());
  it('preserves index 7 rather than renumbering a selected subset to 0', async () => {
    const ask = vi.fn(async () => '{"candidates":[{"name":"Correction de textes","kind":"QUICK_SERVICE","source_index":7}]}');
    const model = progressiveModel({ ask });
    expect(JSON.parse(await model.ask('candidates', candidatePrompt(7), signal())).candidates[0].source_index).toBe(7);
    expect(ask.mock.calls).toHaveLength(1);
  });
  it.each([-1, 0, 8, 10])('rejects cross-source or nonexistent index %s after extraction of source 7', async index => {
    const model = progressiveModel({ async ask() { return JSON.stringify({ candidates: [{ name: 'Correction de textes', kind: 'QUICK_SERVICE', source_index: index }] }); } });
    await expect(model.ask('candidates', candidatePrompt(7), signal())).rejects.toThrow();
  });
  it('rejects a forged source identity before calling the model', async () => {
    const ask = vi.fn(); const model = progressiveModel({ ask });
    await expect(model.ask('candidates', candidatePrompt(7).replace('research-source-8', 'research-source-1'), signal())).rejects.toThrow();
    expect(ask).not.toHaveBeenCalled();
  });
  it('refuses two candidates per extraction rather than silently trimming', async () => {
    const c = { name: 'Correction de textes', kind: 'QUICK_SERVICE', source_index: 0 };
    const model = progressiveModel({ async ask() { return JSON.stringify({ candidates: [c, c] }); } });
    await expect(model.ask('candidates', candidatePrompt(), signal())).rejects.toThrow();
  });
  it('rejects a quote present elsewhere on the page but absent from the transmitted block', async () => {
    let phase = 'candidates';
    const model = progressiveModel({ async ask() { return phase === 'candidates' ? '{"candidates":[{"name":"Correction de textes","kind":"QUICK_SERVICE","source_index":0}]}' :
      JSON.stringify({ market: 'Demande inconnue', platform: 'Distribution inconnue', fees: 'Frais inconnus', quote: 'Une citation cachée et non transmise au modèle.' }); } });
    await model.ask('candidates', candidatePrompt(), signal()); phase = 'evidence';
    await expect(model.ask('evidence', context('evidence'), signal())).rejects.toThrow();
    expect(model.calls.at(-1)?.diagnostic).toBe('CITATION_NOT_IN_BLOCK');
  });
  it('does not join separate quotations or normalize accents and whitespace', async () => {
    const model = progressiveModel({ async ask(phase) { return phase === 'candidates' ? '{"candidates":[]}' :
      JSON.stringify({ market: 'Demande inconnue', platform: 'Distribution inconnue', fees: 'Frais inconnus', quote: QUICK.replace('être', 'etre') }); } });
    await model.ask('candidates', candidatePrompt(), signal());
    await expect(model.ask('evidence', context('evidence'), signal())).rejects.toThrow();
  });
  it.each(['short', 'short name', 'why this deserves attention'])('retains V14.5 placeholder rejection: %s', async name => {
    const model = progressiveModel({ async ask() { return JSON.stringify({ candidates: [{ name, kind: 'QUICK_SERVICE', source_index: 0 }] }); } });
    await expect(model.ask('candidates', candidatePrompt(), signal())).rejects.toThrow();
  });
  it('retains output byte and private-data boundaries before aggregation', async () => {
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'fixture-secret-runtime-key-123456');
    for (const raw of ['x'.repeat(17000), '{"candidates":[],"secret":"fixture-secret-runtime-key-123456"}']) {
      const model = progressiveModel({ async ask() { return raw; } });
      await expect(model.ask('candidates', candidatePrompt(), signal())).rejects.toThrow();
      expect(model.calls[0].diagnostic).toBe('OUTPUT_BOUNDARY');
    }
  });
});

describe('finite budgets and no retry', () => {
  it('counts actual split requests, caps at twenty and makes no twenty-first call', async () => {
    const ask = vi.fn(async () => '{"capabilities":[]}'); const model = progressiveModel({ ask });
    for (let i = 0; i < 20; i++) await model.ask('tool_selection', 'Public opportunity', signal());
    await expect(model.ask('tool_selection', 'Public opportunity', signal())).rejects.toThrow();
    expect(ask).toHaveBeenCalledTimes(20); expect(model.calls.length).toBe(20);
  });
  it('rejects provenance from a query proposal that received no page evidence', async () => {
    const ask = vi.fn(async () => '{"intents":[{"family":"micro_service","focus":"market","evidence_index":0}]}');
    const model = progressiveModel({ ask });
    const prompt = 'PUBLIC MISSION: Services en France\nRound 2/3: approfondissement\nFamilies: micro_service\nFocus: market\nPrevious public searches: []\nUNTRUSTED EVIDENCE: []\nReturn exact intents.';
    await expect(model.ask('query_proposal', prompt, signal())).rejects.toThrow();
    expect(model.calls[0].diagnostic).toBe('SOURCE_INDEX'); expect(ask).toHaveBeenCalledTimes(1);
  });
  it('refuses oversized input and cumulative public-data budget', async () => {
    const ask = vi.fn(async () => '{"capabilities":[]}'); const model = progressiveModel({ ask });
    await expect(model.ask('tool_selection', 'a'.repeat(2401), signal())).rejects.toThrow();
    expect(ask).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i++) await model.ask('tool_selection', 'a'.repeat(2400), signal());
    await expect(model.ask('tool_selection', 'a', signal())).rejects.toThrow(); expect(ask).toHaveBeenCalledTimes(10);
  });
  it('aborts a noncooperative injected model without a retry', async () => {
    const abort = new AbortController(); const ask = vi.fn(() => new Promise<string>(() => {}));
    const model = progressiveModel({ ask }); const pending = model.ask('tool_selection', 'Public', abort.signal);
    const check = expect(pending).rejects.toThrow(); abort.abort(); await check;
    expect(ask).toHaveBeenCalledTimes(0); // Abort wins before scheduled inference starts.
    await expect(model.ask('tool_selection', 'Public', abort.signal)).rejects.toThrow(); expect(model.calls).toHaveLength(1);
  });
  it('propagates cancellation after inference has started', async () => {
    const abort = new AbortController(); const ask = vi.fn(() => new Promise<string>(() => {}));
    const model = progressiveModel({ ask }); const pending = model.ask('tool_selection', 'Public', abort.signal);
    await Promise.resolve(); expect(ask).toHaveBeenCalledTimes(1);
    const check = expect(pending).rejects.toThrow(); abort.abort(); await check;
    expect(ask).toHaveBeenCalledTimes(1);
  });
  it('never retries malformed extraction', async () => {
    const ask = vi.fn(async () => '{'); const model = progressiveModel({ ask });
    await expect(model.ask('candidates', candidatePrompt(), signal())).rejects.toThrow(); expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe('diagnostics without source text or secrets', () => {
  it.each([
    ['', 'EMPTY_CONTENT'], ['{', 'JSON_INVALID'], ['{}', 'SCHEMA_INVALID'],
    ['{"candidates":[{"name":"short","kind":"QUICK_SERVICE","source_index":0}]}', 'PLACEHOLDER'],
  ])('distinguishes empty, syntax, schema and fillers', (raw, code) => expect(diagnoseContent('candidates', raw).diagnostic).toBe(code));
  it('observes the exact unmodified production request and numeric Ollama metrics', async () => {
    const requests: any[] = []; const content = '{"intents":[{"family":"micro_service","focus":"explore","evidence_index":null}]}';
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      requests.push(JSON.parse(init.body)); return new Response(JSON.stringify({ done: true, message: { content }, prompt_eval_count: 321, eval_count: 30, total_duration: 800 }));
    }));
    const model = localResearchModel('http://127.0.0.1:11434');
    await model.ask('query_proposal', 'Public', signal());
    const rows: Diagnostic[] = [];
    await withOllamaMetrics(rows, () => observeModel(model, rows).ask('query_proposal', 'Public', signal()));
    expect(requests[0]).toEqual(requests[1]);
    expect(rows[0]).toMatchObject({ prompt_tokens: 321, output_tokens: 30, ollama_total_ns: 800, json_valid: true });
    expect(JSON.stringify(rows)).not.toContain('messages'); expect(JSON.stringify(rows)).not.toContain(content);
  });
  it.each([
    [{ done: false, message: { content: '{"candidates":[]}' } }, 'TRUNCATED_OR_TOKEN_LIMIT'],
    [{ done: true, done_reason: 'length', message: { content: '{"candidates":[]}' } }, 'TRUNCATED_OR_TOKEN_LIMIT'],
    [{ message: { content: '' } }, 'EMPTY_CONTENT'], [{ message: { content: '{' } }, 'JSON_INVALID'],
    [{ error: 'private-server-secret' }, 'OLLAMA_ERROR'], [{ message: {} }, 'ENVELOPE_INVALID'],
  ])('records safe envelope classifications', async (envelope, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(envelope))));
    const rows: Diagnostic[] = [];
    await withOllamaMetrics(rows, async () => {
      try { await observeModel(localResearchModel('http://127.0.0.1:11434'), rows).ask('candidates', 'Public', signal()); } catch { /* baseline generic error retained */ }
    });
    expect(rows[0].diagnostic).toBe(code); expect(JSON.stringify(rows)).not.toContain('private-server-secret');
  });
  it('B refuses a completed-looking JSON when Ollama declares a token limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ done: true, done_reason: 'length', message: { content: '{"candidates":[]}' } }))));
    const rows: Diagnostic[] = [];
    await expect(withOllamaMetrics(rows, () => observeModel(localResearchModel('http://127.0.0.1:11434'), rows, true).ask('candidates', 'Public', signal()))).rejects.toThrow();
    expect(rows[0].diagnostic).toBe('TRUNCATED_OR_TOKEN_LIMIT');
  });
  it.each(['http', 'transport', 'envelope', 'bytes', 'timeout'])('never logs raw %s errors', async kind => {
    const abort = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (kind === 'http') return new Response('private-server-secret', { status: 500 });
      if (kind === 'envelope') return new Response('private-server-secret');
      if (kind === 'bytes') return new Response('x'.repeat(17000));
      if (kind === 'timeout') abort.abort();
      throw new Error('private-server-secret');
    }));
    const rows: Diagnostic[] = [];
    await expect(withOllamaMetrics(rows, () => observeModel(localResearchModel('http://127.0.0.1:11434'), rows).ask('candidates', 'Public', abort.signal))).rejects.toThrow();
    const expected = { http: 'HTTP_ERROR', transport: 'TRANSPORT_ERROR', envelope: 'ENVELOPE_JSON_INVALID', bytes: 'RESPONSE_BYTE_LIMIT', timeout: 'TIMEOUT_OR_PARENT_ABORT' };
    expect(rows[0].diagnostic).toBe(expected[kind as keyof typeof expected]);
    expect(JSON.stringify(rows)).not.toContain('private-server-secret');
  });
  it('uses the compact B system while preserving the model, options, JSON mode and two-message boundary', async () => {
    let request: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      request = JSON.parse(init.body);
      return new Response(JSON.stringify({ done: true, message: { content: '{"candidates":[]}' } }));
    }));
    const rows: Diagnostic[] = [];
    await withOllamaMetrics(rows, () => observeModel(localResearchModel('http://127.0.0.1:11434'), rows, true).ask('candidates', 'Public', signal()), { progressiveContext: true });
    expect(request.model).toBe('qwen2.5:1.5b-instruct'); expect(request.format).toBe('json');
    expect(request.options).toMatchObject({ temperature: 0, num_ctx: 2048, num_predict: 256 });
    expect(request.messages).toHaveLength(2); expect(request.tools).toBeUndefined();
    expect(request.messages[0].content).toContain('UNTRUSTED DATA'); expect(request.messages[0].content).toContain('No tools or actions');
    expect(request.messages[1].content).toBe('Public'); expect(request.think).toBeUndefined();
  });
  it('refuses an over-budget B context before any transport', async () => {
    vi.stubEnv('SCOUT_NUM_CTX', '512'); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const rows: Diagnostic[] = [];
    await expect(withOllamaMetrics(rows, () => observeModel(localResearchModel('http://127.0.0.1:11434'), rows, true).ask('candidates', 'Public', signal()), { progressiveContext: true })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled(); expect(rows[0].diagnostic).toBe('CONTEXT_BUDGET_REFUSED');
  });
  it('counts UTF8 bytes rather than assuming a non-Latin character is a token', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const rows: Diagnostic[] = [];
    await expect(withOllamaMetrics(rows, () => observeModel(localResearchModel('http://127.0.0.1:11434'), rows, true).ask('candidates', '界'.repeat(700), signal()), { progressiveContext: true })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled(); expect(rows[0].diagnostic).toBe('CONTEXT_BUDGET_REFUSED');
  });
  it('restores fetch even after an inference failure', async () => {
    const original = globalThis.fetch;
    await expect(withOllamaMetrics([], async () => { throw new Error('safe'); })).rejects.toThrow();
    expect(globalThis.fetch).toBe(original);
  });
});

describe('A/B scripted fault tests: no real-model or economic-performance claims', () => {
  it.each(SCENARIOS)('runs the same frozen $id corpus and preserves all execution locks', async scenario => {
    for (const variant of ['A', 'B'] as const) {
      const run = await runArm(scenario, variant, scriptedModel(scenario));
      expect(run.model_calls).toBe(run.calls.length); expect(run.model_calls).toBeLessThanOrEqual(20);
      expect(run.verified_citations).toBe(run.scout_contracts_accepted);
      expect(run.observed_security_flag_violations).toBe(0); expect(run.execution_authorized_count).toBe(0);
      expect(run.economically_exploitable).toBeNull(); expect(run.prompt_tokens).toBeNull();
      expect(run.coordinator_model_calls).toBe(0);
      if (run.status === 'BLOCKED') expect(run.coordinator_status).toBe('BLOCKED');
      if (variant === 'B') expect(run.max_input_chars).toBeLessThanOrEqual(LIMITS.inputChars);
    }
  });
  it('rejects the selling-price economic false positive without changing the original validator', async () => {
    const scenario = SCENARIOS.find(s => s.trap)!;
    const a = await runArm(scenario, 'A', scriptedModel(scenario)); const b = await runArm(scenario, 'B', scriptedModel(scenario));
    expect(a.economic_false_positives_fixture_oracle).toBe(1); expect(b.economic_false_positives_fixture_oracle).toBe(0);
    expect(b.progressive_refusals.some(r => r.diagnostic === 'ECONOMIC_EVIDENCE_INSUFFICIENT')).toBe(true);
  });
  it('unknown costs remain unknown and cannot become free or executable', async () => {
    const scenario = SCENARIOS.find(s => s.fault === 'unknown')!;
    const model = progressiveModel(scriptedModel(scenario));
    const output = await controlledResearch({ model, ...frozenNetwork(scenario) });
    expect(output.opportunities).toHaveLength(2);
    for (const o of output.opportunities) expect(o).toMatchObject({ cost_basis: 'UNKNOWN', estimated_cost_cents: null, classification: 'COST_UNCONFIRMED', execution_authorized: false });
  });
  it('keeps V14.6 compatibility and BLOCKED refusal without any extra model call', async () => {
    const output = await controlledResearch({ model: fixtureModel(), ...fixtureNetwork() });
    expect(parseCoordinationInput(JSON.stringify(output)).research.status).toBe('PASS');
    output.status = 'BLOCKED'; output.reason = 'PUBLIC_MODEL_OR_CONFIGURATION_BLOCKED';
    const ask = vi.fn(); const preview = await coordinatePreview(JSON.stringify(output), { ask });
    expect(preview.status).toBe('BLOCKED'); expect(ask).not.toHaveBeenCalled();
  });
  it('leaves experiment modules unreachable from the normal entry point', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(index).not.toContain('v14-6-1'); expect(index).not.toContain('progressiveModel');
  });
});
