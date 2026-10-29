import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoResearchMessage } from '../agent/research-reception.js';
import { createResearchReceptionStore, type ReceptionDatabase }
  from '../../apps/scout-mobile/src/storage/scoutReceptionStore';
import { createScoutSyncSession, createScoutSyncStore, parseSavedScoutResearch }
  from '../../apps/scout-mobile/src/domain/scoutSyncSession';
import { createScoutDemoV2Transport, DEMO_ENGINE_ID }
  from '../../apps/scout-mobile/src/transport/scoutDemoV2Transport';

const databases: Database.Database[] = [], folders: string[] = [];
const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const policy = () => ({ engineId: DEMO_ENGINE_ID, nowMs: () => NOW });
function open(path = ':memory:') {
  const db = new Database(path); databases.push(db);
  const port: ReceptionDatabase = {
    async execAsync(sql) { db.exec(sql); },
    async runAsync(sql, payload) { return db.prepare(sql).run(payload); },
    async getFirstAsync<T>(sql: string) { return (db.prepare(sql).get() ?? null) as T | null; }
  };
  const store = createScoutSyncStore(async () => port);
  return { db, port, store, session: createScoutSyncSession(store, policy(),
    createScoutDemoV2Transport(store, () => NOW)) };
}
async function rawV2() {
  const { store } = open();
  return createScoutDemoV2Transport(store, () => NOW).receive();
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true });
});

