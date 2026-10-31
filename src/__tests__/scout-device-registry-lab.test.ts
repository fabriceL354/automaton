import {
  describe, it, expect, beforeEach, afterEach
} from 'vitest';

import {
  mkdtempSync, rmSync, chmodSync, statSync,
  readFileSync, writeFileSync, symlinkSync
} from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createLabDeviceRegistry
} from '../agent/research-device-registry-lab.js';

import {
  generateLabDeviceToken,
  hashLabDeviceToken,
  createLabDeviceAuthorizer
} from '../agent/research-readonly-auth-lab.js';

describe('Scout device registry persistence lab', () => {
  let folder: string;
  let file: string;

  beforeEach(() => {
    folder = mkdtempSync(
      join(tmpdir(), 'scout-device-registry-test-')
    );

    chmodSync(folder, 0o700);
    file = join(folder, 'device.json');
  });

  afterEach(() => {
    rmSync(folder, {
      recursive: true,
      force: true
    });
  });

  it('stores a token hash without plaintext token', () => {
    const token = generateLabDeviceToken();
    const hash = hashLabDeviceToken(token);
    const registry = createLabDeviceRegistry(file);

    registry.enroll(hash);

    expect(registry.readHash()).toBe(hash);
    expect(registry.isRevoked(hash)).toBe(false);

    const content = readFileSync(file, 'utf8');

    expect(content).not.toContain(token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('preserves authorization after reopening', () => {
    const hash = hashLabDeviceToken(
      generateLabDeviceToken()
    );

    createLabDeviceRegistry(file).enroll(hash);

    const reopened = createLabDeviceRegistry(file);

    expect(reopened.readHash()).toBe(hash);
    expect(reopened.isRevoked(hash)).toBe(false);
  });

  it('preserves revocation after reopening', () => {
    const hash = hashLabDeviceToken(
      generateLabDeviceToken()
    );

    createLabDeviceRegistry(file).enroll(hash);
    createLabDeviceRegistry(file).revoke();

    const reopened = createLabDeviceRegistry(file);

    expect(reopened.isRevoked(hash)).toBe(true);

    reopened.revoke();

    expect(
      createLabDeviceRegistry(file).isRevoked(hash)
    ).toBe(true);
  });

  it('blocks a previously authorized device after revocation', () => {
    const token = generateLabDeviceToken();
    const hash = hashLabDeviceToken(token);

    createLabDeviceRegistry(file).enroll(hash);

    const authorize = createLabDeviceAuthorizer(
      hash,
      () => createLabDeviceRegistry(file).isRevoked(hash)
    );

    expect(authorize(`Bearer ${token}`)).toBe(true);

    createLabDeviceRegistry(file).revoke();

    expect(authorize(`Bearer ${token}`)).toBe(false);
  });

  it('rejects a different device', () => {
    const hash = hashLabDeviceToken(
      generateLabDeviceToken()
    );

    const other = hashLabDeviceToken(
      generateLabDeviceToken()
    );

    const registry = createLabDeviceRegistry(file);

    registry.enroll(hash);

    expect(registry.isRevoked(other)).toBe(true);
  });

  it('fails closed for missing or corrupted registry', () => {
    const hash = hashLabDeviceToken(
      generateLabDeviceToken()
    );

    const registry = createLabDeviceRegistry(file);

    expect(registry.isRevoked(hash)).toBe(true);

    registry.enroll(hash);

    writeFileSync(file, '{INVALID JSON');

    expect(registry.isRevoked(hash)).toBe(true);
    expect(() => registry.readHash()).toThrow();
  });

  it('refuses insecure file permissions', () => {
    const hash = hashLabDeviceToken(
      generateLabDeviceToken()
    );

    const registry = createLabDeviceRegistry(file);

    registry.enroll(hash);
    chmodSync(file, 0o644);

    expect(registry.isRevoked(hash)).toBe(true);
    expect(() => registry.readHash()).toThrow();
  });

  it('refuses a symbolic link as registry', () => {
    const hash = hashLabDeviceToken(
      generateLabDeviceToken()
    );

    const otherFile = join(folder, 'other.json');

    createLabDeviceRegistry(otherFile).enroll(hash);

    symlinkSync(otherFile, file);

    const registry = createLabDeviceRegistry(file);

    expect(registry.isRevoked(hash)).toBe(true);
    expect(() => registry.readHash()).toThrow();
  });

  it('refuses an insecure parent directory', () => {
    const hash = hashLabDeviceToken(
      generateLabDeviceToken()
    );

    chmodSync(folder, 0o755);

    expect(() =>
      createLabDeviceRegistry(file).enroll(hash)
    ).toThrow('PRIVATE_DIRECTORY_REQUIRED');
  });

  it('refuses duplicate enrollment and invalid hashes', () => {
    const hash = hashLabDeviceToken(
      generateLabDeviceToken()
    );

    const registry = createLabDeviceRegistry(file);

    registry.enroll(hash);

    expect(() => registry.enroll(hash)).toThrow();

    expect(() =>
      registry.enroll('invalid')
    ).toThrow('INVALID_DEVICE_HASH');
  });

});
