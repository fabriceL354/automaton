// Verification-only guard: block actual external egress in the parent, workers
// and inherited child processes. Tests can still install their own mocks.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
const allowed = h => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(h).toLowerCase());
function target(args) {
  const first = args[0];
  if (typeof first === 'string' || first instanceof URL) {
    const u = new URL(first); if (!allowed(u.hostname)) throw new Error('OFFLINE_TEST_GUARD: external HTTP blocked'); return;
  }
  const options = first ?? {};
  if (options.path && !options.host && !options.hostname) {
    if (String(options.path).startsWith('/')) return;
  }
  if (!allowed(options.hostname ?? options.host ?? 'localhost')) throw new Error('OFFLINE_TEST_GUARD: external connection blocked');
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!allowed(u.hostname)) throw new Error('OFFLINE_TEST_GUARD: external fetch blocked');
  return nativeFetch(input, init);
};
for (const module of [http, https]) for (const name of ['request', 'get']) {
  const original = module[name]; module[name] = function(...args) { target(args); return original.apply(this, args); };
}
for (const module of [net, tls]) for (const name of ['connect', 'createConnection']) {
  if (!module[name]) continue;
  const original = module[name]; module[name] = function(...args) {
    const first = args[0];
    if (typeof first === 'number') { if (!allowed(typeof args[1] === 'string' ? args[1] : 'localhost')) throw new Error('OFFLINE_TEST_GUARD: external TCP blocked'); }
    else if (typeof first === 'object' && !first.path && !allowed(first.host ?? 'localhost')) throw new Error('OFFLINE_TEST_GUARD: external TCP blocked');
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
