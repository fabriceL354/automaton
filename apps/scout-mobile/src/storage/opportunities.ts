import * as SQLite from 'expo-sqlite';

export type Opportunity = {
  id: number;
  title: string;
  cost_cents: number | null;
  created_at: string;
};

let database: Promise<SQLite.SQLiteDatabase> | null = null;

function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!database) {
    database = (async () => {
      const db = await SQLite.openDatabaseAsync('scout-mobile.db');

      await db.execAsync(`
        PRAGMA journal_mode = WAL;

        CREATE TABLE IF NOT EXISTS opportunities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          cost_cents INTEGER,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      return db;
    })().catch(error => {
      database = null;
      throw error;
    });
  }

  return database;
}

export async function listOpportunities(): Promise<Opportunity[]> {
  const db = await getDatabase();

  return db.getAllAsync<Opportunity>(
    'SELECT * FROM opportunities ORDER BY id DESC LIMIT 100'
  );
}

export async function addOpportunity(
  title: string,
  costCents: number | null
): Promise<void> {
  const name = title.trim();

  if (!name || name.length > 80) {
    throw new Error('INVALID_TITLE');
  }

  if (
    costCents !== null &&
    (!Number.isSafeInteger(costCents) ||
      costCents < 0 ||
      costCents > 1000000)
  ) {
    throw new Error('INVALID_COST');
  }

  const db = await getDatabase();

  await db.runAsync(
    'INSERT INTO opportunities (title, cost_cents) VALUES (?, ?)',
    name,
    costCents
  );
}

export async function deleteOpportunity(id: number): Promise<void> {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('INVALID_ID');
  }

  const db = await getDatabase();

  await db.runAsync(
    'DELETE FROM opportunities WHERE id = ?',
    id
  );
}
