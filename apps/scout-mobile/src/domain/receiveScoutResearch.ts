import { parseScoutReception } from './scoutReception';
import type { ResearchReceptionStore } from '../storage/scoutReceptionStore';
import type { ReadOnlyResearchTransport } from '../transport/scoutReceptionTransport';

export async function receiveScoutResearch(
  transport: ReadOnlyResearchTransport,
  store: ResearchReceptionStore
) {
  if (transport.mode !== 'SIMULATED') {
    throw new Error('SCOUT_REAL_CONNECTION_DISABLED');
  }
  const result = parseScoutReception(await transport.receive());
  return store.save(JSON.stringify(result));
}
