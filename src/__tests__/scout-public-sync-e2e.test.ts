
import {
  createLabDeviceRegistry
} from '../agent/research-device-registry-lab.js';

import {
  createRegisteredReadOnlyHttpsLabHandler
} from '../agent/research-readonly-registered-handler-lab.js';

import { createReadOnlyHttpsLabHandler } from '../agent/research-readonly-https-handler-lab.js';

import {
  generateLabDeviceToken,
  hashLabDeviceToken
} from '../agent/research-readonly-auth-lab.js';

import {
  createAuthenticatedFictionalLabResponder
} from '../agent/research-readonly-session-lab.js';

import { createFictionalReadOnlyResponder } from '../agent/research-readonly-lab.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportReviewedResearch, reviewResearchExport } from '../agent/research-public-export.js';
import { createPreparedHttpsTransport, SIMULATED_SYNC_URL, type ReadOnlySyncRequest }
  from '../agent/research-sync-https-preparation.js';
import { createPublicResearchReceiver, createPublicResearchStore }
  from '../../apps/scout-mobile/src/domain/publicResearchSync';
import type { ReceptionDatabase } from '../../apps/scout-mobile/src/storage/scoutReceptionStore';
import { syncFixtureMetadata, syncFixtureResearch, SYNC_FIXTURE_PRIVATE, SYNC_FIXTURE_NOW }
  from './fixtures/scout-sync-engine-fixture.js';

const databases: Database.Database[] = [], folders: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); syncBuiltinESMExports();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true });
});
function open(path = ':memory:') {
  const db = new Database(path); databases.push(db);
  const port: ReceptionDatabase = {
    async execAsync(sql) { db.exec(sql); }, async runAsync(sql, payload) { return db.prepare(sql).run(payload); },
    async getFirstAsync<T>(sql: string) { return (db.prepare(sql).get() ?? null) as T | null; }
  };
  return { db, store: createPublicResearchStore(async () => port) };
}
function released(metadata = syncFixtureMetadata()) {
  const raw = JSON.stringify(syncFixtureResearch());
  const review = reviewResearchExport(raw, metadata, { knownSecrets: [SYNC_FIXTURE_PRIVATE] });
  // Automated approval here is for this fixture only, never a release policy for real data.
  return exportReviewedResearch(raw, metadata, { approved_payload_sha256: review.payload_sha256,
    reviewed_source_urls: review.source_urls }, { knownSecrets: [SYNC_FIXTURE_PRIVATE] });
}
function engine(payload: () => string, options: { revoked?: boolean; expired?: boolean; scope?: string } = {}) {
  // No HTTP server: request/authorization simulation invokes a pure function.
  return vi.fn(async (request: ReadOnlySyncRequest) => {
    const status = request.method !== 'GET' || request.url !== SIMULATED_SYNC_URL ? 405 :
      request.headers.Authorization !== 'Bearer test-token-device1' || options.revoked || options.expired ? 401 :
      (options.scope ?? 'research:read') !== 'research:read' ? 403 : 200;
    return { status, url: SIMULATED_SYNC_URL,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: (async function* () { if (status === 200) yield new TextEncoder().encode(payload()); })() };
  });
}
function transport(port: ReturnType<typeof engine>, token = 'test-token-device1') {
  return createPreparedHttpsTransport({ mode: 'SIMULATED_HTTPS', port, getTestToken: async () => token });
}
const policy = () => ({ engineId: 'engine-fixture', nowMs: () => SYNC_FIXTURE_NOW });

