import {
  syncFixtureMetadata,
  syncFixtureResearch,
  SYNC_FIXTURE_PRIVATE
} from './fixtures/scout-sync-engine-fixture.js';

import {
  reviewResearchExport,
  exportReviewedResearch
} from '../agent/research-public-export.js';

import { describe, expect, it } from 'vitest';

import {
  createChromebookTransportLab
} from '../../apps/scout-mobile/src/transport/scoutChromebookTransportLab.js';

const URL =
  'https://scout.example.test/v2/research-result';

function reply(raw: string, url = URL) {
  const body = new TextEncoder().encode(raw);

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

function fictional(): string {
  const metadata = syncFixtureMetadata();
  const raw = JSON.stringify(syncFixtureResearch());

  const context = {
    knownSecrets: [SYNC_FIXTURE_PRIVATE]
  };

  const review = reviewResearchExport(
    raw,
    metadata,
    context
  );

  return exportReviewedResearch(
    raw,
    metadata,
    {
      approved_payload_sha256: review.payload_sha256,
      reviewed_source_urls: review.source_urls
    },
    context
  );
}

describe('Scout Chromebook injected transport lab', () => {

  it('accepts a fictional result without altering it', async () => {
    const raw = fictional();

    const transport = createChromebookTransportLab(
      URL,
      async () => reply(raw)
    );

    expect(transport.mode).toBe('SIMULATED_HTTPS');
    expect(await transport.receive()).toBe(raw);
  });

  it('rejects an unexpected response URL', async () => {
    const transport = createChromebookTransportLab(
      URL,
      async () => reply(
        fictional(),
        'https://other.example.test/data'
      )
    );

    await expect(transport.receive())
      .rejects.toThrow('CHROMEBOOK_REPLY_REFUSED');
  });

  it('rejects invalid JSON', async () => {
    const transport = createChromebookTransportLab(
      URL,
      async () => reply('{INVALID')
    );

    await expect(transport.receive())
      .rejects.toThrow('CHROMEBOOK_REPLY_REFUSED');
  });

  it('rejects non-fictional data', async () => {
    const data = JSON.parse(fictional());

    data.data_origin = 'PUBLIC_RESEARCH';

    const transport = createChromebookTransportLab(
      URL,
      async () => reply(JSON.stringify(data))
    );

    await expect(transport.receive())
      .rejects.toThrow('CHROMEBOOK_REPLY_REFUSED');
  });

  it('does not expose underlying transport errors', async () => {
    const transport = createChromebookTransportLab(
      URL,
      async () => {
        throw new Error('PRIVATE_TEST_SECRET');
      }
    );

    await expect(transport.receive())
      .rejects.toThrow('CHROMEBOOK_REPLY_REFUSED');
  });

});
