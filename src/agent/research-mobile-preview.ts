import type { ResearchOutput } from './research-controller.js';

import {
  quoteAppearsInReadPage,
  quotedCostMatches
} from './research-evidence-policy.js';

export type MobileResearchInput = Pick<
  ResearchOutput,
  'status' | 'evidence' | 'opportunities'
>;

/**
 * Projection des recherches Scout pour Android.
 * Lecture seule : aucune recherche, aucun paiement.
 * Une citation concordante ne prouve pas
 * l'authenticite ou l'actualite de la page.
 */
export function toMobileResearchPreview(
  input: MobileResearchInput
) {
  const cards: {
    name: string;
    kind: string;
    cost_cents: number | null;
    cost_basis: string;
    source_url: string;
    source_quote: string;
    source_status: 'RECORDED_QUOTE_MATCH';
    execution_authorized: false;
  }[] = [];

  if (input.status !== 'PASS') {
    return { status: input.status, cards };
  }

  const sources = new Map(
    input.evidence.map(source => [source.source_id, source])
  );

  for (const opportunity of input.opportunities) {
    const source = sources.get(opportunity.evidence.source_id);
    const quote = opportunity.evidence.quote;
    const cost = opportunity.estimated_cost_cents;
    const basis = opportunity.cost_basis;

    if (
      !source ||
      source.url !== opportunity.evidence.url ||
      !quoteAppearsInReadPage(source.text, quote) ||
      opportunity.execution_authorized !== false
    ) {
      continue;
    }

    if (
      cost !== null &&
      (!Number.isSafeInteger(cost) || cost < 0 || cost > 10000)
    ) {
      continue;
    }

    if ((cost === null) !== (basis === 'UNKNOWN')) {
      continue;
    }

    if (
      basis === 'SOURCE_ESTIMATE' &&
      (cost === null || !quotedCostMatches(quote, cost))
    ) {
      continue;
    }

    cards.push({
      name: opportunity.name,
      kind: opportunity.kind,
      cost_cents: cost,
      cost_basis: basis,
      source_url: source.url,
      source_quote: quote,
      source_status: 'RECORDED_QUOTE_MATCH',
      execution_authorized: false
    });
  }

  return { status: input.status, cards };
}