describe('Scout sync: simulated engine → release → read-only reception → actual SQLite', () => {
  it('performs the whole path without network, DNS-facing sockets, ports or commands', async () => {
    const forbidden = () => { throw new Error('EXTERNAL_EFFECT_FORBIDDEN'); };
    const fetch = vi.fn(forbidden); vi.stubGlobal('fetch', fetch);
    const spies = [fetch, vi.spyOn(http, 'request').mockImplementation(forbidden),
      vi.spyOn(http, 'get').mockImplementation(forbidden), vi.spyOn(https, 'request').mockImplementation(forbidden),
      vi.spyOn(https, 'get').mockImplementation(forbidden),
      vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(forbidden),
      vi.spyOn(net, 'createServer').mockImplementation(forbidden),
      vi.spyOn(childProcess, 'spawn').mockImplementation(forbidden),
      vi.spyOn(childProcess, 'exec').mockImplementation(forbidden)];
    syncBuiltinESMExports();
    const payload = released(), port = engine(() => payload);
    const { db, store } = open();
    db.exec("CREATE TABLE opportunities(title TEXT); INSERT INTO opportunities VALUES('Manual fixture');");
    const receiver = createPublicResearchReceiver(transport(port), store, policy());
    const value = await receiver.receive();
    expect(value.data_origin).toBe('FICTIONAL_TEST');
    expect(value.preview.cards[0].cost_cents).toBe(850);
    expect(value.execution_authorized).toBe(false);
    expect(await receiver.load()).toEqual(value);
    expect(port).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT * FROM opportunities').all()).toEqual([{ title: 'Manual fixture' }]);
    expect(JSON.stringify(value)).not.toContain(SYNC_FIXTURE_PRIVATE);
    expect(JSON.stringify(value)).not.toContain('test-token-device1');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('closes/reopens file-backed SQLite and loads offline without using a transport or receipt expiry', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'scout-public-sync-')); folders.push(folder);
    const path = join(folder, 'scout-public-reception-experiment.db');
    const first = open(path);
    const value = await createPublicResearchReceiver(transport(engine(() => released())), first.store, policy()).receive();
    first.db.close();
    const second = open(path);
    const port = engine(() => { throw new Error('MUST_NOT_READ_NETWORK'); });
    const offline = createPublicResearchReceiver(transport(port), second.store,
      { ...policy(), nowMs: () => SYNC_FIXTURE_NOW + 864000000 });
    expect(await offline.load()).toEqual(value);
    expect(port).not.toHaveBeenCalled();
  });

  it.each([{ revoked: true }, { expired: true }, { scope: 'project:write' }])('refuses unauthorized device %s before reading its result', async options => {
    const payload = vi.fn(released), port = engine(payload, options);
    const { store } = open();
    await expect(createPublicResearchReceiver(transport(port), store, policy()).receive())
      .rejects.toThrow('SYNC_RECEIVE_REFUSED');
    expect(payload).not.toHaveBeenCalled(); expect(await store.load()).toBeNull();
  });

  it('refuses an unknown device and never accepts a query parameter as authentication', async () => {
    const port = engine(released);
    const { store } = open();
    await expect(createPublicResearchReceiver(transport(port, 'test-token-unknown'), store, policy()).receive())
      .rejects.toThrow('SYNC_RECEIVE_REFUSED');
    expect(await store.load()).toBeNull();
    expect((await port({ method: 'GET', url: `${SIMULATED_SYNC_URL}?token=test-token-device1` as any,
      headers: { Accept: 'application/json', Authorization: '' }, cache: 'no-store', credentials: 'omit', redirect: 'error' })).status)
      .toBe(405);
  });

  it.each(['POST', 'PUT', 'DELETE'])('simulated server refuses %s without changing any engine state', async method => {
    const payload = vi.fn(released), port = engine(payload);
    const result = await port({ method: method as any, url: SIMULATED_SYNC_URL,
      headers: { Accept: 'application/json', Authorization: 'Bearer test-token-device1' },
      cache: 'no-store', credentials: 'omit', redirect: 'error' });
    expect(result.status).toBe(405); expect(payload).not.toHaveBeenCalled();
  });

  it('keeps the previous valid result when a command or permission is injected', async () => {
    const { store } = open(); let raw = released(); const port = engine(() => raw);
    const receiver = createPublicResearchReceiver(transport(port), store, policy());
    const previous = await receiver.receive();
    raw = JSON.stringify({ ...JSON.parse(raw), command: 'pay' });
    await expect(receiver.receive()).rejects.toThrow('INVALID_PUBLIC_SYNC_FIELDS');
    expect(await receiver.load()).toEqual(previous);
    raw = JSON.stringify({ ...JSON.parse(released()), execution_authorized: true });
    await expect(receiver.receive()).rejects.toThrow('INVALID_PUBLIC_SYNC_AUTHORITY');
    expect(await receiver.load()).toEqual(previous);
  });

  it('rejects rollback, conflicting revision and wrong engine; repeats are idempotent', async () => {
    const { store, db } = open(); let raw = released({ ...syncFixtureMetadata(), revision: 2 });
    const receiver = createPublicResearchReceiver(transport(engine(() => raw)), store, policy());
    const previous = await receiver.receive();
    expect(await receiver.receive()).toEqual(previous);
    expect(db.prepare('SELECT count(*) AS count FROM latest_research').get()).toEqual({ count: 1 });
    raw = released();
    await expect(receiver.receive()).rejects.toThrow('SYNC_ROLLBACK_REFUSED');
    raw = released({ ...syncFixtureMetadata(), revision: 2, research_id: 'research-conflict' });
    await expect(receiver.receive()).rejects.toThrow('SYNC_REVISION_CONFLICT');
    raw = released({ ...syncFixtureMetadata(), revision: 3, engine_id: 'engine-other' });
    await expect(receiver.receive()).rejects.toThrow('STALE_OR_WRONG_ENGINE_RESULT');
    expect(await receiver.load()).toEqual(previous);
  });

  it.each([-300001, 30001])('rejects stale or future result offset %s without replacing SQLite', async offset => {
    const { store } = open();
    const payload = released({ ...syncFixtureMetadata(), generated_at: new Date(SYNC_FIXTURE_NOW + offset).toISOString() });
    await expect(createPublicResearchReceiver(transport(engine(() => payload)), store, policy()).receive())
      .rejects.toThrow('STALE_OR_WRONG_ENGINE_RESULT');
    expect(await store.load()).toBeNull();
  });

  it('refuses real transport before touching it and rejects concurrent reception', async () => {
    const { store } = open(); const receive = vi.fn();
    await expect(createPublicResearchReceiver({ mode: 'HTTPS_DISABLED', receive }, store, policy()).receive())
      .rejects.toThrow('REAL_SYNC_DISABLED');
    expect(receive).not.toHaveBeenCalled();
    let resolve!: (raw: string) => void;
    const receiver = createPublicResearchReceiver({ mode: 'SIMULATED_HTTPS', receive: () => new Promise(r => { resolve = r; }) }, store, policy());
    const pending = receiver.receive();
    await expect(receiver.receive()).rejects.toThrow('SYNC_RECEIVER_BUSY');
    resolve(released()); await pending;
  });

  it('revalidates corrupt rows and does not display a different paired engine offline', async () => {
    const { store, db } = open(); await store.save(released());
    const receiver = createPublicResearchReceiver(transport(engine(released)), store, policy());
    db.prepare('UPDATE latest_research SET payload=?').run('{');
    await expect(receiver.load()).rejects.toThrow();
    await store.save(released({ ...syncFixtureMetadata(), engine_id: 'engine-other' }));
    await expect(receiver.load()).rejects.toThrow('WRONG_STORED_ENGINE');
  });
});


