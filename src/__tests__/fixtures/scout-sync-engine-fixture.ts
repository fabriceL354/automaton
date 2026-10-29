import type { PublicExportMetadata } from '../../agent/research-public-export.js';

export const SYNC_FIXTURE_NOW = Date.parse('2026-01-01T00:00:00.000Z');
export const SYNC_FIXTURE_PRIVATE = 'private-fixture-never-export';
export function syncFixtureMetadata(): PublicExportMetadata {
  return { engine_id: 'engine-fixture', research_id: 'research-fixture-1', revision: 1,
    generated_at: '2026-01-01T00:00:00.000Z', data_origin: 'FICTIONAL_TEST' };
}
export function syncFixtureResearch() {
  const url = 'https://demo.scout.invalid/tarifs';
  const quote = 'Citation fictive : le coût indiqué est de 8,50 EUR par mois.';
  return {
    version: '11.1', status: 'PASS',
    private_state: { secret: SYNC_FIXTURE_PRIVATE },
    queries: [{ internal: SYNC_FIXTURE_PRIVATE }], metrics: { internal: SYNC_FIXTURE_PRIVATE },
    operator_attention: [SYNC_FIXTURE_PRIVATE], tool_requests: [SYNC_FIXTURE_PRIVATE],
    evidence: [{ source_id: 'source-fixture-1', url, text: `${SYNC_FIXTURE_PRIVATE}. ${quote}`, query_id: 'query-fixture-1', round: 1 }],
    opportunities: [{ name: 'Résultat moteur entièrement fictif', kind: 'DURABLE_ASSET',
      estimated_cost_cents: 850, cost_basis: 'SOURCE_ESTIMATE',
      evidence: { source_id: 'source-fixture-1', url, quote }, execution_authorized: false }],
    security: { project_created: false, approval_created: false, external_action_executed: false,
      money_spent: false, capability_granted: false, installation_performed: false }
  };
}
