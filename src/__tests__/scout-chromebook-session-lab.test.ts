import { expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  mkdtempSync,
  rmSync
} from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createScoutSyncSession,
  createScoutSyncStore
} from '../../apps/scout-mobile/src/domain/scoutSyncSession.js';

import {
  createChromebookTransportLab
} from '../../apps/scout-mobile/src/transport/scoutChromebookTransportLab.js';

import {
  syncFixtureMetadata,
  syncFixtureResearch,
  SYNC_FIXTURE_PRIVATE
} from './fixtures/scout-sync-engine-fixture.js';

import {
  reviewResearchExport,
  exportReviewedResearch
} from '../agent/research-public-export.js';

it('Chromebook transport integrates with Android SQLite and offline reload', async () => {
  const folder = mkdtempSync(
    join(tmpdir(), 'scout-android-session-')
  );

  const file = join(folder, 'reception.db');
  let db: Database.Database | undefined;

  try {
    const metadata = syncFixtureMetadata();
    const raw = JSON.stringify(syncFixtureResearch());

    const context = {
      knownSecrets: [SYNC_FIXTURE_PRIVATE]
    };

    const review = reviewResearchExport(
      raw, metadata, context
    );

    const payload = exportReviewedResearch(
      raw,
      metadata,
      {
        approved_payload_sha256: review.payload_sha256,
        reviewed_source_urls: review.source_urls
      },
      context
    );

    const url =
      'https://scout.example.test/v2/research-result';

    let requests = 0;

    const transport = createChromebookTransportLab(
      url,
      async () => {
        requests++;

        const body = new TextEncoder().encode(payload);

        return {
          status: 200,
          url,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'content-length': String(body.byteLength)
          },
          body
        };
      }
    );

    const open = async () => {
      const connection = db!;

      return {
        async execAsync(sql: string) {
          connection.exec(sql);
        },

        async runAsync(sql: string, value: string) {
          return connection.prepare(sql).run(value);
        },

        async getFirstAsync<T>(sql: string) {
          return (
            connection.prepare(sql).get() ?? null
          ) as T | null;
        }
      };
    };

    db = new Database(file);

    const policy = {
      engineId: metadata.engine_id,
      nowMs: () => Date.parse(metadata.generated_at)
    };

    const session = createScoutSyncSession(
      createScoutSyncStore(open),
      policy,
      transport
    );

    const received = await session.receive();

    expect(requests).toBe(1);
    expect(received.protocol_version).toBe(2);
    expect(received.data_origin).toBe('FICTIONAL_TEST');
    expect(received.execution_authorized).toBe(false);
    expect(received.preview.cards[0].cost_cents).toBe(850);

    expect(JSON.stringify(received))
      .not.toContain(SYNC_FIXTURE_PRIVATE);

    db.close();
    db = new Database(file);

    const offline = createScoutSyncSession(
      createScoutSyncStore(open),
      {
        ...policy,
        nowMs: () =>
          Date.parse(metadata.generated_at) + 864000000
      }
    );

    const saved = await offline.load();

    expect(saved).toEqual(received);
    expect(requests).toBe(1);

    console.log('RECEPTION ANDROID : PASS');
    console.log('STOCKAGE SQLITE : PASS');
    console.log('REOUVERTURE HORS LIGNE : PASS');
    console.log('AUCUN RESEAU REEL');
  } finally {
    if (db?.open) db.close();

    rmSync(folder, {
      recursive: true,
      force: true
    });
  }
});