// SCOUT_READONLY_LAB_TESTS
it('lab: accepts an authorized fictional GET', () => {
  const respond = createFictionalReadOnlyResponder(
    released(), 'test-token-scout'
  );

  const reply = respond({
    method: 'GET',
    path: '/v2/research-result',
    authorization: 'Bearer test-token-scout'
  });

  expect(reply.status).toBe(200);
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.headers['content-type']).toBe('application/json');

  const data = JSON.parse(reply.body);

  expect(data.data_origin).toBe('FICTIONAL_TEST');
  expect(data.execution_authorized).toBe(false);
  expect(data.preview.cards[0].cost_cents).toBe(850);
  expect(reply.body).not.toContain('test-token-scout');
});

it('lab: refuses an invalid token', () => {
  const respond = createFictionalReadOnlyResponder(
    released(), 'test-token-scout'
  );

  const reply = respond({
    method: 'GET',
    path: '/v2/research-result',
    authorization: 'Bearer test-token-invalid'
  });

  expect(reply.status).toBe(401);
  expect(reply.body).toBe('');
});

it('lab: refuses writes and unknown paths', () => {
  const respond = createFictionalReadOnlyResponder(
    released(), 'test-token-scout'
  );

  const request = {
    path: '/v2/research-result',
    authorization: 'Bearer test-token-scout'
  };

  expect(respond({ ...request, method: 'POST' }).status).toBe(405);
  expect(respond({ ...request, method: 'DELETE' }).status).toBe(405);

  expect(respond({
    ...request,
    method: 'GET',
    path: '/private'
  }).status).toBe(404);
});

