import { parseScoutReception, type ReceivedResearch } from './scoutReception';
import { createPublicResearchReceiver } from './publicResearchSync';
import { parsePublicResearchEnvelope, PUBLIC_SYNC_MAX_BYTES, utf8Bytes,
  type PublicResearchEnvelope } from '../../../../src/agent/research-public-sync';
import { createPreparedHttpsTransport, type PreparedReadOnlySyncTransport }
  from '../../../../src/agent/research-sync-https-preparation';
import { createValidatedReceptionStore, type ReceptionDatabase,
  type ValidatedReceptionStore } from '../storage/scoutReceptionStore';

export type SavedScoutResearch = ReceivedResearch | PublicResearchEnvelope;
export type ScoutSyncStore = ValidatedReceptionStore<SavedScoutResearch>;

/** Strict version dispatch. Never reinterpret a rejected V2 message as V1. */
export function parseSavedScoutResearch(raw: string): SavedScoutResearch {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > PUBLIC_SYNC_MAX_BYTES ||
      utf8Bytes(raw) > PUBLIC_SYNC_MAX_BYTES) throw new Error('INVALID_RECEPTION_SIZE');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_SYNC_VERSION');
  const version = (value as Record<string, unknown>).protocol_version;
  if (version === 1) return parseScoutReception(raw);
  if (version === 2) return parsePublicResearchEnvelope(raw);
  throw new Error('INVALID_SYNC_VERSION');
}

/** Same database, table and singleton as V1. Legacy rows need no destructive migration. */
export function createScoutSyncStore(open: () => Promise<ReceptionDatabase>): ScoutSyncStore {
  return createValidatedReceptionStore(open, parseSavedScoutResearch);
}

export function createScoutSyncSession(
  store: ScoutSyncStore,
  policy: { engineId: string; nowMs: () => number; maxAgeMs?: number },
  transport: PreparedReadOnlySyncTransport = createPreparedHttpsTransport()
) {
  const receiver = createPublicResearchReceiver(transport, {
    async load() {
      const previous = await store.load();
      return previous?.protocol_version === 2 ? previous : null;
    },
    async save(raw) {
      // The new receiver can write V2 only; a failed save preserves the V1 row.
      const next = parsePublicResearchEnvelope(raw);
      const saved = await store.save(JSON.stringify(next));
      if (saved.protocol_version !== 2) throw new Error('INVALID_SYNC_VERSION');
      return saved;
    }
  }, policy);
  return {
    async load(): Promise<SavedScoutResearch | null> {
      const saved = await store.load();
      if (saved?.protocol_version === 2 && saved.engine_id !== policy.engineId) {
        throw new Error('WRONG_STORED_ENGINE');
      }
      return saved;
    },
    receive: () => receiver.receive()
  };
}
