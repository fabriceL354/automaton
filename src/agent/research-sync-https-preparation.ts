import { PUBLIC_SYNC_MAX_BYTES } from './research-public-sync.js';

export const SIMULATED_SYNC_URL = 'https://scout-sync.invalid/v2/research/latest';
export type ReadOnlySyncRequest = {
  method: 'GET'; url: typeof SIMULATED_SYNC_URL; redirect: 'error';
  credentials: 'omit'; cache: 'no-store';
  headers: { Accept: 'application/json'; Authorization: string };
};
export type SimulatedSyncResponse = {
  status: number; url: string; headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
};
export type SimulatedHttpsPort = (request: ReadOnlySyncRequest, signal: AbortSignal) => Promise<SimulatedSyncResponse>;
export interface PreparedReadOnlySyncTransport {
  readonly mode: 'HTTPS_DISABLED' | 'SIMULATED_HTTPS';
  receive(): Promise<string>;
}

function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(new Error('SYNC_TRANSPORT_ABORTED')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** No native HTTP implementation. Enabling real HTTPS is deliberately impossible. */
export function createPreparedHttpsTransport(options: {
  mode?: 'HTTPS_DISABLED' | 'SIMULATED_HTTPS';
  port?: SimulatedHttpsPort;
  getTestToken?: () => Promise<string>;
  timeoutMs?: number;
} = {}): PreparedReadOnlySyncTransport {
  if (Object.keys(options).some(key => !['mode', 'port', 'getTestToken', 'timeoutMs'].includes(key)) ||
      (options.mode !== undefined && options.mode !== 'HTTPS_DISABLED' && options.mode !== 'SIMULATED_HTTPS')) {
    throw new Error('REAL_HTTPS_NOT_IMPLEMENTED');
  }
  const mode = options.mode ?? 'HTTPS_DISABLED';
  const timeoutMs = options.timeoutMs ?? 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1000) throw new Error('INVALID_SYNC_TIMEOUT');
  let busy = false;
  return {
    mode,
    async receive() {
      if (mode !== 'SIMULATED_HTTPS') throw new Error('SCOUT_HTTPS_DISABLED');
      if (busy) throw new Error('SYNC_TRANSPORT_BUSY');
      if (!options.port || !options.getTestToken) throw new Error('SIMULATED_SYNC_NOT_CONFIGURED');
      busy = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let iterator: AsyncIterator<Uint8Array> | undefined;
      try {
        const token = await bounded(options.getTestToken(), controller.signal);
        // Synthetic credentials only. Real device credentials have no path here.
        if (!/^test-token-[a-z0-9]{1,32}(?![\s\S])/.test(token)) throw new Error('INVALID_TEST_TOKEN');
        const reply = await bounded(options.port({
          method: 'GET', url: SIMULATED_SYNC_URL, redirect: 'error', credentials: 'omit', cache: 'no-store',
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
        }, controller.signal), controller.signal);
        if (reply.status !== 200 || reply.url !== SIMULATED_SYNC_URL ||
            reply.headers['content-type']?.toLowerCase().split(';')[0].trim() !== 'application/json' ||
            reply.headers['cache-control'] !== 'no-store' ||
            (reply.headers['content-encoding'] && reply.headers['content-encoding'] !== 'identity')) {
          throw new Error('UNSAFE_SYNC_RESPONSE');
        }
        const length = reply.headers['content-length'];
        if (length !== undefined && (!/^[1-9][0-9]{0,4}(?![\s\S])/.test(length) ||
            Number(length) > PUBLIC_SYNC_MAX_BYTES)) throw new Error('UNSAFE_SYNC_LENGTH');
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let total = 0, chunks = 0, text = '';
        iterator = reply.body[Symbol.asyncIterator]();
        while (true) {
          const next = await bounded(iterator.next(), controller.signal);
          if (next.done) break;
          if (!(next.value instanceof Uint8Array) || ++chunks > 64) throw new Error('UNSAFE_SYNC_BODY');
          total += next.value.byteLength;
          if (total > PUBLIC_SYNC_MAX_BYTES) throw new Error('UNSAFE_SYNC_BODY');
          text += decoder.decode(next.value, { stream: true });
        }
        text += decoder.decode();
        if (!total || (length !== undefined && Number(length) !== total)) throw new Error('UNSAFE_SYNC_LENGTH');
        return text;
      } catch {
        // Never echo a bearer token, response body or provider diagnostics.
        throw new Error('SYNC_RECEIVE_REFUSED');
      } finally {
        controller.abort(); clearTimeout(timer); busy = false;
        if (iterator?.return) {
          try { void iterator.return().catch(() => {}); } catch { /* no data diagnostics */ }
        }
      }
    }
  };
}