it('lab: refuses non-fictional results', () => {
  const data = JSON.parse(released());
  data.data_origin = 'PUBLIC_RESEARCH';

  expect(() => createFictionalReadOnlyResponder(
    JSON.stringify(data),
    'test-token-scout'
  )).toThrow();
});

it('lab: refuses execution authorization', () => {
  const data = JSON.parse(released());
  data.execution_authorized = true;

  expect(() => createFictionalReadOnlyResponder(
    JSON.stringify(data),
    'test-token-scout'
  )).toThrow();
});


// SCOUT_AUTH_READONLY_LAB_TESTS

it('session lab: authenticated device receives fictional result', () => {
  const token = generateLabDeviceToken();

  const respond = createAuthenticatedFictionalLabResponder(
    released(),
    hashLabDeviceToken(token),
    () => false
  );

  const reply = respond({
    method: 'GET',
    path: '/v2/research-result',
    authorization: `Bearer ${token}`
  });

  expect(reply.status).toBe(200);
  expect(reply.headers['cache-control']).toBe('no-store');

  const data = JSON.parse(reply.body);

  expect(data.data_origin).toBe('FICTIONAL_TEST');
  expect(data.execution_authorized).toBe(false);
  expect(data.preview.cards[0].cost_cents).toBe(850);
  expect(reply.body).not.toContain(token);
});

it('session lab: missing or wrong credentials are refused', () => {
  const token = generateLabDeviceToken();

  const respond = createAuthenticatedFictionalLabResponder(
    released(),
    hashLabDeviceToken(token),
    () => false
  );

  const request = {
    method: 'GET',
    path: '/v2/research-result'
  };

  expect(respond(request).status).toBe(401);

  const wrong = respond({
    ...request,
    authorization: `Bearer ${generateLabDeviceToken()}`
  });

  expect(wrong.status).toBe(401);
  expect(wrong.body).toBe('');
});

it('session lab: revocation immediately blocks access', () => {
  const token = generateLabDeviceToken();
  let revoked = false;

  const respond = createAuthenticatedFictionalLabResponder(
    released(),
    hashLabDeviceToken(token),
    () => revoked
  );

  const request = {
    method: 'GET',
    path: '/v2/research-result',
    authorization: `Bearer ${token}`
  };

  expect(respond(request).status).toBe(200);

  revoked = true;

  const refused = respond(request);

  expect(refused.status).toBe(401);
  expect(refused.body).toBe('');
});

it('session lab: revocation errors deny access', () => {
  const token = generateLabDeviceToken();

  const respond = createAuthenticatedFictionalLabResponder(
    released(),
    hashLabDeviceToken(token),
    () => {
      throw new Error('REVOCATION_CHECK_FAILED');
    }
  );

  const reply = respond({
    method: 'GET',
    path: '/v2/research-result',
    authorization: `Bearer ${token}`
  });

  expect(reply.status).toBe(401);
  expect(reply.body).toBe('');
});

