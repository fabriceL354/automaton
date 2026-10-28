import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoResearchMessage } from '../agent/research-reception.js';
import { createResearchReceptionStore, type ReceptionDatabase }
  from '../../apps/scout-mobile/src/storage/scoutReceptionStore';

const databases: Database.Database[] = [];
const directories: string[] = [];
function open(path = ':memory:') {
  const db = new Database(path);
  databases.push(db);
  const port: ReceptionDatabase = {
    async execAsync(sql) { db.exec(sql); },
    async runAsync(sql, payload) { return db.prepare(sql).run(payload); },
    async getFirstAsync<T>(sql: string) { return (db.prepare(sql).get() ?? null) as T | null; }
  };
  return { db, store: createResearchReceptionStore(async () => port) };
}
const raw = () => JSON.stringify(createDemoResearchMessage());

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe('Scout reception: actual SQLite storage and offline reload', () => {
  it('loads an empty store without a transport', async () => {
    expect(await open().store.load()).toBeNull();
  });

  it('survives closing and reopening a file-backed SQLite database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'scout-reception-'));
    directories.push(directory);
    const path = join(directory, 'reception.db');
    const first = open(path);
    const saved = await first.store.save(raw());
    first.db.close();
    const reopened = open(path);
    expect(await reopened.store.load()).toEqual(saved);
  });

  it('keeps only the latest validated result', async () => {
    const { store, db } = open();
    await store.save(raw());
    const next = createDemoResearchMessage();
    next.research_id = 'demo-next';
    next.preview = { status: 'BLOCKED', cards: [] };
    await store.save(JSON.stringify(next));
    expect(await store.load()).toEqual(next);
    expect(db.prepare('SELECT count(*) AS n FROM latest_research').get()).toEqual({ n: 1 });
  });

  it('does not overwrite the previous result when validation fails', async () => {
    const { store } = open();
    const previous = await store.save(raw());
    await expect(store.save(JSON.stringify({ ...previous, command: 'pay' }))).rejects.toThrow();
    expect(await store.load()).toEqual(previous);
  });

  it('revalidates persisted rows and refuses corrupt or unauthorized data', async () => {
    const { store, db } = open();
    await store.save(raw());
    db.prepare('UPDATE latest_research SET payload = ?').run(JSON.stringify({
      ...createDemoResearchMessage(), execution_authorized: true
    }));
    await expect(store.load()).rejects.toThrow();
    db.prepare('UPDATE latest_research SET payload = ?').run('{');
    await expect(store.load()).rejects.toThrow();
  });

  it('uses bound SQL parameters and does not alter manual opportunities', async () => {
    const { store, db } = open();
    db.exec("CREATE TABLE opportunities (title TEXT); INSERT INTO opportunities VALUES ('Manuel');");
    const message = createDemoResearchMessage();
    message.preview.cards[0].name = "Fictif '); DROP TABLE opportunities; --";
    await store.save(JSON.stringify(message));
    expect((await store.load())?.preview.cards[0].name).toBe(message.preview.cards[0].name);
    expect(db.prepare('SELECT * FROM opportunities').all()).toEqual([{ title: 'Manuel' }]);
  });

  it('rejects invalid data before opening SQLite', async () => {
    let opens = 0;
    const store = createResearchReceptionStore(async () => { opens++; throw new Error('offline'); });
    await expect(store.save('{}')).rejects.toThrow('INVALID_RECEPTION_FIELDS');
    expect(opens).toBe(0);
  });

  it('allows a later retry after storage initialization fails', async () => {
    const { db } = open();
    let attempts = 0;
    const store = createResearchReceptionStore(async () => {
      attempts++;
      if (attempts === 1) throw new Error('unavailable');
      return {
        async execAsync(sql) { db.exec(sql); },
        async runAsync(sql, payload) { return db.prepare(sql).run(payload); },
        async getFirstAsync<T>(sql: string) { return (db.prepare(sql).get() ?? null) as T | null; }
      };
    });
    await expect(store.load()).rejects.toThrow('unavailable');
    expect(await store.load()).toBeNull();
    expect(attempts).toBe(2);
  });

  it('enforces the singleton and byte limits inside SQLite too', async () => {
    const { store, db } = open();
    await store.load();
    expect(() => db.prepare('INSERT INTO latest_research VALUES (2, ?)').run(raw())).toThrow();
    expect(() => db.prepare('INSERT INTO latest_research VALUES (1, ?)').run('é'.repeat(6001)))
      .toThrow();
  });
});
