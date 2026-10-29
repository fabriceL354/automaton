import { parsePublicResearchEnvelope, type PublicResearchEnvelope }
  from '../../../../src/agent/research-public-sync';
import type { PreparedReadOnlySyncTransport } from '../../../../src/agent/research-sync-https-preparation';
import { createValidatedReceptionStore, type ReceptionDatabase, type ValidatedReceptionStore }
  from '../storage/scoutReceptionStore';

/** Open a separate experimental database when this is eventually wired to UI. */
export function createPublicResearchStore(open: () => Promise<ReceptionDatabase>) {
  return createValidatedReceptionStore(open, parsePublicResearchEnvelope);
}

export function createPublicResearchReceiver(
  transport: PreparedReadOnlySyncTransport,
  store: ValidatedReceptionStore<PublicResearchEnvelope>,
  policy: { engineId: string; nowMs: () => number; maxAgeMs?: number }
) {
  const engineId = policy.engineId;
  const nowMs = policy.nowMs;
  const maxAgeMs = policy.maxAgeMs ?? 300000;
  if (!/^engine-[A-Za-z0-9_-]{1,64}(?![\s\S])/.test(engineId) ||
      !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 86400000) throw new Error('INVALID_SYNC_POLICY');
  let busy = false;
  return {
    // Offline reads intentionally do not enforce receipt freshness or use transport.
    async load() {
      const saved = await store.load();
      if (saved && saved.engine_id !== engineId) throw new Error('WRONG_STORED_ENGINE');
      return saved;
    },
    async receive() {
      if (transport.mode !== 'SIMULATED_HTTPS') throw new Error('REAL_SYNC_DISABLED');
      if (busy) throw new Error('SYNC_RECEIVER_BUSY');
      busy = true;
      try {
        const next = parsePublicResearchEnvelope(await transport.receive());
        const now = nowMs(), generated = Date.parse(next.generated_at);
        if (!Number.isSafeInteger(now) || next.engine_id !== engineId ||
            generated > now + 30000 || now - generated > maxAgeMs) throw new Error('STALE_OR_WRONG_ENGINE_RESULT');
        const previous = await store.load();
        if (previous) {
          if (previous.engine_id !== engineId || next.revision < previous.revision ||
              generated < Date.parse(previous.generated_at)) throw new Error('SYNC_ROLLBACK_REFUSED');
          if (next.revision === previous.revision) {
            if (JSON.stringify(next) !== JSON.stringify(previous)) throw new Error('SYNC_REVISION_CONFLICT');
            return previous;
          }
        }
        return await store.save(JSON.stringify(next));
      } finally { busy = false; }
    }
  };
}