it('session lab: commercial write methods are refused', () => {
  const token = generateLabDeviceToken();

  const respond = createAuthenticatedFictionalLabResponder(
    released(),
    hashLabDeviceToken(token),
    () => false
  );

  const request = {
    path: '/v2/research-result',
    authorization: `Bearer ${token}`
  };

  expect(respond({ ...request, method: 'POST' }).status).toBe(405);
  expect(respond({ ...request, method: 'DELETE' }).status).toBe(405);
  expect(respond({ ...request, method: 'PATCH' }).status).toBe(405);
});

it('session lab: unknown routes are refused', () => {
  const token = generateLabDeviceToken();

  const respond = createAuthenticatedFictionalLabResponder(
    released(),
    hashLabDeviceToken(token),
    () => false
  );

  expect(respond({
    method: 'GET',
    path: '/private',
    authorization: `Bearer ${token}`
  }).status).toBe(404);
});

it('session lab: non-fictional or executable data refused', () => {
  const token = generateLabDeviceToken();
  const original = JSON.parse(released());

  const publicData = {
    ...original,
    data_origin: 'PUBLIC_RESEARCH'
  };

  expect(() => createAuthenticatedFictionalLabResponder(
    JSON.stringify(publicData),
    hashLabDeviceToken(token),
    () => false
  )).toThrow();

  const executable = {
    ...original,
    execution_authorized: true
  };

  expect(() => createAuthenticatedFictionalLabResponder(
    JSON.stringify(executable),
    hashLabDeviceToken(token),
    () => false
  )).toThrow();
});


// SCOUT_HTTPS_HANDLER_LAB_TESTS

function invokeHttpsLab(
  handler: ReturnType<typeof createReadOnlyHttpsLabHandler>,
  options: {
    encrypted?: boolean;
    protocol?: string;
    method?: string;
    path?: string;
    authorization?: string;
  } = {}
) {
  let status = -1;
  let headers: Record<string, string> = {};
  let body = '';
  let finished = false;

  const req = {
    method: options.method ?? 'GET',
    url: options.path ?? '/v2/research-result',
    headers: {
      authorization: options.authorization
    },
    socket: {
      encrypted: options.encrypted ?? true,
      getProtocol: () => options.protocol ?? 'TLSv1.3'
    }
  } as unknown as Parameters<typeof handler>[0];

  const res = {
    writeHead(
      code: number,
      values: Record<string, string>
    ) {
      status = code;
      headers = values;
      return this;
    },
    end(value = '') {
      body = value;
      finished = true;
      return this;
    }
  } as unknown as Parameters<typeof handler>[1];

  handler(req, res);

  expect(finished).toBe(true);

  return { status, headers, body };
}

function makeHttpsLab(revoked: () => boolean = () => false) {
  const token = generateLabDeviceToken();

  const handler = createReadOnlyHttpsLabHandler(
    released(),
    hashLabDeviceToken(token),
    revoked
  );

  return { token, handler };
}

it('https lab: authorized TLS 1.3 GET succeeds', () => {
  const { token, handler } = makeHttpsLab();

  const reply = invokeHttpsLab(handler, {
    authorization: `Bearer ${token}`
  });

  expect(reply.status).toBe(200);
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.headers['x-content-type-options']).toBe('nosniff');

  const data = JSON.parse(reply.body);

  expect(data.data_origin).toBe('FICTIONAL_TEST');
  expect(data.execution_authorized).toBe(false);
  expect(data.preview.cards[0].cost_cents).toBe(850);
  expect(reply.body).not.toContain(token);
});

it('https lab: rejects unencrypted connections', () => {
  const { token, handler } = makeHttpsLab();

  const reply = invokeHttpsLab(handler, {
    encrypted: false,
    authorization: `Bearer ${token}`
  });

  expect(reply.status).toBe(403);
  expect(reply.body).toBe('');
});

it('https lab: rejects TLS 1.2', () => {
  const { token, handler } = makeHttpsLab();

  const reply = invokeHttpsLab(handler, {
    protocol: 'TLSv1.2',
    authorization: `Bearer ${token}`
  });

  expect(reply.status).toBe(403);
});

