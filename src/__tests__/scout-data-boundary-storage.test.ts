import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoResearchMessage } from '../agent/research-reception.js';
import { exportReviewedResearch, reviewResearchExport } from '../agent/research-public-export.js';
import { reviewResearchImport } from '../../apps/scout-mobile/src/domain/researchImportReview.js';
import { parseResearchResultFile } from '../../apps/scout-mobile/src/domain/researchResultFile.js';
import { createScoutSyncStore, createScoutSyncSession } from '../../apps/scout-mobile/src/domain/scoutSyncSession.js';
import type { ReceptionDatabase } from '../../apps/scout-mobile/src/storage/scoutReceptionStore.js';
import { createScoutDemoV2Transport, DEMO_ENGINE_ID } from '../../apps/scout-mobile/src/transport/scoutDemoV2Transport.js';
import { syncFixtureMetadata, syncFixtureResearch } from './fixtures/scout-sync-engine-fixture.js';

const databases: Database.Database[] = [], folders: string[] = [];
const NOW = Date.parse('2026-10-29T12:00:00.000Z');
function open(path = ':memory:') {
  const db = new Database(path); databases.push(db);
  const port: ReceptionDatabase = { async execAsync(sql) { db.exec(sql); },
    async runAsync(sql, payload) { return db.prepare(sql).run(payload); },
    async getFirstAsync<T>(sql: string) { return (db.prepare(sql).get() ?? null) as T | null; } };
  const store = createScoutSyncStore(async () => port);
  const policy = { engineId: DEMO_ENGINE_ID, nowMs: () => NOW };
  return { db, store, policy, session: createScoutSyncSession(store, policy, createScoutDemoV2Transport(store, () => NOW)) };
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const path of folders.splice(0)) rmSync(path, { recursive: true });
});

describe('Boundary refusals cannot overwrite the existing V1/V2 SQLite singleton', () => {
  it.each([1, 2])('preserves exact V%s and manual data across refused import/export, close and offline reopen', async version => {
    const folder = mkdtempSync(join(tmpdir(), 'scout-boundary-')); folders.push(folder);
    const path = join(folder, 'scout-reception.db'), current = open(path);
    if (version === 1) await current.store.save(JSON.stringify(createDemoResearchMessage()));
    else await current.session.receive();
    current.db.exec("CREATE TABLE opportunities(title TEXT); INSERT INTO opportunities VALUES('Manuel conservé');");
    const oldRow = current.db.prepare('SELECT payload FROM latest_research WHERE id=1').get();
    const old = await current.store.load();
    const oldPreview = parseResearchResultFile(JSON.stringify(syncFixtureResearch()));
    const baseline = reviewResearchExport(JSON.stringify(syncFixtureResearch()), syncFixtureMetadata());
    for (const field of ['economic_guard', 'experimental_model_provider', 'warnings']) {
      const raw = JSON.stringify({ ...syncFixtureResearch(), status: 'INSUFFICIENT_EVIDENCE', opportunities: [], [field]: null });
      expect(reviewResearchImport(oldPreview, raw, 'RESEARCH_FILE').preview).toBe(oldPreview);
      const save = vi.fn((payload: string) => current.store.save(payload));
      await expect((async () => {
        const payload = exportReviewedResearch(raw, syncFixtureMetadata(), {
          approved_payload_sha256: baseline.payload_sha256, reviewed_source_urls: baseline.source_urls });
        await save(payload);
      })()).rejects.toThrow();
      expect(save).not.toHaveBeenCalled();
      expect(current.db.prepare('SELECT payload FROM latest_research WHERE id=1').get()).toEqual(oldRow);
    }
    const malformed = { ...old, economic_guard: { warnings: ['Unknown costs'] } };
    await expect(current.store.save(JSON.stringify(malformed))).rejects.toThrow();
    current.db.close();
    const restarted = open(path);
    const receive = vi.fn(() => { throw new Error('OFFLINE_ONLY'); });
    expect(await createScoutSyncSession(restarted.store, { ...restarted.policy, nowMs: () => NOW + 864000000 },
      { mode: 'HTTPS_DISABLED', receive }).load()).toEqual(old);
    expect(receive).not.toHaveBeenCalled();
    expect(restarted.db.prepare('SELECT payload FROM latest_research WHERE id=1').get()).toEqual(oldRow);
    expect(restarted.db.prepare('SELECT * FROM opportunities').all()).toEqual([{ title: 'Manuel conservé' }]);
    expect(restarted.db.prepare('SELECT count(*) AS n FROM latest_research').get()).toEqual({ n: 1 });
  });

  it('keeps demo reception local, with revision persistence and no fetch', async () => {
    const fetch = vi.fn(() => { throw new Error('NO_NETWORK'); }); vi.stubGlobal('fetch', fetch);
    const { session, store, policy } = open();
    const first = await session.receive(), second = await session.receive();
    expect(first.revision).toBe(1); expect(second.revision).toBe(2);
    expect(second.data_origin).toBe('FICTIONAL_TEST');
    expect(second.authentication).toBe('UNAUTHENTICATED');
    expect(second.preview.cards[0].execution_authorized).toBe(false);
    const disabled = createScoutSyncSession(store, policy);
    await expect(disabled.receive()).rejects.toThrow('REAL_SYNC_DISABLED');
    expect(await disabled.load()).toEqual(second);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects duplicate provenance before touching SQLite', async () => {
    const current = open(); const old = await current.session.receive();
    const row = current.db.prepare('SELECT payload FROM latest_research').get();
    const raw = JSON.stringify(old).replace('"data_origin":', '"data_origin":"PUBLIC_RESEARCH","data_origin":');
    await expect(current.store.save(raw)).rejects.toThrow('DUPLICATE_RESEARCH_JSON_KEY');
    expect(current.db.prepare('SELECT payload FROM latest_research').get()).toEqual(row);
  });
});
