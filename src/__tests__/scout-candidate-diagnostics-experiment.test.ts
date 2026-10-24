import { afterEach, describe, expect, it, vi } from 'vitest';
import { candidateFieldIssues, diagnosticContext } from '../../experiments/v14-6-1/candidate-diagnostics.js';
import { diagnoseContent, observeModel, withOllamaMetrics, type Diagnostic } from '../../experiments/v14-6-1/diagnostics.js';
import { candidateInstruction, progressiveModel, LIMITS } from '../../experiments/v14-6-1/progressive.js';
import { probeArm, PROBE_SOURCE } from '../../experiments/v14-6-1/candidate-probe.js';
import { runArm, scriptedModel } from '../../experiments/v14-6-1/benchmark.js';
import { SCENARIOS } from '../../experiments/v14-6-1/corpus.js';
import { localResearchModel } from '../agent/research-controller.js';
import { parseResearchCandidates, PUBLIC_RESEARCH_MISSION } from '../agent/research-model.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const candidate = { name: 'Correction de textes', kind: 'QUICK_SERVICE', source_index: 1 };
const wrap = (c: unknown) => ({ candidates: [c] });
const prompt = (index = 1) => `PUBLIC MISSION: ${PUBLIC_RESEARCH_MISSION}\nUNTRUSTED READ EVIDENCE: ${JSON.stringify([{ ...PROBE_SOURCE, index, source_id: `research-source-${index + 1}` }])}\nReturn exact candidates.`;

describe('iteration 2: safe, structured candidates rejection taxonomy', () => {
  it.each([
    [null, 'root', 'TYPE'], [[], 'root', 'TYPE'], [{}, 'root', 'MISSING_FIELD'],
    [{ candidates: [], response: 'private-value' }, 'root', 'EXTRA_FIELDS'],
    [{ candidates: {} }, 'candidates', 'TYPE'], [{ candidates: [candidate, candidate, candidate, candidate] }, 'candidates', 'COUNT'],
    [wrap(null), 'candidate', 'TYPE'], [wrap({ ...candidate, extra: 'private-value' }), 'candidate', 'EXTRA_FIELDS'],
    [wrap({ kind: candidate.kind, source_index: 1 }), 'name', 'MISSING_FIELD'],
    [wrap({ name: candidate.name, source_index: 1 }), 'kind', 'MISSING_FIELD'],
    [wrap({ name: candidate.name, kind: candidate.kind }), 'source_index', 'MISSING_FIELD'],
    [wrap({ ...candidate, name: null }), 'name', 'TYPE'], [wrap({ ...candidate, name: '  ' }), 'name', 'EMPTY'],
    [wrap({ ...candidate, name: 'a'.repeat(81) }), 'name', 'LENGTH'],
    [wrap({ ...candidate, name: 'abc\nxyz' }), 'name', 'CONTROL_OR_FORMAT'],
    [wrap({ ...candidate, name: 'abc\u200bxyz' }), 'name', 'CONTROL_OR_FORMAT'],
    [wrap({ ...candidate, name: 'https://example.com/private-value' }), 'name', 'PUBLIC_TEXT_REFUSED'],
    [wrap({ ...candidate, name: 'short name' }), 'name', 'PLACEHOLDER'],
    [wrap({ ...candidate, kind: null }), 'kind', 'TYPE'], [wrap({ ...candidate, kind: 'service' }), 'kind', 'ENUM'],
    [wrap({ ...candidate, kind: 'QUICK_SERVICE or DURABLE_ASSET' }), 'kind', 'ENUM'],
    [wrap({ ...candidate, source_index: '1' }), 'source_index', 'TYPE'],
    [wrap({ ...candidate, source_index: 'research-source-2' }), 'source_index', 'TYPE'],
    [wrap({ ...candidate, source_index: null }), 'source_index', 'TYPE'],
    [wrap({ ...candidate, source_index: 1.5 }), 'source_index', 'INTEGER'],
    [wrap({ ...candidate, source_index: 1e100 }), 'source_index', 'INTEGER'],
    [wrap({ ...candidate, source_index: -1 }), 'source_index', 'RANGE'],
    [wrap({ ...candidate, source_index: 10 }), 'source_index', 'RANGE'],
  ])('categorizes a malformed field without changing production acceptance (%#)', (value, field, category) => {
    const raw = JSON.stringify(value);
    expect(candidateFieldIssues(value)).toContainEqual({ field, category });
    expect(diagnoseContent('candidates', raw).contract_shape_valid).toBe(false);
    expect(() => parseResearchCandidates(raw, 10)).toThrow();
  });
  it('detects negative zero without losing it in a JSON round trip', () => {
    const raw = '{"candidates":[{"name":"Correction de textes","kind":"QUICK_SERVICE","source_index":-0}]}';
    expect(diagnoseContent('candidates', raw).field_issues).toContainEqual({ field: 'source_index', category: 'NEGATIVE_ZERO' });
    expect(() => parseResearchCandidates(raw, 10)).toThrow();
  });
  it('collects several field errors rather than only the first thrown validation', () => {
    expect(candidateFieldIssues(wrap({ name: '', kind: 'wrong', source_index: '1', secret: 'private-value' })))
      .toEqual(expect.arrayContaining([{ field: 'candidate', category: 'EXTRA_FIELDS' }, { field: 'name', category: 'EMPTY' },
        { field: 'kind', category: 'ENUM' }, { field: 'source_index', category: 'TYPE' }]));
  });
  it('does not log arbitrary keys, invalid values or exception text', async () => {
    const raw = '{"private-key":"private-value","candidates":[{"name":"https://secret.invalid/private-name","kind":"private-enum","source_index":"private-index","private-key":"private-value"}]}';
    const rows: Diagnostic[] = [];
    await observeModel({ async ask() { return raw; } }, rows).ask('candidates', 'private-prompt', new AbortController().signal);
    const serialized = JSON.stringify(rows);
    for (const value of ['private-key', 'private-value', 'secret.invalid', 'private-name', 'private-enum', 'private-index', 'private-prompt', raw]) expect(serialized).not.toContain(value);
    expect(rows[0].field_issues.length).toBeGreaterThan(0);
  });
  it('bounds diagnostic collection and deduplicates categories', () => {
    const issues = candidateFieldIssues({ candidates: Array(10000).fill({ name: '', kind: 'bad', source_index: 'bad' }) });
    expect(issues).toHaveLength(4);
  });
  it.each(['', '{'])('keeps empty and broken JSON outside the field taxonomy', raw => {
    expect(diagnoseContent('candidates', raw).field_issues).toEqual([]);
  });
  it.each([[], [candidate], [{ ...candidate, name: 'é '.repeat(40), kind: 'DURABLE_ASSET' }]].map(c => [c]))('preserves accepted parser shapes (%#)', candidates => {
    const raw = JSON.stringify({ candidates });
    expect(diagnoseContent('candidates', raw)).toMatchObject({ contract_shape_valid: true, field_issues: [] });
    expect(parseResearchCandidates(raw, 10)).toHaveLength(candidates.length);
  });
});

