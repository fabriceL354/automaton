import { describe, expect, it } from 'vitest';
import { createDemoResearchMessage } from '../agent/research-reception.js';
import { parseScoutReception } from '../../apps/scout-mobile/src/domain/scoutReception';

const encode = (value: unknown) => JSON.stringify(value);

describe('Scout reception v1: strict fictional public display protocol', () => {
  it('projects the existing evidence and cost contract without private engine state', () => {
    const message = createDemoResearchMessage();
    expect(parseScoutReception(encode(message))).toEqual(message);
    expect(message.preview.cards).toHaveLength(1);
    expect(message.preview.cards[0]).toMatchObject({
      cost_cents: 850, cost_basis: 'SOURCE_ESTIMATE', execution_authorized: false
    });
    for (const privateField of ['query_id', 'queries', 'tool_requests', 'capabilities',
      'operator_attention', 'metrics', 'mini_test', 'opportunity_id']) {
      expect(encode(message)).not.toContain(`"${privateField}"`);
    }
  });

  it.each(['BLOCKED', 'INSUFFICIENT_EVIDENCE'] as const)('accepts empty %s results', status => {
    const message = createDemoResearchMessage();
    message.preview = { status, cards: [] };
    expect(parseScoutReception(encode(message)).preview).toEqual({ status, cards: [] });
  });

  it.each(['command', 'payment', 'project', 'approval', 'private_state', 'endpoint',
    'tool_requests', '__proto__'])('rejects the additional envelope field %s', key => {
    const message = { ...createDemoResearchMessage(), [key]: { execute: true } };
    expect(() => parseScoutReception(encode(message))).toThrow('INVALID_RECEPTION_FIELDS');
  });

  it.each(Object.keys(createDemoResearchMessage()))('rejects missing field %s', key => {
    const message = createDemoResearchMessage() as unknown as Record<string, unknown>;
    delete message[key];
    expect(() => parseScoutReception(encode(message))).toThrow();
  });

  it.each([
    ['protocol', 'other'], ['protocol_version', 2], ['protocol_version', '1'],
    ['classification', 'REAL'], ['authentication', 'AUTHENTICATED'],
    ['execution_authorized', true], ['execution_authorized', 'false'],
    ['research_id', 'real-001'], ['research_id', 'demo-'],
    ['research_id', 'demo-' + 'x'.repeat(76)], ['research_id', 'demo-\n'],
    ['generated_at', '2026-02-30T00:00:00.000Z'],
    ['generated_at', '2026-01-01'], ['generated_at', '2026-01-01T00:00:00.000+00:00'],
    ['generated_at', null]
  ])('rejects invalid %s = %s', (key, value) => {
    expect(() => parseScoutReception(encode({ ...createDemoResearchMessage(), [key]: value })))
      .toThrow();
  });

  it.each(['null', '[]', '{}', '{', '"hello"', ''])('rejects malformed envelope %s', raw => {
    expect(() => parseScoutReception(raw)).toThrow();
  });

  it('rejects the regression case of a valid id followed by a final newline', () => {
    const message = createDemoResearchMessage();
    message.research_id = 'demo-valid\n';
    expect(() => parseScoutReception(encode(message))).toThrow('INVALID_RECEPTION_METADATA');
  });

  const controls = [
    ...Array.from({ length: 32 }, (_, code) => code),
    ...Array.from({ length: 33 }, (_, index) => index + 127),
    0x2028, 0x2029
  ];
  it.each(controls)('rejects control character U+%i anywhere in an id', code => {
    for (const id of [`${String.fromCodePoint(code)}demo-valid`,
      `demo-a${String.fromCodePoint(code)}b`, `demo-valid${String.fromCodePoint(code)}`]) {
      expect(() => parseScoutReception(encode({ ...createDemoResearchMessage(), research_id: id })))
        .toThrow('INVALID_RECEPTION_METADATA');
    }
  });

  it.each(['demo-valid\r\n', ' demo-valid', 'demo-valid ', 'DEMO-valid', 'x-demo-valid',
    'demo-a/b', 'demo-a\\b', 'demo-a.b', 'demo-é', 'demo-😀', '', null, 123])(
    'rejects malformed identifier %s without normalization', research_id => {
      expect(() => parseScoutReception(encode({ ...createDemoResearchMessage(), research_id })))
        .toThrow('INVALID_RECEPTION_METADATA');
    }
  );

  it.each(['demo-a', 'demo-' + 'A_0-z'.repeat(15)])('accepts length boundary %s', research_id => {
    expect(parseScoutReception(encode({ ...createDemoResearchMessage(), research_id })).research_id)
      .toBe(research_id);
  });

  it('rejects unknown fields in the preview and its cards', () => {
    const message = createDemoResearchMessage();
    expect(() => parseScoutReception(encode({ ...message,
      preview: { ...message.preview, command: 'launch' } }))).toThrow();
    expect(() => parseScoutReception(encode({ ...message, preview: { ...message.preview,
      cards: [{ ...message.preview.cards[0], command: 'launch' }] } }))).toThrow();
  });

  it.each([
    ['execution_authorized', true], ['cost_cents', 950], ['cost_cents', -1],
    ['cost_cents', 10001], ['cost_cents', 8.5], ['cost_basis', 'APPROVED'],
    ['source_status', 'AUTHENTICATED'], ['source_quote', 'too short'],
    ['source_quote', 'x'.repeat(181)], ['name', 'x'.repeat(81)],
    ['source_url', 'https://example.org/real'],
    ['source_url', 'http://demo.scout.invalid/tarifs'],
    ['source_url', 'https://demo.scout.invalid@evil.invalid/tarifs'],
    ['source_url', 'https://demo.scout.invalid/tarifs?secret=private'],
    ['source_url', 'https://demo.scout.invalid:443/tarifs']
  ])('retains card validation and fiction boundaries for %s = %s', (key, value) => {
    const message = createDemoResearchMessage();
    message.preview.cards[0] = { ...message.preview.cards[0], [key]: value };
    expect(() => parseScoutReception(encode(message))).toThrow();
  });

  it('retains the three-card limit and rejects cards in a blocked result', () => {
    const message = createDemoResearchMessage();
    const card = message.preview.cards[0];
    message.preview.cards = [card, card, card];
    expect(parseScoutReception(encode(message)).preview.cards).toHaveLength(3);
    message.preview.cards.push(card);
    expect(() => parseScoutReception(encode(message))).toThrow();
    message.preview = { status: 'BLOCKED', cards: [card] };
    expect(() => parseScoutReception(encode(message))).toThrow();
  });

  it('accepts unknown costs only with the UNKNOWN basis', () => {
    const message = createDemoResearchMessage();
    message.preview.cards[0].cost_cents = null;
    expect(() => parseScoutReception(encode(message))).toThrow();
    message.preview.cards[0].cost_basis = 'UNKNOWN';
    expect(parseScoutReception(encode(message)).preview.cards[0].cost_cents).toBeNull();
  });

  it('enforces the 12000-byte boundary including multibyte UTF-8 data', () => {
    const message = createDemoResearchMessage();
    message.preview.cards[0].name = '😀'.repeat(40);
    const raw = encode(message);
    const padded = raw + ' '.repeat(12000 - raw.length);
    expect(padded.length).toBe(12000);
    expect(() => parseScoutReception(padded)).toThrow('INVALID_RECEPTION_SIZE');
    const valid = encode(createDemoResearchMessage());
    const boundary = valid + ' '.repeat(12000 - Buffer.byteLength(valid));
    expect(parseScoutReception(boundary).research_id).toBe('demo-research-001');
    expect(() => parseScoutReception(boundary + ' ')).toThrow('INVALID_RECEPTION_SIZE');
  });
});
