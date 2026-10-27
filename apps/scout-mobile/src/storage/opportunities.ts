import * as SQLite from 'expo-sqlite';

export type Opportunity = {
  id: number;
  title: string;
  cost_cents: number | null;
  created_at: string;
  description: string;
  risks: string;
  sources: string;
  status: 'A_ETUDIER' | 'EN_ANALYSE' | 'REFUSEE';
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

      // Migration additive : conserver les opportunites existantes.
      const existing = await db.getAllAsync<{ name: string }>(
        'PRAGMA table_info(opportunities)'
      );

      const columns = new Set(existing.map(row => row.name));

      const additions = [
        ['description', "TEXT NOT NULL DEFAULT ''"],
        ['risks', "TEXT NOT NULL DEFAULT ''"],
        ['sources', "TEXT NOT NULL DEFAULT ''"],
        ['status', "TEXT NOT NULL DEFAULT 'A_ETUDIER'"]
      ] as const;

      for (const [column, definition] of additions) {
        if (!columns.has(column)) {
          await db.execAsync(
            `ALTER TABLE opportunities ADD COLUMN ${column} ${definition}`
          );
        }
      }

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


export async function updateOpportunityDetails(
  id: number,
  description: string,
  risks: string,
  sources: string,
  status: Opportunity['status']
): Promise<void> {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('INVALID_ID');
  }

  if (
    description.length > 2000 ||
    risks.length > 1000 ||
    sources.length > 1500
  ) {
    throw new Error('TEXT_TOO_LONG');
  }

  if (!['A_ETUDIER', 'EN_ANALYSE', 'REFUSEE'].includes(status)) {
    throw new Error('INVALID_STATUS');
  }

  const db = await getDatabase();

  const result = await db.runAsync(
    `UPDATE opportunities
     SET description = ?,
         risks = ?,
         sources = ?,
         status = ?
     WHERE id = ?`,
    description.trim(),
    risks.trim(),
    sources.trim(),
    status,
    id
  );

  if (result.changes !== 1) {
    throw new Error('OPPORTUNITY_NOT_FOUND');
  }
}
