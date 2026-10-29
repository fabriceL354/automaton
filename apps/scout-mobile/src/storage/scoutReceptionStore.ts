import { parseScoutReception, type ReceivedResearch } from '../domain/scoutReception';

/** Minimal SQLite port, implemented by Expo and exercised against real SQLite. */
export interface ReceptionDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, payload: string): Promise<unknown>;
  getFirstAsync<T>(sql: string): Promise<T | null>;
}

export interface ValidatedReceptionStore<T> {
  save(raw: string): Promise<T>;
  load(): Promise<T | null>;
}

export type ResearchReceptionStore = ValidatedReceptionStore<ReceivedResearch>;

export function createResearchReceptionStore(
  open: () => Promise<ReceptionDatabase>
): ResearchReceptionStore {
  return createValidatedReceptionStore(open, parseScoutReception);
}

/** Reuse the local singleton storage with a caller-selected strict codec. */
export function createValidatedReceptionStore<T>(
  open: () => Promise<ReceptionDatabase>,
  decode: (raw: string) => T
): ValidatedReceptionStore<T> {
  let database: Promise<ReceptionDatabase> | null = null;
  function getDatabase() {
    if (!database) {
      database = (async () => {
        const db = await open();
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS latest_research (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            payload TEXT NOT NULL CHECK (
              length(CAST(payload AS BLOB)) BETWEEN 1 AND 12000
            )
          );
        `);
        return db;
      })().catch(error => { database = null; throw error; });
    }
    return database;
  }
  return {
    async save(raw) {
      // Validate before opening storage. Atomic singleton replacement, no manual records.
      const result = decode(raw);
      const db = await getDatabase();
      await db.runAsync(
        'INSERT INTO latest_research (id, payload) VALUES (1, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET payload = excluded.payload',
        JSON.stringify(result)
      );
      return result;
    },
    async load() {
      const db = await getDatabase();
      const row = await db.getFirstAsync<{ payload: string }>(
        'SELECT payload FROM latest_research WHERE id = 1'
      );
      // Stored content is untrusted too; never display it without revalidation.
      return row ? decode(row.payload) : null;
    }
  };
}
