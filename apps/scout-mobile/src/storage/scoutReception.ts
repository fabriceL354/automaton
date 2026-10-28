import { openDatabaseAsync } from 'expo-sqlite';
import { createResearchReceptionStore } from './scoutReceptionStore';

// Physically separate from scout-mobile.db and its manually created opportunities.
export const scoutReceptionStore = createResearchReceptionStore(
  () => openDatabaseAsync('scout-reception.db')
);
