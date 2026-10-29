import { describe, expect, it } from 'vitest';
import { parseResearchBoundaryJson } from '../agent/research-data-boundary.js';
import { toMobileResearchPreview } from '../agent/research-mobile-preview.js';
import { parseMobileResearchImport } from '../agent/research-mobile-import.js';
import { exportReviewedResearch, reviewResearchExport } from '../agent/research-public-export.js';
import { parsePublicResearchEnvelope } from '../agent/research-public-sync.js';
import { parseResearchResultFile } from '../../apps/scout-mobile/src/domain/researchResultFile.js';
import { reviewResearchImport, IMPORT_REFUSED } from '../../apps/scout-mobile/src/domain/researchImportReview.js';
import { createDemoResearchMessage } from '../agent/research-reception.js';
import { parseSavedScoutResearch } from '../../apps/scout-mobile/src/domain/scoutSyncSession.js';
import { syncFixtureMetadata, syncFixtureResearch } from './fixtures/scout-sync-engine-fixture.js';

const EXPERIMENTAL = [
  ...[false, null, 'missing-contract', { enabled: true, mode: 'REVIEWED_ANALYSIS_ONLY', results: [] }]
    .map(value => ({ field: 'economic_guard', value })),
  ...[false, null, 'OPENAI_SIMULATED', { query_proposal: 'OPENAI_SIMULATED', real_openai: false }]
    .map(value => ({ field: 'experimental_model_provider', value }))
];
function release(data: unknown = syncFixtureResearch()) {
  const raw = JSON.stringify(data), metadata = syncFixtureMetadata();
  const review = reviewResearchExport(raw, metadata);
  return exportReviewedResearch(raw, metadata, { approved_payload_sha256: review.payload_sha256,
    reviewed_source_urls: review.source_urls });
}
function refusedAtBothEntries(data: unknown) {
  const raw = JSON.stringify(data);
  expect(() => parseResearchResultFile(raw)).toThrow();
  expect(() => reviewResearchExport(raw, syncFixtureMetadata())).toThrow();
}

describe('Research boundary: explicit refusal before information-losing projection', () => {
  it.each(EXPERIMENTAL)('refuses presence of $field with value $value in every full-output path', ({ field, value }) => {
    const data = { ...syncFixtureResearch(), [field]: value }, raw = JSON.stringify(data);
    const historicalApproval = reviewResearchExport(JSON.stringify(syncFixtureResearch()), syncFixtureMetadata());
    const before = JSON.stringify(data);
    for (const project of [() => parseResearchResultFile(raw),
      () => toMobileResearchPreview(data as unknown as Parameters<typeof toMobileResearchPreview>[0]), () => reviewResearchExport(raw, syncFixtureMetadata()),
      () => exportReviewedResearch(raw, syncFixtureMetadata(), {
        approved_payload_sha256: historicalApproval.payload_sha256,
        reviewed_source_urls: historicalApproval.source_urls })]) {
      expect(project).toThrow('EXPERIMENTAL_RESEARCH_PROJECTION_REFUSED');
    }
    expect(JSON.stringify(data)).toBe(before);
  });

  it('refuses an incomplete reviewed analysis instead of silently producing an empty preview', () => {
    const data = { ...syncFixtureResearch(), status: 'INSUFFICIENT_EVIDENCE', opportunities: [],
      economic_guard: { enabled: true, mode: 'REVIEWED_ANALYSIS_ONLY', results: [{
        status: 'REVIEWED_ANALYSIS_ONLY', display: { decision: 'DOCUMENTATION_REQUIRED',
          full_profit_cents: null, warnings: ['INITIAL_COST_UNKNOWN'] } }] } };
    refusedAtBothEntries(data);
    expect(() => toMobileResearchPreview(data as any)).toThrow('EXPERIMENTAL_RESEARCH_PROJECTION_REFUSED');
  });

  it.each(['warnings', 'provenance', 'data_origin', 'profitability', 'full_profit_cents', 'future_safety_policy'])
    ('refuses unknown root safety/provenance field %s rather than stripping it', key => {
      refusedAtBothEntries({ ...syncFixtureResearch(), [key]: null });
    });

  it.each(['warnings', 'economic_guard', 'experimental_model_provider', 'recurring_costs', 'full_profit_cents'])
    ('refuses new opportunity information %s not representable in old cards', key => {
      const data = syncFixtureResearch(); (data.opportunities[0] as any)[key] = ['costs unknown'];
      refusedAtBothEntries(data);
    });

  it('refuses additional security flags, source metadata and nested evidence warnings', () => {
    const changes = [
      (data: any) => { data.security.authentication = 'AUTHENTICATED'; },
      (data: any) => { data.evidence[0].provenance = 'OPENAI_SIMULATED'; },
      (data: any) => { data.opportunities[0].evidence.warnings = ['stale']; },
      (data: any) => { data.opportunities[0].mini_test = { possible: false,
        estimated_cost_cents: null, description: 'Fiction', command: 'pay' }; }
    ];
    for (const change of changes) { const data = syncFixtureResearch(); change(data); refusedAtBothEntries(data); }
  });

  it.each(['version', 'status', 'evidence', 'opportunities', 'security'])('does not invent missing full-output field %s', key => {
    const data = syncFixtureResearch(); delete (data as any)[key]; refusedAtBothEntries(data);
  });

  it.each(['project_created', 'approval_created', 'external_action_executed', 'money_spent',
    'capability_granted', 'installation_performed'])('does not invent a missing false security flag %s', key => {
    const data = syncFixtureResearch(); delete (data.security as any)[key]; refusedAtBothEntries(data);
  });

  it.each(['BLOCKED', 'INSUFFICIENT_EVIDENCE'])('retains historical rejection of %s with hypotheses', status => {
    refusedAtBothEntries({ ...syncFixtureResearch(), status });
    const data = { ...syncFixtureResearch(), status, opportunities: [] };
    expect(parseResearchResultFile(JSON.stringify(data))).toEqual({ status, cards: [] });
    expect(parsePublicResearchEnvelope(release(data)).preview).toEqual({ status, cards: [] });
  });
});