describe('schema, extraction cardinality and provenance remain distinct', () => {
  it('finds global index 7 in supplied host evidence without retaining text', () => {
    expect(diagnosticContext('candidates', prompt(7))).toEqual({ sourceIndexes: [7], oneCandidate: false });
  });
  it('reports a globally valid but unsupplied source as provenance, not schema failure', async () => {
    const rows: Diagnostic[] = [];
    const model = progressiveModel(observeModel({ async ask() { return JSON.stringify(wrap({ ...candidate, source_index: 0 })); } }, rows));
    await expect(model.ask('candidates', prompt(7), new AbortController().signal)).rejects.toThrow();
    expect(rows[0]).toMatchObject({ contract_shape_valid: true, diagnostic: 'PROVENANCE_INVALID',
      field_issues: [{ field: 'source_index', category: 'SOURCE_NOT_SUPPLIED' }] });
    expect(model.calls[0].diagnostic).toBe('SOURCE_INDEX');
  });
  it('reports two items in a one-source extraction separately from the three-item production ceiling', async () => {
    const rows: Diagnostic[] = [];
    const model = progressiveModel(observeModel({ async ask() { return JSON.stringify({ candidates: [candidate, candidate] }); } }, rows));
    await expect(model.ask('candidates', prompt(), new AbortController().signal)).rejects.toThrow();
    expect(rows[0]).toMatchObject({ contract_shape_valid: true, diagnostic: 'EXTRACTION_CONTRACT_INVALID',
      field_issues: [{ field: 'candidates', category: 'EXTRACTION_COUNT' }] });
  });
  it('records evidence_index misuse in a B query that received no evidence', async () => {
    const raw = '{"intents":[{"family":"micro_service","focus":"market","evidence_index":0}]}';
    const rows: Diagnostic[] = [];
    await observeModel({ async ask() { return raw; } }, rows).ask('query_proposal', 'No page evidence supplied: evidence_index must be null.', new AbortController().signal);
    expect(rows[0]).toMatchObject({ diagnostic: 'PROVENANCE_INVALID', field_issues: [{ field: 'evidence_index', category: 'SOURCE_NOT_SUPPLIED' }] });
  });
  it('attaches the same safe categories on real-transport envelopes without retaining the envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ done: true,
      message: { content: JSON.stringify(wrap({ ...candidate, source_index: 'private-index' })) }, eval_count: 23 }))));
    const rows: Diagnostic[] = [];
    await withOllamaMetrics(rows, () => observeModel(localResearchModel('http://127.0.0.1:11434'), rows, true)
      .ask('candidates', prompt(), new AbortController().signal), { progressiveContext: true });
    expect(rows[0]).toMatchObject({ diagnostic: 'SCHEMA_INVALID', output_tokens: 23,
      field_issues: [{ field: 'source_index', category: 'TYPE' }] });
    expect(JSON.stringify(rows)).not.toContain('private-index');
  });
});

