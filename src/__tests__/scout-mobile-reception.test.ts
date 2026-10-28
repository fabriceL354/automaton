import Database from 'better-sqlite3';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoResearchMessage } from '../agent/research-reception.js';
import { receiveScoutResearch } from '../../apps/scout-mobile/src/domain/receiveScoutResearch';
import { createResearchReceptionStore } from '../../apps/scout-mobile/src/storage/scoutReceptionStore';
import { demoResearchTransport, disabledHttpsResearchTransport }
  from '../../apps/scout-mobile/src/transport/scoutReceptionTransport';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  syncBuiltinESMExports();
});

function forbidExternalEffects() {
  const forbidden = () => { throw new Error('UNEXPECTED_EXTERNAL_EFFECT'); };
  const fetch = vi.fn(forbidden);
  vi.stubGlobal('fetch', fetch);
  // Namespace properties of native ESM modules cannot be redefined. The default
  // exports are mutable, and sync also protects consumers of named ESM exports.
  const spies = [
    fetch,
    vi.spyOn(http, 'request').mockImplementation(forbidden),
    vi.spyOn(http, 'get').mockImplementation(forbidden),
    vi.spyOn(https, 'request').mockImplementation(forbidden),
    vi.spyOn(https, 'get').mockImplementation(forbidden),
    vi.spyOn(net, 'connect').mockImplementation(forbidden),
    vi.spyOn(net, 'createConnection').mockImplementation(forbidden),
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(forbidden),
    vi.spyOn(net, 'createServer').mockImplementation(forbidden),
    vi.spyOn(tls, 'connect').mockImplementation(forbidden),
    vi.spyOn(childProcess, 'spawn').mockImplementation(forbidden),
    vi.spyOn(childProcess, 'exec').mockImplementation(forbidden),
    vi.spyOn(childProcess, 'execFile').mockImplementation(forbidden),
    vi.spyOn(childProcess, 'spawnSync').mockImplementation(forbidden),
    vi.spyOn(childProcess, 'execSync').mockImplementation(forbidden),
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(forbidden)
  ];
  syncBuiltinESMExports();
  return { fetch, spies };
}

describe('Scout reception: simulated read-only transport', () => {
  it('receives, validates, stores and reloads a demo without network or child commands', async () => {
    const { spies } = forbidExternalEffects();
    const db = new Database(':memory:');
    try {
      const store = createResearchReceptionStore(async () => ({
        async execAsync(sql) { db.exec(sql); },
        async runAsync(sql, payload) { return db.prepare(sql).run(payload); },
        async getFirstAsync<T>(sql: string) { return (db.prepare(sql).get() ?? null) as T | null; }
      }));
      const receive = vi.fn(() => demoResearchTransport.receive());
      const received = await receiveScoutResearch({ mode: 'SIMULATED', receive }, store);
      expect(receive.mock.calls).toEqual([[]]);
      expect(received).toEqual(createDemoResearchMessage());
      expect(await store.load()).toEqual(received);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())
        .toEqual([{ name: 'latest_research' }]);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally { db.close(); }
  });

  it('blocks an attempted network call in an injected transport before persistence', async () => {
    const { fetch } = forbidExternalEffects();
    const save = vi.fn();
    await expect(receiveScoutResearch({ mode: 'SIMULATED', async receive() {
      await globalThis.fetch('https://demo.scout.invalid/forbidden');
      return JSON.stringify(createDemoResearchMessage());
    } }, { save, load: vi.fn() })).rejects.toThrow('UNEXPECTED_EXTERNAL_EFFECT');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses real transport before calling it or storage', async () => {
    const receive = vi.fn(disabledHttpsResearchTransport.receive);
    const save = vi.fn();
    await expect(receiveScoutResearch({ mode: 'HTTPS_DISABLED', receive },
      { save, load: vi.fn() })).rejects.toThrow('SCOUT_REAL_CONNECTION_DISABLED');
    expect(receive).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('the future HTTPS adapter fails closed even when called directly', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(disabledHttpsResearchTransport.receive()).rejects.toThrow('SCOUT_HTTPS_NOT_CONFIGURED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unrecognized runtime transport modes', async () => {
    const receive = vi.fn();
    await expect(receiveScoutResearch({ mode: 'NETWORK' as 'SIMULATED', receive },
      { save: vi.fn(), load: vi.fn() })).rejects.toThrow('SCOUT_REAL_CONNECTION_DISABLED');
    expect(receive).not.toHaveBeenCalled();
  });

  it.each(['malformed', 'extra command', 'permission'])('does not persist %s input', async kind => {
    const data = createDemoResearchMessage();
    const raw = kind === 'malformed' ? '{' : JSON.stringify(kind === 'extra command'
      ? { ...data, command: 'execute' } : { ...data, execution_authorized: true });
    const save = vi.fn();
    await expect(receiveScoutResearch({ mode: 'SIMULATED', async receive() { return raw; } },
      { save, load: vi.fn() })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it('propagates a provider failure without touching storage', async () => {
    const save = vi.fn();
    await expect(receiveScoutResearch({ mode: 'SIMULATED', async receive() {
      throw new Error('SIMULATED_FAILURE');
    } }, { save, load: vi.fn() })).rejects.toThrow('SIMULATED_FAILURE');
    expect(save).not.toHaveBeenCalled();
  });

  it('does not claim success when persistence fails', async () => {
    await expect(receiveScoutResearch(demoResearchTransport, {
      async save() { throw new Error('SQLITE_UNAVAILABLE'); }, load: vi.fn()
    })).rejects.toThrow('SQLITE_UNAVAILABLE');
  });
});
