import { describe, expect, it } from 'vitest';

import {
  toMobileResearchPreview,
  type MobileResearchInput
} from '../agent/research-mobile-preview.js';

const quote = 'Le tarif public est de 8,50 EUR par mois.';

function fixture(): MobileResearchInput {
  return {
    status: 'PASS',
    evidence: [{
      source_id: 'source-1',
      url: 'https://example.org/tarifs',
      text: `Page consultee : ${quote}`,
      query_id: 'query-1',
      round: 1
    }],
    opportunities: [{
      name: 'Modele de tableur',
      kind: 'DURABLE_ASSET',
      estimated_cost_cents: 850,
      cost_basis: 'SOURCE_ESTIMATE',
      evidence: {
        source_id: 'source-1',
        url: 'https://example.org/tarifs',
        quote
      },
      execution_authorized: false
    }] as MobileResearchInput['opportunities']
  };
}

describe('Scout - pont de resultats Android', () => {
  it('transmet une recherche coherente', () => {
    const result = toMobileResearchPreview(fixture());

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].cost_cents).toBe(850);
    expect(result.cards[0].execution_authorized).toBe(false);
  });

  it('ne transmet rien si la recherche est bloquee', () => {
    const data = fixture();
    data.status = 'BLOCKED';

    expect(toMobileResearchPreview(data).cards)
      .toHaveLength(0);
  });

  it('refuse une citation absente', () => {
    const data = fixture();
    data.evidence[0].text = 'Page sans tarif';

    expect(toMobileResearchPreview(data).cards)
      .toHaveLength(0);
  });

  it('refuse un montant different de la citation', () => {
    const data = fixture();
    data.opportunities[0].estimated_cost_cents = 950;

    expect(toMobileResearchPreview(data).cards)
      .toHaveLength(0);
  });

  it('refuse une source differente', () => {
    const data = fixture();
    data.opportunities[0].evidence.url =
      'https://example.org/autre-page';

    expect(toMobileResearchPreview(data).cards)
      .toHaveLength(0);
  });

  it('ne laisse passer aucune autorisation', () => {
    const data = fixture();

    (data.opportunities[0] as unknown as {
      execution_authorized: boolean
    }).execution_authorized = true;

    expect(toMobileResearchPreview(data).cards)
      .toHaveLength(0);
  });
});
