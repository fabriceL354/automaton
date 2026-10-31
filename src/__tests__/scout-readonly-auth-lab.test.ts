import { describe, expect, it } from 'vitest';

import {
  generateLabDeviceToken,
  hashLabDeviceToken,
  createLabDeviceAuthorizer
} from '../agent/research-readonly-auth-lab.js';

describe('Scout experimental device authentication', () => {

  it('generates random 256-bit tokens', () => {
    const a = generateLabDeviceToken();
    const b = generateLabDeviceToken();

    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('generates a SHA-256 token hash', () => {
    const token = generateLabDeviceToken();
    const hash = hashLabDeviceToken(token);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashLabDeviceToken(token)).toBe(hash);
  });

  it('accepts an authorized device', () => {
    const token = generateLabDeviceToken();
    const auth = createLabDeviceAuthorizer(
      hashLabDeviceToken(token),
      () => false
    );

    expect(auth(`Bearer ${token}`)).toBe(true);
  });

  it('rejects another device', () => {
    const token = generateLabDeviceToken();
    const other = generateLabDeviceToken();

    const auth = createLabDeviceAuthorizer(
      hashLabDeviceToken(token),
      () => false
    );

    expect(auth(`Bearer ${other}`)).toBe(false);
  });

  it('rejects missing or malformed credentials', () => {
    const token = generateLabDeviceToken();

    const auth = createLabDeviceAuthorizer(
      hashLabDeviceToken(token),
      () => false
    );

    expect(auth(undefined)).toBe(false);
    expect(auth(null)).toBe(false);
    expect(auth('')).toBe(false);
    expect(auth(token)).toBe(false);
    expect(auth('Bearer test-token-scout')).toBe(false);
    expect(auth(`Bearer ${token}=`)).toBe(false);
  });

  it('rejects a revoked device', () => {
    const token = generateLabDeviceToken();
    let revoked = false;

    const auth = createLabDeviceAuthorizer(
      hashLabDeviceToken(token),
      () => revoked
    );

    expect(auth(`Bearer ${token}`)).toBe(true);

    revoked = true;

    expect(auth(`Bearer ${token}`)).toBe(false);
  });

  it('fails closed if revocation check throws', () => {
    const token = generateLabDeviceToken();

    const auth = createLabDeviceAuthorizer(
      hashLabDeviceToken(token),
      () => {
        throw new Error('REVOCATION_UNAVAILABLE');
      }
    );

    expect(auth(`Bearer ${token}`)).toBe(false);
  });

  it('rejects invalid stored hashes', () => {
    expect(() =>
      createLabDeviceAuthorizer('invalid', () => false)
    ).toThrow('INVALID_DEVICE_HASH');
  });

  it('never accepts an execution request as a token', () => {
    const token = generateLabDeviceToken();

    const auth = createLabDeviceAuthorizer(
      hashLabDeviceToken(token),
      () => false
    );

    expect(auth({
      method: 'POST',
      authorization: `Bearer ${token}`
    })).toBe(false);
  });

});