it('https lab: rejects missing credentials', () => {
  const { handler } = makeHttpsLab();

  const reply = invokeHttpsLab(handler);

  expect(reply.status).toBe(401);
  expect(reply.body).toBe('');
});

it('https lab: rejects invalid credentials', () => {
  const { handler } = makeHttpsLab();

  const reply = invokeHttpsLab(handler, {
    authorization: `Bearer ${generateLabDeviceToken()}`
  });

  expect(reply.status).toBe(401);
});

it('https lab: revocation blocks access', () => {
  let revoked = false;
  const { token, handler } = makeHttpsLab(() => revoked);

  const options = {
    authorization: `Bearer ${token}`
  };

  expect(invokeHttpsLab(handler, options).status).toBe(200);

  revoked = true;

  const reply = invokeHttpsLab(handler, options);

  expect(reply.status).toBe(401);
  expect(reply.body).toBe('');
});

it('https lab: revocation check failure denies access', () => {
  const { token, handler } = makeHttpsLab(() => {
    throw new Error('REVOCATION_UNAVAILABLE');
  });

  const reply = invokeHttpsLab(handler, {
    authorization: `Bearer ${token}`
  });

  expect(reply.status).toBe(401);
});

it('https lab: refuses commercial write methods', () => {
  const { token, handler } = makeHttpsLab();

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const reply = invokeHttpsLab(handler, {
      method,
      authorization: `Bearer ${token}`
    });

    expect(reply.status).toBe(405);
    expect(reply.body).toBe('');
  }
});

it('https lab: refuses unknown routes', () => {
  const { token, handler } = makeHttpsLab();

  const reply = invokeHttpsLab(handler, {
    path: '/private',
    authorization: `Bearer ${token}`
  });

  expect(reply.status).toBe(404);
  expect(reply.body).toBe('');
});



// SCOUT_REAL_TLS_LOOPBACK_TEST
it('loopback lab: real TLS 1.3 and device revocation', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const child = await import('node:child_process');
  const https = await import('node:https');

  const { startLoopbackReadonlyHttpsLab } =
    await import('../agent/research-readonly-https-server-lab.js');

  const folder = fs.mkdtempSync(
    path.join(os.tmpdir(), 'scout-tls-lab-')
  );

  const key = path.join(folder, 'key.pem');
  const cert = path.join(folder, 'cert.pem');

  let server: Awaited<
    ReturnType<typeof startLoopbackReadonlyHttpsLab>
  > | undefined;

  try {
    child.execFileSync('openssl', [
      'req', '-x509',
      '-newkey', 'rsa:2048',
      '-sha256', '-nodes',
      '-keyout', key,
      '-out', cert,
      '-days', '1',
      '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1'
    ], {
      stdio: 'ignore',
      timeout: 15000
    });

    const certificate = fs.readFileSync(cert);
    const token = generateLabDeviceToken();
    let revoked = false;

    server = await startLoopbackReadonlyHttpsLab({
      enabled: true,
      payload: released(),
      expectedDeviceTokenHash: hashLabDeviceToken(token),
      isRevoked: () => revoked,
      tls: {
        key: fs.readFileSync(key),
        cert: certificate
      }
    });

    expect(server.host).toBe('127.0.0.1');

    const request = (
      authorization: string,
      method = 'GET'
    ) => new Promise<{
      status: number;
      body: string;
      protocol: string | null;
      authorized: boolean;
    }>((resolve, reject) => {

      const req = https.request({
        hostname: '127.0.0.1',
        port: server!.port,
        path: '/v2/research-result',
        method,
        ca: certificate,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        agent: false,
        headers: { authorization }
      }, res => {
        const socket =
          res.socket as import('node:tls').TLSSocket;

        const protocol = socket.getProtocol();
        const authorized = socket.authorized;
        let body = '';

        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });

        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body,
          protocol,
          authorized
        }));
      });

      req.on('error', reject);
      req.setTimeout(3000, () => {
        req.destroy(new Error('HTTPS_TEST_TIMEOUT'));
      });

      req.end();
    });

    const valid = await request(`Bearer ${token}`);

    expect(valid.status).toBe(200);
    expect(valid.protocol).toBe('TLSv1.3');
    expect(valid.authorized).toBe(true);

    const data = JSON.parse(valid.body);

    expect(data.data_origin).toBe('FICTIONAL_TEST');
    expect(data.execution_authorized).toBe(false);
    expect(data.preview.cards[0].cost_cents).toBe(850);

    const invalid = await request(
      `Bearer ${generateLabDeviceToken()}`
    );

    expect(invalid.status).toBe(401);
    expect(invalid.body).toBe('');

    const write = await request(`Bearer ${token}`, 'POST');

    expect(write.status).toBe(405);

    revoked = true;

    const refused = await request(`Bearer ${token}`);

    expect(refused.status).toBe(401);
    expect(refused.body).toBe('');

  } finally {
    try {
      if (server) await server.close();
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }
});


