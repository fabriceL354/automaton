import { createDemoResearchMessage } from '../../../../src/agent/research-reception';
import { parsePublicResearchEnvelope } from '../../../../src/agent/research-public-sync';
import type { PreparedReadOnlySyncTransport } from '../../../../src/agent/research-sync-https-preparation';
import type { ScoutSyncStore } from '../domain/scoutSyncSession';

export const DEMO_ENGINE_ID = 'engine-android-demo';

/** Explicit in-memory demonstration. No exporter, secret, HTTP client or account. */
export function createScoutDemoV2Transport(
  store: ScoutSyncStore,
  nowMs: () => number = Date.now
): PreparedReadOnlySyncTransport {
  return {
    mode: 'SIMULATED_HTTPS',
    async receive() {
      const previous = await store.load();
      if (previous?.protocol_version === 2 && previous.engine_id !== DEMO_ENGINE_ID) {
        throw new Error('WRONG_STORED_ENGINE');
      }
      const revision = previous?.protocol_version === 2 ? previous.revision + 1 : 1;
      const next = parsePublicResearchEnvelope(JSON.stringify({
        protocol: 'scout-research-result', protocol_version: 2,
        engine_id: DEMO_ENGINE_ID, research_id: 'research-android-demo', revision,
        generated_at: new Date(nowMs()).toISOString(), classification: 'PUBLIC_DISPLAY_ONLY',
        data_origin: 'FICTIONAL_TEST', authentication: 'UNAUTHENTICATED',
        execution_authorized: false, preview: createDemoResearchMessage().preview
      }));
      return JSON.stringify(next);
    }
  };
}
