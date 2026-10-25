import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ECONOMIC_CASES, type EconomicCase } from '../../experiments/v14-6-1/economics-corpus.js';
import { baselineEconomics, optimizedEconomics, economicPassages, parseEconomics, guardEconomics,
  literalFacts, scoreEconomics, ECONOMIC_SYSTEM } from '../../experiments/v14-6-1/economics.js';
import { economicArm, economicScript } from '../../experiments/v14-6-1/economics-probe.js';
import { newMetrics, inspectEconomicEnvelope, abortDiagnostic, withEconomicTransport } from '../../experiments/v14-6-1/economics-metrics.js';
import { progressiveModel } from '../../experiments/v14-6-1/progressive.js';
import { observeModel, withOllamaMetrics } from '../../experiments/v14-6-1/diagnostics.js';
import { localResearchModel } from '../agent/research-controller.js';
import { PUBLIC_RESEARCH_MISSION, parseOpportunityPhases, assertResearchExecutable } from '../agent/research-model.js';
import { coordinatePreview } from '../agent/coordination-preview.js';
import { economicWireAudit } from '../../experiments/v14-6-1/economics-wire-audit.js';
import { fixtureModel, fixtureNetwork } from './scout-research-fixtures.js';
import { controlledResearch } from '../agent/research-controller.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
const settings = { numCtx: 2048, numPredict: 256, timeoutMs: 105000 };
const sig = () => new AbortController().signal;
const documented = ECONOMIC_CASES[0];
const result = { summary: 'Coût de 8 EUR, prix hypothétique; aucune vente ni rentabilité démontrée.',
  estimated_cost_cents: 800, cost_basis: 'SOURCE_ESTIMATE', human_minutes_daily: 15, account_required: true };
const raw = () => JSON.stringify(result);
const envelope = (content = raw(), fields = {}) => JSON.stringify({ message: { content }, done: true, done_reason: 'stop',
  prompt_eval_count: 333, eval_count: 78, total_duration: 500, load_duration: 100, prompt_eval_duration: 200, eval_duration: 200, ...fields });

describe('I3 unchanged A and strict economics contracts', () => {
  it.each(ECONOMIC_CASES)('A user bytes exactly reproduce I2 progressive economics: $id', async fixture => {
    let captured = '';
    const model = progressiveModel({ async ask(phase, data) {
      if (phase === 'candidates') return JSON.stringify({ candidates: [fixture.candidate] });
      captured = data; return JSON.stringify({ ...result, estimated_cost_cents: null, cost_basis: 'UNKNOWN' });
    } });
    const source = fixture.sources.find(s => s.index === fixture.candidate.source_index)!;
    await model.ask('candidates', `PUBLIC MISSION: ${PUBLIC_RESEARCH_MISSION}\nUNTRUSTED READ EVIDENCE: ${JSON.stringify([source])}\nReturn exact.`, sig());
    await model.ask('economics', `PUBLIC MISSION: ${PUBLIC_RESEARCH_MISSION}\nCandidate: ${JSON.stringify(fixture.candidate)}\nUNTRUSTED READ PAGE: original ignored\nReturn original ignored`, sig());
    expect(baselineEconomics(fixture)).toBe(captured);
  });
  it('A full Ollama request bytes match the I2 progressive observer', async () => {
    const sent: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { sent.push(String(init.body)); return new Response(envelope()); });
    const local = localResearchModel('http://127.0.0.1:11434');
    const oldRows: any[] = [];
    await withOllamaMetrics(oldRows, () => observeModel(local, oldRows).ask('economics', baselineEconomics(documented), sig()), { progressiveContext: true });
    const m = newMetrics(baselineEconomics(documented));
    await withEconomicTransport(m, sig(), () => local.ask('economics', baselineEconomics(documented), sig()));
    expect(sent).toHaveLength(2); expect(sent[0]).toBe(sent[1]);
    expect(JSON.parse(sent[1]).messages[0].content).toBe(ECONOMIC_SYSTEM);
  });
  it.each([
    ['empty', ''], ['syntax', '{'], ['array', '[]'], ['extra field', JSON.stringify({ ...result, execute: true })],
    ['missing field', JSON.stringify({ summary: 'Frais inconnus' })],
    ['string cost', JSON.stringify({ ...result, estimated_cost_cents: '800' })],
    ['negative cost', JSON.stringify({ ...result, estimated_cost_cents: -1 })],
    ['negative zero', raw().replace('800', '-0')], ['fractional cost', JSON.stringify({ ...result, estimated_cost_cents: 1.5 })],
    ['overflow', JSON.stringify({ ...result, estimated_cost_cents: 10001 })],
    ['bad enum', JSON.stringify({ ...result, cost_basis: 'FACT' })],
    ['unknown with amount', JSON.stringify({ ...result, cost_basis: 'UNKNOWN' })],
    ['source with null', JSON.stringify({ ...result, estimated_cost_cents: null })],
    ['minutes string', JSON.stringify({ ...result, human_minutes_daily: '15' })],
    ['minutes range', JSON.stringify({ ...result, human_minutes_daily: 481 })],
    ['account string', JSON.stringify({ ...result, account_required: 'false' })],
    ['long summary', JSON.stringify({ ...result, summary: 'a'.repeat(241) })],
    ['filler', JSON.stringify({ ...result, summary: 'short' })],
    ['private output', JSON.stringify({ ...result, summary: 'Contact client@exemple.fr' })],
    ['byte cap', 'a'.repeat(16385)],
  ])('rejects malformed contract without coercion: %s', (_name, value) => expect(() => parseEconomics(value)).toThrow());
  it('retains strict legacy citation and non-execution rules', () => {
    const text = documented.sources[0].text;
    const args = [documented.candidate, raw(), JSON.stringify({ market: 'Demande non confirmée', platform: 'Distribution inconnue', fees: 'Inclus dans le pilote', quote: 'Coût initial total du pilote : 8 EUR.' }),
      JSON.stringify({ risks: ['Aucune vente observée'], reason_surfaced: 'Pilote chiffré à examiner', mini_test_possible: false, mini_test_cost_cents: null, mini_test_description: 'Aucun test autorisé' }),
      [{ source_id: 'research-source-1', url: 'https://example.com/other', text: 'Autre source', query_id: 'q', round: 1 },
       { source_id: 'research-source-2', url: 'https://example.com/synthetic', text, query_id: 'q', round: 1 }], 0] as const;
    const opportunity = parseOpportunityPhases(...args);
    expect(opportunity.execution_authorized).toBe(false);
    expect(() => assertResearchExecutable(opportunity)).toThrow();
    expect(() => parseOpportunityPhases(args[0], args[1], args[2].replace('8 EUR', '9 EUR'), args[3], args[4], 0)).toThrow();
  });
});

