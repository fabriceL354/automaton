import { describe, expect, it } from 'vitest';
import { parseResearchResultFile } from '../../apps/scout-mobile/src/domain/researchResultFile';

const quote = 'Le tarif public est de 8,50 EUR par mois.';

function research() {
  return {
    version: '11.1',
    status: 'PASS',
    evidence: [{
      source_id: 'source-1',
      url: 'https://example.org/tarifs',
      text: `Tarifs : ${quote}`
    }],
    opportunities: [{
      name: 'Tableur fictif',
      kind: 'DURABLE_ASSET',
      estimated_cost_cents: 850,
      cost_basis: 'SOURCE_ESTIMATE',
      evidence: {
        source_id: 'source-1',
        url: 'https://example.org/tarifs',
        quote
      },
      execution_authorized: false
    }],
    security: {
      project_created: false,
      approval_created: false,
      external_action_executed: false,
      money_spent: false,
      capability_granted: false,
      installation_performed: false
    }
  };
}

describe('Scout Android - local research.json import', () => {
  it('projects the existing full research output without network calls', () => {
    const data = parseResearchResultFile(JSON.stringify(research()));
    expect(data.status).toBe('PASS');
    expect(data.cards).toHaveLength(1);
    expect(data.cards[0].cost_cents).toBe(850);
    expect(data.cards[0].execution_authorized).toBe(false);
  });

  it('also accepts the existing mobile preview contract', () => {
    const mobile = parseResearchResultFile(JSON.stringify(research()));
    expect(parseResearchResultFile(JSON.stringify(mobile))).toEqual(mobile);
  });

  it('shows no opportunities when research was blocked', () => {
    const data = research();
    data.status = 'BLOCKED';
    data.opportunities = [];
    const result = parseResearchResultFile(JSON.stringify(data));
    expect(result.status).toBe('BLOCKED');
    expect(result.cards).toHaveLength(0);
  });

  it('rejects evidence quoted from a different page', () => {
    const data = research();
    data.evidence[0].text = 'Contenu sans tarif.';
    expect(() => parseResearchResultFile(JSON.stringify(data))).toThrow();
  });

  it('rejects any execution permission', () => {
    const data = research();
    data.opportunities[0].execution_authorized = true;
    expect(() => parseResearchResultFile(JSON.stringify(data))).toThrow();
  });

  it('rejects unsafe recorded security flags', () => {
    const data = research();
    data.security.money_spent = true;
    expect(() => parseResearchResultFile(JSON.stringify(data))).toThrow();
  });

  it('rejects unsupported versions and oversized input', () => {
    const data = research();
    data.version = '15.0';
    expect(() => parseResearchResultFile(JSON.stringify(data))).toThrow();
    expect(() => parseResearchResultFile('x'.repeat(131073))).toThrow();
  });

  it('rejects a missing source and duplicate source ids', () => {
    const data = research();
    data.opportunities[0].evidence.source_id = 'unknown-source';
    expect(() => parseResearchResultFile(JSON.stringify(data))).toThrow();
    const duplicate = research();
    duplicate.evidence.push({ ...duplicate.evidence[0] });
    expect(() => parseResearchResultFile(JSON.stringify(duplicate))).toThrow();
  });
});
