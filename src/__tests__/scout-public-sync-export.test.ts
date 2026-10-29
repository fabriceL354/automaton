import { describe, expect, it } from 'vitest';
import { exportReviewedResearch, reviewResearchExport } from '../agent/research-public-export.js';
import { parsePublicResearchEnvelope, PUBLIC_SYNC_MAX_BYTES } from '../agent/research-public-sync.js';
import { parseScoutReception } from '../../apps/scout-mobile/src/domain/scoutReception';
import { syncFixtureMetadata, syncFixtureResearch, SYNC_FIXTURE_PRIVATE } from './fixtures/scout-sync-engine-fixture.js';

function exportFixture(data = syncFixtureResearch(), metadata = syncFixtureMetadata()) {
  const raw = JSON.stringify(data);
  const review = reviewResearchExport(raw, metadata, { knownSecrets: [SYNC_FIXTURE_PRIVATE] });
  return exportReviewedResearch(raw, metadata, { approved_payload_sha256: review.payload_sha256,
    reviewed_source_urls: review.source_urls }, { knownSecrets: [SYNC_FIXTURE_PRIVATE] });
}

describe('Scout public export: local projection and explicit release gate', () => {
  it('projects the real research.json shape with existing quote and cost checks', () => {
    const raw = exportFixture();
    const value = parsePublicResearchEnvelope(raw);
    expect(value.protocol_version).toBe(2);
    expect(value.data_origin).toBe('FICTIONAL_TEST');
    expect(value.authentication).toBe('UNAUTHENTICATED');
    expect(value.preview.cards[0]).toMatchObject({ cost_cents: 850, execution_authorized: false });
    for (const field of ['private_state', 'queries', 'metrics', 'operator_attention', 'tool_requests',
      'query_id', 'source_id', 'security', 'approved_payload_sha256', 'reviewed_source_urls']) {
      expect(raw).not.toContain(`"${field}"`);
    }
    expect(raw).not.toContain(SYNC_FIXTURE_PRIVATE);
    expect(raw).not.toContain('Bearer');
  });

  it('requires a host approval even when the input claims to be approved', () => {
    const data = { ...syncFixtureResearch(), approved_payload_sha256: 'self-approved' };
    expect(() => exportReviewedResearch(JSON.stringify(data), syncFixtureMetadata()))
      .toThrow('PUBLIC_RELEASE_APPROVAL_REQUIRED');
  });

  it('binds the approval to all exact display fields and metadata', () => {
    const data = syncFixtureResearch(), metadata = syncFixtureMetadata();
    const review = reviewResearchExport(JSON.stringify(data), metadata);
    const approval = { approved_payload_sha256: review.payload_sha256, reviewed_source_urls: review.source_urls };
    data.opportunities[0].name = 'Unreviewed replacement';
    expect(() => exportReviewedResearch(JSON.stringify(data), metadata, approval))
      .toThrow('PUBLIC_RELEASE_APPROVAL_MISMATCH');
    expect(() => exportReviewedResearch(JSON.stringify(syncFixtureResearch()), { ...metadata, revision: 2 }, approval))
      .toThrow('PUBLIC_RELEASE_APPROVAL_MISMATCH');
  });

  it('refuses an unreviewed declared source', () => {
    const raw = JSON.stringify(syncFixtureResearch()), metadata = syncFixtureMetadata();
    const review = reviewResearchExport(raw, metadata);
    expect(() => exportReviewedResearch(raw, metadata,
      { approved_payload_sha256: review.payload_sha256, reviewed_source_urls: [] }))
      .toThrow('PUBLIC_SOURCE_NOT_APPROVED');
  });

  it('accepts harmless private internal-field changes without exporting them', () => {
    const data = syncFixtureResearch(), metadata = syncFixtureMetadata();
    const review = reviewResearchExport(JSON.stringify(data), metadata);
    data.private_state.secret = 'different-private-fixture';
    const raw = exportReviewedResearch(JSON.stringify(data), metadata,
      { approved_payload_sha256: review.payload_sha256, reviewed_source_urls: review.source_urls });
    expect(raw).not.toContain('different-private-fixture');
  });

  it('rejects known private content in a selected card before review', () => {
    const data = syncFixtureResearch(); data.opportunities[0].name = SYNC_FIXTURE_PRIVATE;
    expect(() => reviewResearchExport(JSON.stringify(data), syncFixtureMetadata(),
      { knownSecrets: [SYNC_FIXTURE_PRIVATE] })).toThrow('PRIVATE_EXPORT_REFUSED');
  });

  it('rejects encoded known private content in a quote even with otherwise valid evidence', () => {
    const data = syncFixtureResearch();
    const quote = Buffer.from(SYNC_FIXTURE_PRIVATE).toString('base64');
    data.evidence[0].text = quote;
    data.opportunities[0].evidence.quote = quote;
    data.opportunities[0].cost_basis = 'UNKNOWN';
    (data.opportunities[0] as any).estimated_cost_cents = null;
    expect(() => reviewResearchExport(JSON.stringify(data), syncFixtureMetadata(),
      { knownSecrets: [SYNC_FIXTURE_PRIVATE] })).toThrow('PRIVATE_EXPORT_REFUSED');
  });

  it.each(['project_created', 'approval_created', 'external_action_executed', 'money_spent',
    'capability_granted', 'installation_performed'])('refuses recorded security flag %s', flag => {
    const data = syncFixtureResearch(); (data.security as any)[flag] = true;
    expect(() => exportFixture(data)).toThrow('UNSAFE_RESEARCH_OUTPUT');
  });

  it('rejects missing or additional authority flags', () => {
    const data = syncFixtureResearch(); delete (data.security as any).money_spent;
    expect(() => exportFixture(data)).toThrow();
    (data.security as any).money_spent = false; (data.security as any).command = 'execute';
    expect(() => exportFixture(data)).toThrow();
  });

  it.each(['BLOCKED', 'INSUFFICIENT_EVIDENCE'])('exports valid %s without cards', status => {
    const data = syncFixtureResearch(); data.status = status; data.opportunities = [];
    expect(parsePublicResearchEnvelope(exportFixture(data)).preview).toEqual({ status, cards: [] });
    data.opportunities = syncFixtureResearch().opportunities;
    expect(() => exportFixture(data)).toThrow('INVALID_BLOCKED_OPPORTUNITIES');
  });

  it('rejects missing, duplicated and mismatched evidence or costs', () => {
    let data = syncFixtureResearch(); data.evidence = [];
    expect(() => exportFixture(data)).toThrow();
    data = syncFixtureResearch(); data.evidence.push(data.evidence[0]);
    expect(() => exportFixture(data)).toThrow();
    data = syncFixtureResearch(); data.evidence[0].text = 'The quoted page was not read.';
    expect(() => exportFixture(data)).toThrow('UNVERIFIED_EXPORT_EVIDENCE');
    data = syncFixtureResearch(); data.opportunities[0].estimated_cost_cents = 950;
    expect(() => exportFixture(data)).toThrow('UNVERIFIED_EXPORT_EVIDENCE');
  });

  it('retains the three opportunity, ten source and raw file size limits', () => {
    let data = syncFixtureResearch(); data.opportunities = Array(4).fill(data.opportunities[0]);
    expect(() => exportFixture(data)).toThrow();
    data = syncFixtureResearch(); data.evidence = Array(11).fill(data.evidence[0]);
    expect(() => exportFixture(data)).toThrow();
    expect(() => reviewResearchExport(' '.repeat(131073), syncFixtureMetadata())).toThrow();
  });

  it('does not weaken the existing fiction-only Android protocol', () => {
    expect(() => parseScoutReception(exportFixture())).toThrow();
  });
});

