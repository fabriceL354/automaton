import { describe, expect, it } from 'vitest';

import {
  quoteAppearsInReadPage,
  quotedCostMatches
} from '../agent/research-evidence-policy.js';

import {
  parseOpportunityPhases
} from '../agent/research-model.js';

const quote = 'Le tarif annonce est de 8,50 EUR par mois.';
const sourceText = `Page publique : ${quote}`;

const candidate = {
  name: 'Modele de tableur',
  kind: 'DURABLE_ASSET' as const,
  source_index: 0
};

const sources = [{
  source_id: 'source-test',
  url: 'https://example.org/tarifs',
  text: sourceText,
  query_id: 'query-test',
  round: 1
}];

function evaluate(cost = 850, text = sourceText) {
  return parseOpportunityPhases(
    candidate,
    JSON.stringify({
      summary: 'Creation de tableur numerique',
      estimated_cost_cents: cost,
      cost_basis: 'SOURCE_ESTIMATE',
      human_minutes_daily: 10,
      account_required: false
    }),
    JSON.stringify({
      market: 'Marche francais',
      platform: 'Plateforme numerique',
      fees: 'Frais annonces',
      quote
    }),
    JSON.stringify({
      risks: ['Aucune vente demontree'],
      reason_surfaced: 'Tarif documente',
      mini_test_possible: true,
      mini_test_cost_cents: 850,
      mini_test_description: 'Essai fictif'
    }),
    [{ ...sources[0], text }],
    0
  );
}

describe('Scout — preuves economiques communes', () => {
  it('accepte une citation presente dans la page', () => {
    expect(quoteAppearsInReadPage(sourceText, quote))
      .toBe(true);
  });

  it('refuse une citation trop courte', () => {
    expect(quoteAppearsInReadPage(sourceText, '8,50 EUR'))
      .toBe(false);
  });

  it('refuse une citation absente', () => {
    expect(quoteAppearsInReadPage(
      sourceText,
      'Le prix est de 9,50 EUR par mois.'
    )).toBe(false);
  });

  it('retrouve le montant exact dans la citation', () => {
    expect(quotedCostMatches(quote, 850)).toBe(true);
  });

  it('refuse un montant different', () => {
    expect(quotedCostMatches(quote, 950)).toBe(false);
  });

  it('reconnait un montant gratuit explicitement cite', () => {
    expect(quotedCostMatches(
      'Le service est gratuit sans investissement.',
      0
    )).toBe(true);
  });

  it('refuse les montants invalides', () => {
    expect(quotedCostMatches(quote, -1)).toBe(false);
    expect(quotedCostMatches(quote, 8.5)).toBe(false);
  });

  it('accepte une evaluation structuree coherente', () => {
    const result = evaluate();

    expect(result.estimated_cost_cents).toBe(850);
    expect(result.execution_authorized).toBe(false);
  });

  it('refuse un prix non justifie par la citation', () => {
    expect(() => evaluate(950))
      .toThrow('Exact cost quotation required');
  });

  it('refuse une citation absente de la page lue', () => {
    expect(() => evaluate(
      850,
      'Cette page ne contient aucun tarif.'
    )).toThrow('Evidence must quote a page actually read');
  });
});
