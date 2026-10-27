import { describe, expect, it } from 'vitest';

import {
  parseMobileResearchImport
} from '../../apps/scout-mobile/src/domain/mobileResearchImport';

function sample() {
  return {
    status: 'PASS',
    cards: [{
      name: 'Tableur fictif',
      kind: 'DURABLE_ASSET',
      cost_cents: 850,
      cost_basis: 'SOURCE_ESTIMATE',
      source_url: 'https://example.org/tarifs',
      source_quote: 'Le tarif public est de 8,50 EUR par mois.',
      source_status: 'RECORDED_QUOTE_MATCH',
      execution_authorized: false
    }]
  };
}

describe('Scout Android - import lecture seule', () => {
  it('accepte une structure de demonstration coherente', () => {
    const result = parseMobileResearchImport(
      JSON.stringify(sample())
    );
    expect(result.cards).toHaveLength(1);
  });

  it('refuse une autorisation d execution', () => {
    const data = sample();
    data.cards[0].execution_authorized = true;
    expect(() => parseMobileResearchImport(
      JSON.stringify(data)
    )).toThrow();
  });

  it('refuse un coût non concordant', () => {
    const data = sample();
    data.cards[0].cost_cents = 950;
    expect(() => parseMobileResearchImport(
      JSON.stringify(data)
    )).toThrow();
  });

  it('refuse des cartes dans un statut bloque', () => {
    const data = sample();
    data.status = 'BLOCKED';
    expect(() => parseMobileResearchImport(
      JSON.stringify(data)
    )).toThrow();
  });

  it('refuse une source non HTTPS', () => {
    const data = sample();
    data.cards[0].source_url = 'http://example.org';
    expect(() => parseMobileResearchImport(
      JSON.stringify(data)
    )).toThrow();
  });

  it('refuse un document trop long', () => {
    expect(() => parseMobileResearchImport(
      'x'.repeat(12001)
    )).toThrow();
  });
});
