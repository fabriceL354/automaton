import { toMobileResearchPreview } from './research-mobile-preview.js';

/** Public display data only. Version 1 is deliberately restricted to fiction. */
export const RESEARCH_RECEPTION_MAX_BYTES = 12000;

export type ResearchReceptionMessage = {
  protocol: 'scout-research-result';
  protocol_version: 1;
  research_id: string;
  generated_at: string;
  classification: 'FICTIONAL_DEMO';
  authentication: 'UNAUTHENTICATED';
  execution_authorized: false;
  preview: ReturnType<typeof toMobileResearchPreview>;
};

/** No controller call, private state, clock, network or real research input. */
export function createDemoResearchMessage(): ResearchReceptionMessage {
  const url = 'https://demo.scout.invalid/tarifs';
  const quote = 'Donnée fictive : le coût indiqué est de 8,50 EUR par mois.';
  return {
    protocol: 'scout-research-result',
    protocol_version: 1,
    research_id: 'demo-research-001',
    generated_at: '2026-01-01T00:00:00.000Z',
    classification: 'FICTIONAL_DEMO',
    authentication: 'UNAUTHENTICATED',
    execution_authorized: false,
    preview: toMobileResearchPreview({
      status: 'PASS',
      evidence: [{ source_id: 'demo-source-1', url, text: quote,
        query_id: 'demo-query-1', round: 0 }],
      opportunities: [{
        opportunity_id: 'demo-opportunity-1',
        name: 'Tableur fictif de démonstration',
        kind: 'DURABLE_ASSET',
        classification: 'IN_BUDGET_CANDIDATE',
        estimated_cost_cents: 850,
        cost_basis: 'SOURCE_ESTIMATE',
        budget_excess_cents: 0,
        summary: 'Démonstration fictive uniquement.',
        human_minutes_daily: 0,
        market: 'Fictif', platform: 'Fictive', fees: 'Fictifs', account_required: false,
        evidence: { source_id: 'demo-source-1', url, quote },
        risks: ['Données fictives non authentifiées.'],
        reason_surfaced: 'Démonstration locale.',
        mini_test: { possible: false, estimated_cost_cents: null, description: 'Désactivé.' },
        first_question: 'Démonstration uniquement.',
        score: 0,
        execution_authorized: false
      }]
    })
  };
}