describe('I3 evidence selection and conservative factual guards', () => {
  it.each(ECONOMIC_CASES)('keeps exact offsets and economically relevant clauses: $id', fixture => {
    const a = economicPassages(fixture), b = economicPassages(fixture);
    expect(a).toEqual(b);
    for (const p of a.passages) expect(fixture.sources.find(s => s.index === p.index)!.text.slice(p.start, p.end)).toBe(p.text);
    expect(optimizedEconomics(fixture).data).not.toContain(JSON.stringify(fixture.oracle));
  });
  it('retains contradictions and unknown fees outside the original 250-character block', () => {
    const fixture = structuredClone(ECONOMIC_CASES[4]);
    fixture.sources[0].text += ' Contexte neutre.'.repeat(20) + ' Frais supplémentaires inconnus.';
    const p = economicPassages(fixture).passages;
    expect(p.some(x => x.text.includes('18 EUR'))).toBe(true);
    expect(p.some(x => x.text.includes('supplémentaires inconnus'))).toBe(true);
    expect(literalFacts(fixture.sources).cost).toBe(null);
  });
  it('deduplicates only exact clauses and preserves decimal amounts', () => {
    const fixture = structuredClone(documented);
    fixture.sources[0].text = 'Coût initial total du pilote : 8,50 EUR. Frais inconnus. Frais inconnus. Frais incertains.';
    const p = economicPassages(fixture);
    expect(p.duplicates).toBe(1); expect(p.passages[0].text).toBe('Coût initial total du pilote : 8,50 EUR.');
    expect(p.passages.some(x => x.text === 'Frais incertains.')).toBe(true);
  });
  it.each([
    { estimated_cost_cents: 500 }, { cost_basis: 'ASSUMPTION' }, { human_minutes_daily: 1 },
    { account_required: false }, { summary: 'Projet rentable et revenus garantis.' },
  ])('rejects unsupported economic claims: %j', patch => expect(() => guardEconomics(parseEconomics(JSON.stringify({ ...result, ...patch })), documented)).toThrow());
  it.each(ECONOMIC_CASES.filter(f => f.oracle.cost === null))('unknown never means zero: $id', fixture => {
    expect(() => guardEconomics({ ...result, estimated_cost_cents: 0, cost_basis: 'SOURCE_ESTIMATE' } as any, fixture)).toThrow();
  });
  it('a contradiction requires unknown cost and an explicit uncertainty', () => {
    const fixture = ECONOMIC_CASES[4];
    expect(() => guardEconomics({ ...result, summary: 'Frais à étudier', estimated_cost_cents: null, cost_basis: 'UNKNOWN' } as any, fixture)).toThrow('Experimental');
    expect(() => guardEconomics({ ...result, summary: 'Coûts contradictoires; aucune vente', estimated_cost_cents: null, cost_basis: 'UNKNOWN' } as any, fixture)).not.toThrow();
  });
  it.each(['Coût initial total du pilote : 8 EUR mais ce coût n’est pas notre total.', 'Le coût initial total du pilote : 8 EUR est non confirmé.', 'Coût initial total du pilote : 8 EUR. Frais supplémentaires inconnus.'])('unconfirmed or incomplete costs remain unknown: %s', text => {
    expect(literalFacts([{ ...documented.sources[0], text }]).cost).toBe(null);
  });
  it('a free selling price is not a zero startup cost', () => {
    expect(literalFacts([{ ...documented.sources[0], text: 'Prix de vente gratuit, revenu hypothétique de 5 EUR.' }]).cost).toBe(null);
  });
  it('unknown or conflicting account requirements use a conservative assumption', () => {
    expect(literalFacts([{ ...documented.sources[0], text: 'Aucun compte requis.' }]).account).toBe(false);
    expect(literalFacts([{ ...documented.sources[0], text: 'Compte requis. Aucun compte requis.' }]).account).toBe(null);
  });
  it.each(['SOURCE_INVALID', 'SOURCE_INDEX', 'PRIVATE_OR_UNSAFE_DATA'])('refuses unsafe input before inference: %s', async code => {
    const f = structuredClone(documented);
    if (code === 'SOURCE_INVALID') f.sources[0].source_id = 'research-source-9';
    if (code === 'SOURCE_INDEX') f.candidate.source_index = 7;
    if (code === 'PRIVATE_OR_UNSAFE_DATA') f.sources[0].text += ' client@exemple.fr';
    const ask = vi.fn(); await expect(economicArm(f, 'B', { ask }, settings)).rejects.toThrow(); expect(ask).not.toHaveBeenCalled();
  });
});