describe('Android screen session V2: legacy migration and actual SQLite', () => {
  it('starts empty and never requires a transport for offline loading', async () => {
    const { store } = open();
    expect(await createScoutSyncSession(store, policy()).load()).toBeNull();
  });

  it('reads a V1 database unchanged, replaces its singleton with V2, and reopens offline', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'scout-ui-v2-')); folders.push(folder);
    const path = join(folder, 'scout-reception.db');
    const legacy = open(path);
    const old = await createResearchReceptionStore(async () => legacy.port)
      .save(JSON.stringify(createDemoResearchMessage()));
    const oldRow = legacy.db.prepare('SELECT payload FROM latest_research').get();
    legacy.db.close();
    const upgraded = open(path);
    expect(await upgraded.session.load()).toEqual(old);
    expect(upgraded.db.prepare('SELECT payload FROM latest_research').get()).toEqual(oldRow);
    const next = await upgraded.session.receive();
    expect(next.protocol_version).toBe(2);
    expect(next.revision).toBe(1);
    expect(upgraded.db.prepare('SELECT count(*) AS n FROM latest_research').get()).toEqual({ n: 1 });
    expect(upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())
      .toEqual([{ name: 'latest_research' }]);
    upgraded.db.close();
    const restarted = open(path);
    const receive = vi.fn(() => { throw new Error('NO_TRANSPORT_WHEN_OFFLINE'); });
    const offline = createScoutSyncSession(restarted.store,
      { engineId: DEMO_ENGINE_ID, nowMs: () => NOW + 864000000 },
      { mode: 'HTTPS_DISABLED', receive });
    expect(await offline.load()).toEqual(next);
    expect(receive).not.toHaveBeenCalled();
    expect((await restarted.session.receive()).revision).toBe(2);
  });

  it('does not open a second cache or change manual opportunities', async () => {
    const { db, session } = open();
    db.exec("CREATE TABLE opportunities(title TEXT); INSERT INTO opportunities VALUES('Manuel');");
    await session.receive(); await session.receive();
    expect(db.prepare('SELECT * FROM opportunities').all()).toEqual([{ title: 'Manuel' }]);
    expect(db.prepare('SELECT count(*) AS n FROM latest_research').get()).toEqual({ n: 1 });
  });

  it('keeps V1 when a V2 SQLite write fails', async () => {
    const { store, db, session } = open();
    const old = await store.save(JSON.stringify(createDemoResearchMessage()));
    db.exec("CREATE TRIGGER deny_update BEFORE UPDATE ON latest_research BEGIN SELECT RAISE(ABORT, 'full'); END;");
    await expect(session.receive()).rejects.toThrow('full');
    expect(await session.load()).toEqual(old);
  });

  it('has disabled transport by default, even with a stored result', async () => {
    const { store, session } = open(); const old = await session.receive();
    await expect(createScoutSyncSession(store, policy()).receive()).rejects.toThrow('REAL_SYNC_DISABLED');
    expect(await session.load()).toEqual(old);
  });

  it('demo V2 reception never calls fetch and remains explicitly unauthenticated', async () => {
    const fetch = vi.fn(() => { throw new Error('NO_NETWORK'); }); vi.stubGlobal('fetch', fetch);
    const { session } = open(); const next = await session.receive();
    expect(next.data_origin).toBe('FICTIONAL_TEST');
    expect(next.authentication).toBe('UNAUTHENTICATED');
    expect(next.execution_authorized).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['{', 'null', '[]', '{}', 'x'.repeat(12001), 'é'.repeat(6001)])
    ('rejects malformed/oversize content before opening SQLite (%#)', async raw => {
      const openDatabase = vi.fn(); const store = createScoutSyncStore(openDatabase);
      await expect(store.save(raw)).rejects.toThrow();
      expect(openDatabase).not.toHaveBeenCalled();
    });

  it.each([
    { protocol_version: 3 }, { protocol_version: '2' }, { command: 'pay' },
    { execution_authorized: true }, { authentication: 'AUTHENTICATED' }, { revision: 0 }
  ])('never downgrades invalid V2 to V1 or replaces the valid row (%j)', async change => {
    const { store, session } = open(); const old = await session.receive();
    await expect(store.save(JSON.stringify({ ...old, ...change }))).rejects.toThrow();
    expect(await session.load()).toEqual(old);
  });

  it('keeps legacy data on malformed transport responses', async () => {
    const { store } = open(); const old = await store.save(JSON.stringify(createDemoResearchMessage()));
    const session = createScoutSyncSession(store, policy(), { mode: 'SIMULATED_HTTPS', async receive() { return '{'; } });
    await expect(session.receive()).rejects.toThrow();
    expect(await session.load()).toEqual(old);
  });

  it('revalidates disk corruption and unknown versions on offline reads', async () => {
    const { db, session } = open(); await session.receive();
    for (const raw of ['{', JSON.stringify({ protocol_version: 99 })]) {
      db.prepare('UPDATE latest_research SET payload=?').run(raw);
      await expect(session.load()).rejects.toThrow();
    }
  });

  it('does not display or replace a V2 result belonging to another engine', async () => {
    const { store, session } = open();
    await store.save(JSON.stringify({ ...JSON.parse(await rawV2()), engine_id: 'engine-other' }));
    await expect(session.load()).rejects.toThrow('WRONG_STORED_ENGINE');
    await expect(session.receive()).rejects.toThrow('WRONG_STORED_ENGINE');
  });

  it.each([{ revision: 1 }, { revision: 2, research_id: 'research-conflict' },
    { revision: 3, generated_at: new Date(NOW - 300001).toISOString() }])
    ('preserves V2 revision checks through the UI adapter (%j)', async change => {
      const { store, session } = open(); await session.receive(); const old = await session.receive();
      const receiver = createScoutSyncSession(store, policy(), { mode: 'SIMULATED_HTTPS', async receive() {
        return JSON.stringify({ ...old, ...change });
      } });
      await expect(receiver.receive()).rejects.toThrow();
      expect(await session.load()).toEqual(old);
    });

  it('refuses a double reception while preserving the first pending write', async () => {
    const { store } = open(); const raw = await rawV2();
    let resolve!: (value: string) => void;
    const session = createScoutSyncSession(store, policy(), { mode: 'SIMULATED_HTTPS',
      receive: () => new Promise<string>(r => { resolve = r; }) });
    const first = session.receive();
    await expect(session.receive()).rejects.toThrow('SYNC_RECEIVER_BUSY');
    resolve(raw); await first;
    expect(await session.load()).toEqual(parseSavedScoutResearch(raw));
  });
});