describe('Scout public reception v2: strict untrusted display contract', () => {
  it.each(['command', 'payment', 'project', 'capabilities', 'private_state'])(
    'refuses extra envelope field %s', key => {
      const data = JSON.parse(exportFixture()); data[key] = 'ignored command';
      expect(() => parsePublicResearchEnvelope(JSON.stringify(data))).toThrow('INVALID_PUBLIC_SYNC_FIELDS');
    }
  );
  it.each([
    ['engine_id', 'engine-valid\n'], ['research_id', 'research-valid\r\n'],
    ['engine_id', 'engine-\u0000'], ['research_id', 'research-a/b'], ['revision', 0],
    ['revision', 1.5], ['revision', Number.MAX_SAFE_INTEGER + 1],
    ['generated_at', '2026-02-30T00:00:00.000Z'], ['generated_at', '2026-01-01T00:00:00.000Z\n'],
    ['protocol_version', 1], ['execution_authorized', true], ['authentication', 'AUTHENTICATED'],
    ['data_origin', 'TRUSTED'], ['classification', 'PRIVATE']
  ])('rejects invalid %s', (key, value) => {
    const data = JSON.parse(exportFixture()); data[key] = value;
    expect(() => parsePublicResearchEnvelope(JSON.stringify(data))).toThrow();
  });
  it.each(['http://demo.scout.invalid/tarifs', 'https://user:pass@demo.scout.invalid/tarifs',
    'https://demo.scout.invalid/tarifs?token=private', 'https://demo.scout.invalid/tarifs#private',
    'https://127.0.0.1/tarifs', 'https://10.0.0.1/tarifs', 'https://localhost/tarifs',
    'https://host.local/tarifs', 'https://[::1]/tarifs', 'https://demo.scout.invalid/%73ecret',
    'https://demo.scout.invalid:8443/tarifs'])('refuses unsafe declared source %s', url => {
    const data = JSON.parse(exportFixture()); data.preview.cards[0].source_url = url;
    expect(() => parsePublicResearchEnvelope(JSON.stringify(data))).toThrow();
  });
  it('refuses nested extra fields, permissions and oversized data', () => {
    const data = JSON.parse(exportFixture()); data.preview.cards[0].command = 'execute';
    expect(() => parsePublicResearchEnvelope(JSON.stringify(data))).toThrow();
    delete data.preview.cards[0].command; data.preview.cards[0].execution_authorized = true;
    expect(() => parsePublicResearchEnvelope(JSON.stringify(data))).toThrow();
    expect(() => parsePublicResearchEnvelope('x'.repeat(PUBLIC_SYNC_MAX_BYTES + 1))).toThrow();
  });
});