describe('I3 isolated A/B; scripted results are not hardware validation', () => {
  it('short CLI makes two calls and keeps existing total budgets', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'scout-econ-cli-'));
    try {
      const file = path.join(dir, 'result.json');
      await promisify(execFile)(process.execPath, ['--import', 'tsx', 'experiments/v14-6-1/economics-probe.ts', `--output=${file}`]);
      const report = JSON.parse(await readFile(file, 'utf8'));
      expect(report.max_model_calls).toBe(2); expect(report.results).toHaveLength(2);
      expect(report.run_limits).toEqual({ model_calls: 20, total_input_characters: 24000, duration_ms: 1200000 });
      expect(report.results.every((r: any) => r.model_calls === 1 && !r.execution_authorized)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('CLI refuses thirty planned calls before inference', async () => {
    await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', 'experiments/v14-6-1/economics-probe.ts', '--scenario=all', '--repetitions=3', '--output=/unused.json']))
      .rejects.toMatchObject({ code: 1 });
  });
  it.each(ECONOMIC_CASES)('same source/model/one-call protocol and oracle: $id', async fixture => {
    for (const variant of ['A', 'B'] as const) {
      const ask = vi.fn(economicScript(fixture).ask);
      const out = await economicArm(fixture, variant, { ask }, settings);
      expect(out.model_calls).toBe(1); expect(ask).toHaveBeenCalledTimes(1);
      expect(out.literal_passages_verified).toBe(true); expect(out.scout_final_contracts_accepted).toBe(0);
      expect(out.verified_live_citations).toBe(0); expect(out.execution_authorized).toBe(false);
      expect(out.economic_profitability_demonstrated).toBe(false); expect(out.coordinator_model_calls).toBe(0);
      if (variant === 'B' && fixture.oracle.mustRefuse) expect(out.quality.justified_refusal).toBe(true);
      else expect(out.status).toBe('ECONOMICS_CONTRACT_ACCEPTED');
      expect(out.calls[0].prompt_tokens).toBe(null);
      expect(JSON.stringify(out)).not.toContain(result.summary);
    }
  });
  it('same competitor-price fault is rejected by B and detected by identical oracle in A', async () => {
    const f = ECONOMIC_CASES[2];
    const a = await economicArm(f, 'A', economicScript(f, true), settings);
    const b = await economicArm(f, 'B', economicScript(f, true), settings);
    expect(a.quality.false_positive).toBe(true); expect(b.refusal).toBe('ECONOMIC_COST_UNSUPPORTED');
    expect(b.quality.unhelpful_rejection).toBe(true); // refusing a bad answer is not producing a useful evaluation
  });
  it('oracle counts schema-valid unsupported constraints as false positives', () => {
    const s = scoreEconomics({ ...result, account_required: false } as any, documented, null);
    expect(s.false_positive).toBe(true); expect(s.useful_evaluation).toBe(false);
  });
  it('unknown supervision cannot silently become zero labor', () => {
    const f = ECONOMIC_CASES[1], x = { ...result, estimated_cost_cents: null, cost_basis: 'UNKNOWN', human_minutes_daily: 0 } as any;
    expect(() => guardEconomics(x, f)).toThrow(); expect(scoreEconomics(x, f, null).false_positive).toBe(true);
  });
  it('an unrelated negative clause does not license a positive revenue guarantee', () => {
    expect(() => guardEconomics({ ...result, summary: 'Aucune vente observée; revenus garantis.' } as any, documented)).toThrow();
  });
  it('no lossy truncation or extra call when relevant evidence exceeds context', async () => {
    const f = structuredClone(documented);
    f.sources[0].text = Array.from({ length: 32 }, (_, i) => `Frais ${i} inconnus et droits commerciaux à vérifier.`).join(' ');
    const ask = vi.fn(); const out = await economicArm(f, 'B', { ask }, settings);
    expect(out.refusal).toBe('CONTEXT_BUDGET_REFUSED'); expect(out.model_calls).toBe(0); expect(ask).not.toHaveBeenCalled();
  });
  it('parent abort is distinguished before inference', async () => {
    const c = new AbortController(); c.abort(); const ask = vi.fn();
    const out = await economicArm(documented, 'A', { ask }, settings, false, c.signal);
    expect(out.refusal).toBe('PARENT_ABORTED'); expect(ask).not.toHaveBeenCalled();
  });
  it('bounds a noncooperative model at the existing call deadline with no retry', async () => {
    vi.useFakeTimers(); const ask = vi.fn(() => new Promise<string>(() => {}));
    // AbortSignal.timeout uses native timers; inject parent abort for deterministic noncooperation test.
    const c = new AbortController(); const pending = economicArm(documented, 'B', { ask }, settings, false, c.signal);
    await Promise.resolve(); c.abort();
    const out = await pending; expect(out.refusal).toBe('PARENT_ABORTED'); expect(ask).toHaveBeenCalledTimes(1);
  });
  it('call timeout is classified separately from parent cancellation', async () => {
    const out = await economicArm(documented, 'A', { ask: () => new Promise<string>(() => {}) }, { ...settings, timeoutMs: 10 });
    expect(out.refusal).toBe('CALL_TIMEOUT'); expect(out.model_calls).toBe(1);
  });
  it.each(['{', '{}', ''])('format failures make exactly one call: %s', async value => {
    const ask = vi.fn(async () => value); const out = await economicArm(documented, 'B', { ask }, settings);
    expect(out.status).toBe('REFUSED'); expect(ask).toHaveBeenCalledTimes(1);
  });
  it('coordinator still refuses insufficient evidence without extra model calls', async () => {
    const original = fixtureModel();
    const research = await controlledResearch({ model: { async ask(phase, data, signal) {
      return phase === 'economics' ? JSON.stringify({ ...result, estimated_cost_cents: null, cost_basis: 'UNKNOWN' }) : original.ask(phase, data, signal);
    } }, ...fixtureNetwork() });
    const preview = await coordinatePreview(JSON.stringify(research));
    expect(preview.metrics.extra_model_calls).toBe(0); expect(preview.status).not.toBe('PASS');
  });
});

describe('I3 safe Ollama envelope metrics and failure taxonomy', () => {
  it('wire audit never calls external transport and makes no hardware claim', async () => {
    const outside = vi.fn(); vi.stubGlobal('fetch', outside);
    const audit = await economicWireAudit();
    expect(outside).not.toHaveBeenCalled(); expect(globalThis.fetch).toBe(outside);
    expect(audit.real_model_executed).toBe(false); expect(audit.actual_tokens_available).toBe(false);
    expect(audit.results).toHaveLength(10);
    expect(audit.results.every(x => x.serialized_request_bytes! > x.input_utf8_bytes)).toBe(true);
  });
  it('records bytes, tokens, load/prefill/decode without prompts or content', async () => {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); expect(body.options).toMatchObject({ num_ctx: 2048, num_predict: 256, temperature: 0 });
      return new Response(envelope());
    });
    vi.stubEnv('SCOUT_TIMEOUT_MS', '105000');
    const out = await economicArm(documented, 'A', localResearchModel('http://127.0.0.1:11434'), settings, true);
    expect(out.status).toBe('ECONOMICS_CONTRACT_ACCEPTED');
    expect(out.calls[0]).toMatchObject({ prompt_tokens: 333, output_tokens: 78, load_ns: 100, prompt_eval_ns: 200, eval_ns: 200, transport_calls: 1, done_reason: 'STOP' });
    expect(out.calls[0].request_bytes).toBeGreaterThan(out.calls[0].input_utf8_bytes);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(result.summary); expect(serialized).not.toContain(documented.sources[0].text);
  });
  it.each([
    [{ done: false }, 'TRUNCATED_OR_TOKEN_LIMIT'], [{ done_reason: 'length' }, 'TRUNCATED_OR_TOKEN_LIMIT'],
    [{ error: 'secret server error' }, 'OLLAMA_ERROR'], [{ message: {} }, 'ENVELOPE_INVALID'],
  ])('rejects incomplete/invalid envelopes: %j', async (fields, code) => {
    vi.stubGlobal('fetch', async () => new Response(envelope(raw(), fields)));
    const out = await economicArm(documented, 'B', localResearchModel('http://127.0.0.1:11434'), settings, true);
    expect(out.refusal).toBe(code); expect(JSON.stringify(out)).not.toContain('secret server error');
  });
  it.each([['{', 'ENVELOPE_JSON_INVALID'], ['x'.repeat(17000), 'RESPONSE_BYTE_LIMIT']])('rejects outer format or byte overflow (%#)', async (body, code) => {
    vi.stubGlobal('fetch', async () => new Response(body));
    const out = await economicArm(documented, 'A', localResearchModel('http://127.0.0.1:11434'), settings, true);
    expect(out.refusal).toBe(code);
  });
  it('HTTP failure hides the server body', async () => {
    vi.stubGlobal('fetch', async () => new Response('PRIVATE SERVER BODY', { status: 503 }));
    const out = await economicArm(documented, 'A', localResearchModel('http://127.0.0.1:11434'), settings, true);
    expect(out.refusal).toBe('HTTP_ERROR'); expect(JSON.stringify(out)).not.toContain('PRIVATE SERVER BODY');
  });
  it('missing timing fields stay null; untrusted timing types are not copied', () => {
    const m = newMetrics('Test'); inspectEconomicEnvelope({ message: { content: '{}' }, eval_count: 'secret', load_duration: -1, total_duration: Infinity, done_reason: 'private-value' }, m);
    expect(m.prompt_tokens).toBe(null); expect(m.output_tokens).toBe(null); expect(m.load_ns).toBe(null); expect(m.ollama_total_ns).toBe(null);
    expect(m.done_reason).toBe('OTHER'); expect(JSON.stringify(m)).not.toContain('private-value');
  });
  it('distinguishes timeout, parent abort and unknown abort without inferring OOM', () => {
    const p = new AbortController(), t = new AbortController();
    t.abort(new DOMException('ignored private reason', 'TimeoutError'));
    expect(abortDiagnostic(p.signal, t.signal)).toBe('CALL_TIMEOUT');
    p.abort(); expect(abortDiagnostic(p.signal, t.signal)).toBe('PARENT_ABORTED');
    expect(abortDiagnostic(sig())).toBe('TRANSPORT_ERROR');
    const u = new AbortController(); u.abort(); expect(abortDiagnostic(sig(), u.signal)).toBe('TRANSPORT_ABORT_UNCLASSIFIED');
  });
  it('restores fetch on failure and blocks non-loopback transport', async () => {
    const original = globalThis.fetch;
    await expect(withEconomicTransport(newMetrics('Test'), sig(), () => fetch('https://example.com/api/chat'))).rejects.toThrow();
    expect(globalThis.fetch).toBe(original);
  });
});
