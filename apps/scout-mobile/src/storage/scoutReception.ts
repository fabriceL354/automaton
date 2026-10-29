import { openDatabaseAsync } from 'expo-sqlite';
import { createScoutSyncStore } from '../domain/scoutSyncSession';

// Physically separate from scout-mobile.db and its manually created opportunities.
export const scoutReceptionStore = createScoutSyncStore(
  () => openDatabaseAsync('scout-reception.db')
);