describe('minimal candidate prompt experiment and focused Chromebook probe', () => {
  it.each([0, 1, 7, 9])('shows valid full JSON with the actual global index %s and unchanged fields', index => {
    const instruction = candidateInstruction(index, 'explicit');
    const example = instruction.match(/^Return exactly (.+?) or /)![1];
    expect(parseResearchCandidates(example, 10)[0].source_index).toBe(index);
    expect(instruction).toContain('never renumber to 0'); expect(instruction).toContain('not a string or source_id');
    expect(instruction).toContain('QUICK_SERVICE or DURABLE_ASSET'); expect(instruction).toContain('1..80 chars');
  });
  it('fits the actual full mission and maximum excerpt in the unchanged 2048 context guard', async () => {
    let request: any;
    vi.stubGlobal('fetch', vi.fn(async (_url, init: any) => {
      request = JSON.parse(init.body);
      return new Response(JSON.stringify({ done: true, message: { content: '{"candidates":[]}' } }));
    }));
    const rows: Diagnostic[] = [];
    const adapter = progressiveModel(observeModel(localResearchModel('http://127.0.0.1:11434'), rows, true));
    const data = prompt(7).replace(PROBE_SOURCE.text, 'é'.repeat(250));
    await withOllamaMetrics(rows, () => adapter.ask('candidates', data, new AbortController().signal), { progressiveContext: true });
    expect(request.options).toMatchObject({ num_ctx: 2048, num_predict: 256, temperature: 0 });
    expect(request.messages).toHaveLength(2); expect(request.format).toBe('json');
    const bytes = request.messages.reduce((n: number, m: any) => n + Buffer.byteLength(m.content), 0);
    expect(bytes + 128 + 256).toBeLessThanOrEqual(2048);
    expect(rows).toHaveLength(1); expect(rows[0].input_chars).toBeLessThanOrEqual(LIMITS.inputChars);
  });
  it.each(['original', 'explicit'] as const)('uses one call without changing the model output for %s', async revision => {
    const raw = JSON.stringify(wrap(candidate)); const ask = vi.fn(async () => raw);
    const run = await probeArm(revision, { ask });
    expect(run.status).toBe('EXTRACTION_ACCEPTED'); expect(run.model_calls).toBe(1); expect(ask).toHaveBeenCalledTimes(1);
    expect(run.economic_validation).toBe('NOT_PERFORMED'); expect(run.execution_authorized).toBe(false);
    expect(JSON.stringify(run)).not.toContain(candidate.name);
  });
  it('does not retry a schema rejection in the focused probe', async () => {
    const ask = vi.fn(async () => JSON.stringify(wrap({ ...candidate, kind: 'service' })));
    const run = await probeArm('explicit', { ask });
    expect(run.status).toBe('EXTRACTION_REJECTED'); expect(ask).toHaveBeenCalledTimes(1);
    expect(run.calls[0].field_issues).toEqual([{ field: 'kind', category: 'ENUM' }]);
  });
  it('keeps both B prompts equivalent on a scripted full pipeline and preserves economics and locks', async () => {
    const old = await runArm(SCENARIOS[0], 'B', scriptedModel(SCENARIOS[0]), false, 'original');
    const revised = await runArm(SCENARIOS[0], 'B', scriptedModel(SCENARIOS[0]), false, 'explicit');
    expect(revised.review_candidates).toEqual(old.review_candidates); expect(revised.model_calls).toBe(old.model_calls);
    expect(revised.scout_contracts_accepted).toBe(2); expect(revised.execution_authorized_count).toBe(0);
    expect(revised.coordinator_model_calls).toBe(0); expect(revised.economically_exploitable).toBeNull();
  });
});