// SCOUT_REGISTERED_HANDLER_LAB_TESTS

it('registered handler lab: authorized device receives data', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const folder = fs.mkdtempSync(
    path.join(os.tmpdir(), 'scout-registered-lab-')
  );

  try {
    const file = path.join(folder, 'device.json');
    const token = generateLabDeviceToken();
    const hash = hashLabDeviceToken(token);

    createLabDeviceRegistry(file).enroll(hash);

    const handler = createRegisteredReadOnlyHttpsLabHandler(
      released(),
      file
    );

    const reply = invokeHttpsLab(handler, {
      authorization: `Bearer ${token}`
    });

    expect(reply.status).toBe(200);

    const data = JSON.parse(reply.body);

    expect(data.data_origin).toBe('FICTIONAL_TEST');
    expect(data.execution_authorized).toBe(false);
    expect(data.preview.cards[0].cost_cents).toBe(850);

    expect(invokeHttpsLab(handler, {
      authorization: `Bearer ${generateLabDeviceToken()}`
    }).status).toBe(401);

  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

it('registered handler lab: revocation persists after recreation', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const folder = fs.mkdtempSync(
    path.join(os.tmpdir(), 'scout-revocation-lab-')
  );

  try {
    const file = path.join(folder, 'device.json');
    const token = generateLabDeviceToken();
    const hash = hashLabDeviceToken(token);
    const registry = createLabDeviceRegistry(file);

    registry.enroll(hash);

    let handler = createRegisteredReadOnlyHttpsLabHandler(
      released(),
      file
    );

    const request = {
      authorization: `Bearer ${token}`
    };

    expect(invokeHttpsLab(handler, request).status).toBe(200);

    registry.revoke();

    expect(invokeHttpsLab(handler, request).status).toBe(401);

    handler = createRegisteredReadOnlyHttpsLabHandler(
      released(),
      file
    );

    expect(invokeHttpsLab(handler, request).status).toBe(401);

  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

it('registered handler lab: missing or corrupted registry refuses access', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const folder = fs.mkdtempSync(
    path.join(os.tmpdir(), 'scout-corrupt-lab-')
  );

  try {
    const file = path.join(folder, 'device.json');
    const token = generateLabDeviceToken();
    const hash = hashLabDeviceToken(token);

    expect(() => createRegisteredReadOnlyHttpsLabHandler(
      released(),
      file
    )).toThrow();

    createLabDeviceRegistry(file).enroll(hash);

    const handler = createRegisteredReadOnlyHttpsLabHandler(
      released(),
      file
    );

    fs.writeFileSync(file, '{INVALID JSON');

    expect(invokeHttpsLab(handler, {
      authorization: `Bearer ${token}`
    }).status).toBe(401);

    expect(() => createRegisteredReadOnlyHttpsLabHandler(
      released(),
      file
    )).toThrow();

  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
