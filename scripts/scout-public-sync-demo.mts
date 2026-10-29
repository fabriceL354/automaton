import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { exportReviewedResearch, reviewResearchExport } from '../src/agent/research-public-export.js';
import { createPreparedHttpsTransport, SIMULATED_SYNC_URL } from '../src/agent/research-sync-https-preparation.js';
import * as androidDomain from '../apps/scout-mobile/src/domain/publicResearchSync.ts';
import { syncFixtureMetadata, syncFixtureResearch, SYNC_FIXTURE_NOW, SYNC_FIXTURE_PRIVATE }
  from '../src/__tests__/fixtures/scout-sync-engine-fixture.js';

const domain = androidDomain.createPublicResearchReceiver ? androidDomain : androidDomain.default;
const folder = mkdtempSync(join(tmpdir(), 'scout-sync-demo-'));
let db: Database.Database | undefined;
try {
  const raw = JSON.stringify(syncFixtureResearch()), metadata = syncFixtureMetadata();
  const review = reviewResearchExport(raw, metadata, { knownSecrets: [SYNC_FIXTURE_PRIVATE] });
  // This fixture is wholly authored for the demo. Real data requires a human release review.
  const payload = exportReviewedResearch(raw, metadata,
    { approved_payload_sha256: review.payload_sha256, reviewed_source_urls: review.source_urls },
    { knownSecrets: [SYNC_FIXTURE_PRIVATE] });
  let mockRequests = 0;
  const transport = createPreparedHttpsTransport({
    mode: 'SIMULATED_HTTPS', getTestToken: async () => 'test-token-device1',
    async port(request) {
      mockRequests++;
      if (request.method !== 'GET' || request.url !== SIMULATED_SYNC_URL ||
          request.headers.Authorization !== 'Bearer test-token-device1') throw new Error('DEMO_ACCESS_REFUSED');
      return { status: 200, url: SIMULATED_SYNC_URL,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: (async function* () { yield new TextEncoder().encode(payload); })() };
    }
  });
  const open = async () => {
    db = new Database(join(folder, 'scout-public-reception-experiment.db'));
    const connection = db;
    return {
      async execAsync(sql: string) { connection.exec(sql); },
      async runAsync(sql: string, value: string) { return connection.prepare(sql).run(value); },
      async getFirstAsync<T>(sql: string) { return (connection.prepare(sql).get() ?? null) as T | null; }
    };
  };
  const store = domain.createPublicResearchStore(open);
  const receiver = domain.createPublicResearchReceiver(transport, store,
    { engineId: metadata.engine_id, nowMs: () => SYNC_FIXTURE_NOW });
  const received = await receiver.receive();
  db!.close();
  const reopened = domain.createPublicResearchStore(open);
  const offline = domain.createPublicResearchReceiver(createPreparedHttpsTransport(), reopened,
    { engineId: metadata.engine_id, nowMs: () => SYNC_FIXTURE_NOW + 864000000 });
  const saved = await offline.load();
  if (JSON.stringify(received) !== JSON.stringify(saved)) throw new Error('OFFLINE_RELOAD_MISMATCH');
  console.log(JSON.stringify({
    mode: 'IN_MEMORY_SIMULATION_ONLY', data_origin: received.data_origin,
    real_https_implemented: false, server_started: false, port_opened: false,
    mock_get_requests: mockRequests, offline_reload_after_database_reopen: true,
    private_fixture_omitted: !payload.includes(SYNC_FIXTURE_PRIVATE),
    execution_authorized: received.execution_authorized, money_spent: false,
    research_id: received.research_id, cards: received.preview.cards.length,
    cost_cents: received.preview.cards[0]?.cost_cents
  }, null, 2));
} finally {
  if (db?.open) db.close();
  rmSync(folder, { recursive: true, force: true });
}