describe('Research boundary: unknown costs, provenance and strict wire compatibility', () => {
  it.each([null, 0, 850])('keeps cost %s distinct without inferring profitability', cost => {
    const data = syncFixtureResearch(), item = data.opportunities[0] as any;
    item.estimated_cost_cents = cost;
    item.cost_basis = cost === null ? 'UNKNOWN' : 'SOURCE_ESTIMATE';
    if (cost === 0) {
      item.evidence.quote = 'Le coût décrit est gratuit sans investissement.';
      data.evidence[0].text = item.evidence.quote;
    }
    const file = parseResearchResultFile(JSON.stringify(data)), message = parsePublicResearchEnvelope(release(data));
    expect(file.cards[0].cost_cents).toBe(cost);
    expect(message.preview).toEqual(file);
    expect(file.cards[0].cost_basis).toBe(cost === null ? 'UNKNOWN' : 'SOURCE_ESTIMATE');
    expect(file.cards[0]).not.toHaveProperty('full_profit_cents');
    expect(file.cards[0]).not.toHaveProperty('profitability');
  });

  it.each(['estimated_cost_cents', 'cost_basis'])('refuses absent cost field %s instead of defaulting to null or zero', key => {
    const data = syncFixtureResearch(); delete (data.opportunities[0] as any)[key]; refusedAtBothEntries(data);
  });

  it('preserves a valid V1 message and its fictional/unauthenticated classification', () => {
    const data = createDemoResearchMessage();
    expect(parseSavedScoutResearch(JSON.stringify(data))).toEqual(data);
    expect(data.classification).toBe('FICTIONAL_DEMO');
    expect(data.authentication).toBe('UNAUTHENTICATED');
  });

  it.each(['FICTIONAL_TEST', 'PUBLIC_RESEARCH'] as const)('preserves declared V2 origin %s without treating it as authenticated', origin => {
    const raw = JSON.stringify(syncFixtureResearch()), metadata = { ...syncFixtureMetadata(), data_origin: origin };
    const review = reviewResearchExport(raw, metadata);
    const message = exportReviewedResearch(raw, metadata, { approved_payload_sha256: review.payload_sha256,
      reviewed_source_urls: review.source_urls });
    const parsed = parseSavedScoutResearch(message);
    expect(parsed.protocol_version).toBe(2);
    if (parsed.protocol_version !== 2) throw new Error('Expected V2');
    expect(parsed.data_origin).toBe(origin);
    expect(parsed.authentication).toBe('UNAUTHENTICATED');
    expect(parsed.execution_authorized).toBe(false);
    expect(parsed).not.toHaveProperty('model');
  });

  it.each(['data_origin', 'authentication', 'execution_authorized', 'classification'])
    ('refuses V2 with missing mandatory %s', key => {
      const data = JSON.parse(release()); delete data[key];
      expect(() => parseSavedScoutResearch(JSON.stringify(data))).toThrow();
    });

  it('requires host origin metadata instead of assigning an origin from absent fields', () => {
    const metadata = syncFixtureMetadata(); delete (metadata as any).data_origin;
    expect(() => reviewResearchExport(JSON.stringify(syncFixtureResearch()), metadata)).toThrow();
  });

  it('does not invent origin, model or authentication on a historical short import', () => {
    const preview = parseResearchResultFile(JSON.stringify(syncFixtureResearch()));
    expect(parseMobileResearchImport(JSON.stringify(preview))).toEqual(preview);
    for (const key of ['data_origin', 'model', 'authentication', 'economic_guard']) expect(preview).not.toHaveProperty(key);
  });

  it('does not allow laundering a sync envelope through the legacy file importer', () => {
    for (const raw of [JSON.stringify(createDemoResearchMessage()), release()]) {
      expect(() => parseResearchResultFile(raw)).toThrow();
    }
  });
});

