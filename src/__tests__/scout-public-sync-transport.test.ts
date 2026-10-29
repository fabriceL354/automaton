import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPreparedHttpsTransport, SIMULATED_SYNC_URL, type SimulatedSyncResponse }
  from '../agent/research-sync-https-preparation.js';

function response(raw = '{}', overrides: Partial<SimulatedSyncResponse> = {}): SimulatedSyncResponse {
  return {
    status: 200, url: SIMULATED_SYNC_URL,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: (async function* () { yield new TextEncoder().encode(raw); })(), ...overrides
  };
}
const getTestToken = async () => 'test-token-device1';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Scout HTTPS preparation: disabled by default, in-memory port only', () => {
  it('does not call a token provider or port while disabled', async () => {
    const getTestToken = vi.fn(async () => 'test-token-device1');
    const port = vi.fn(async () => response());
    await expect(createPreparedHttpsTransport({ port, getTestToken }).receive()).rejects.toThrow('SCOUT_HTTPS_DISABLED');
    expect(getTestToken).not.toHaveBeenCalled(); expect(port).not.toHaveBeenCalled();
  });

  it.each([{ mode: 'HTTPS_REAL' }, { enabled: true }, { endpoint: 'https://example.org/' },
    { mode: 'SIMULATED_HTTPS', access_token: 'synthetic-real-looking' }])('rejects live/configuration escape %s', options => {
    expect(() => createPreparedHttpsTransport(options as any)).toThrow('REAL_HTTPS_NOT_IMPLEMENTED');
  });

  it('makes exactly one bodyless GET to a fixed reserved endpoint, with no cookies or redirects', async () => {
    const port = vi.fn(async () => response('{"ok":true}'));
    const client = createPreparedHttpsTransport({ mode: 'SIMULATED_HTTPS', port, getTestToken });
    expect(await client.receive()).toBe('{"ok":true}');
    expect(port).toHaveBeenCalledTimes(1);
    expect(port.mock.calls[0][0]).toEqual({
      method: 'GET', url: SIMULATED_SYNC_URL, redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { Accept: 'application/json', Authorization: 'Bearer test-token-device1' }
    });
    expect(SIMULATED_SYNC_URL).not.toContain('token');
  });

  it.each(['', 'Bearer stolen', 'test-token-device1\r\nInjected:yes', 'actual-credential'])('rejects non-test credential %s before port', async value => {
    const port = vi.fn(async () => response());
    await expect(createPreparedHttpsTransport({ mode: 'SIMULATED_HTTPS', port,
      getTestToken: async () => value }).receive()).rejects.toThrow('SYNC_RECEIVE_REFUSED');
    expect(port).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 401, 403, 404, 429, 500])('does not retry status %s or consume its body', async status => {
    const read = vi.fn();
    const port = vi.fn(async () => response('', { status, body: { [Symbol.asyncIterator]() {
      return { next: async () => { read(); return { done: true, value: undefined }; } };
    } } }));
    await expect(createPreparedHttpsTransport({ mode: 'SIMULATED_HTTPS', port, getTestToken }).receive())
      .rejects.toThrow('SYNC_RECEIVE_REFUSED');
    expect(port).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { url: 'https://elsewhere.invalid/v2/research/latest' },
    { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } },
    { headers: { 'content-type': 'application/json', 'cache-control': 'public' } },
    { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-encoding': 'gzip' } },
    { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': '12001' } },
    { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': '3' } }
  ])('rejects unsafe response metadata %s', async overrides => {
    const port = async () => response('{}', overrides);
    await expect(createPreparedHttpsTransport({ mode: 'SIMULATED_HTTPS', port, getTestToken }).receive())
      .rejects.toThrow('SYNC_RECEIVE_REFUSED');
  });

  it('decodes UTF-8 split across chunks and checks byte-accurate content length', async () => {
    const bytes = new TextEncoder().encode('é😀');
    const port = async () => response('', {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': String(bytes.length) },
      body: (async function* () { for (const byte of bytes) yield Uint8Array.of(byte); })()
    });
    expect(await createPreparedHttpsTransport({ mode: 'SIMULATED_HTTPS', port, getTestToken }).receive()).toBe('é😀');
  });

  it('refuses oversized, endless, empty or malformed UTF-8 bodies', async () => {
    const bodies = [
      (async function* () { yield new Uint8Array(12001); })(),
      (async function* () { for (let i = 0; i < 65; i++) yield Uint8Array.of(32); })(),
      (async function* () {})(),
      (async function* () { yield Uint8Array.of(0xc3); })()
    ];
    for (const body of bodies) {
      await expect(createPreparedHttpsTransport({ mode: 'SIMULATED_HTTPS', getTestToken,
        port: async () => response('', { body }) }).receive()).rejects.toThrow('SYNC_RECEIVE_REFUSED');
    }
  });

  it('bounds uncooperative token, response and body providers', async () => {
    vi.useFakeTimers();
    const variants = [
      { getTestToken: () => new Promise<string>(() => {}), port: async () => response() },
      { getTestToken, port: () => new Promise<SimulatedSyncResponse>(() => {}) },
      { getTestToken, port: async () => response('', { body: {
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) })
      } }) }
    ];
    for (const variant of variants) {
      const pending = createPreparedHttpsTransport({ mode: 'SIMULATED_HTTPS', timeoutMs: 10, ...variant }).receive();
      const refused = expect(pending).rejects.toThrow('SYNC_RECEIVE_REFUSED');
      await vi.advanceTimersByTimeAsync(11); await refused;
    }
  });

  it('does not reflect credentials or upstream errors in diagnostics', async () => {
    await expect(createPreparedHttpsTransport({ mode: 'SIMULATED_HTTPS', getTestToken,
      port: async () => { throw new Error('test-token-device1 private upstream body'); } }).receive())
      .rejects.toThrow(/^SYNC_RECEIVE_REFUSED$/);
  });
});