describe('Research boundary: duplicate JSON keys cannot erase provenance or warnings', () => {
  it.each(['{"data_origin":"FICTIONAL_TEST","data_origin":"PUBLIC_RESEARCH"}',
    '{"cost_cents":null,"cost_cents":0}', '{"security":{"money_spent":true,"money_spent":false}}',
    '{"warnings":[],"\\u0077arnings":null}'])('rejects duplicate identity after unescaping (%#)', raw => {
    expect(() => parseResearchBoundaryJson(raw)).toThrow('DUPLICATE_RESEARCH_JSON_KEY');
  });

  it('handles escaped quotes, backslashes, punctuation, arrays and repeated keys in separate objects', () => {
    const value = { objects: [{ key: 'a\\"b,:{[' }, { key: 'second' }], 'a"b': null, cost: 0 };
    expect(parseResearchBoundaryJson(JSON.stringify(value))).toEqual(value);
    expect(parseResearchBoundaryJson('[[1,true,null],{"a":{},"b":[]}]')).toEqual([[1, true, null], { a: {}, b: [] }]);
  });

  it('rejects duplicate provenance in V1 and V2 before the nested preview is serialized', () => {
    const v1 = JSON.stringify(createDemoResearchMessage()).replace('"classification":',
      '"classification":"not-fiction","classification":');
    const v2 = release().replace('"data_origin":', '"data_origin":"PUBLIC_RESEARCH","data_origin":');
    for (const raw of [v1, v2]) expect(() => parseSavedScoutResearch(raw)).toThrow('DUPLICATE_RESEARCH_JSON_KEY');
  });

  it('rejects duplicate cost fields in all raw import and export paths', () => {
    const raw = JSON.stringify(syncFixtureResearch()).replace('"estimated_cost_cents":850',
      '"estimated_cost_cents":null,"estimated_cost_cents":850');
    expect(() => parseResearchResultFile(raw)).toThrow('DUPLICATE_RESEARCH_JSON_KEY');
    expect(() => reviewResearchExport(raw, syncFixtureMetadata())).toThrow('DUPLICATE_RESEARCH_JSON_KEY');
    const short = JSON.stringify(parseResearchResultFile(JSON.stringify(syncFixtureResearch())))
      .replace('"cost_cents":850', '"cost_cents":null,"cost_cents":850');
    expect(() => parseMobileResearchImport(short)).toThrow('DUPLICATE_RESEARCH_JSON_KEY');
  });
});

describe('UI import transition: controlled refusal preserves previous data', () => {
  it.each(['PREVIEW', 'RESEARCH_FILE'] as const)('preserves the exact previous preview on %s refusal and then accepts a replacement', format => {
    const old = parseResearchResultFile(JSON.stringify(syncFixtureResearch())), frozen = JSON.stringify(old);
    for (const raw of ['{', 'null', JSON.stringify({ ...syncFixtureResearch(), economic_guard: null })]) {
      const result = reviewResearchImport(old, raw, format);
      expect(result.preview).toBe(old);
      expect(result.error).toBe(IMPORT_REFUSED);
      expect(JSON.stringify(old)).toBe(frozen);
    }
    const empty = { status: 'BLOCKED', cards: [] };
    expect(reviewResearchImport(old, JSON.stringify(empty), format)).toEqual({ preview: empty, error: '' });
    expect(reviewResearchImport(null, '{', format).preview).toBeNull();
  });
});
