import { describe, expect, it } from 'vitest';
import { isAcceptableScoutJsonFile as accepts } from '../../apps/scout-mobile/src/domain/scoutJsonFileSelection';

describe('Scout Android - JSON file selection', () => {
  it('accepts a normal JSON filename', () => {
    expect(accepts({ name: 'test.json', size: 432 })).toBe(true);
  });

  it('accepts Android msf with JSON MIME', () => {
    expect(accepts({
      name: 'msf:1000020929',
      size: 432,
      type: 'application/json'
    })).toBe(true);
  });

  it('rejects msf without valid JSON MIME', () => {
    expect(accepts({
      name: 'msf:1000020929',
      size: 432,
      type: 'text/plain'
    })).toBe(false);
  });

  it('rejects unrelated names despite JSON MIME', () => {
    expect(accepts({
      name: 'fichier.txt',
      size: 432,
      type: 'application/json'
    })).toBe(false);
  });

  it('enforces file size limits', () => {
    for (const size of [0, -1, 131073, 1.5, NaN]) {
      expect(accepts({ name: 'test.json', size })).toBe(false);
    }
    expect(accepts({ name: 'test.json', size: 1 })).toBe(true);
    expect(accepts({ name: 'test.json', size: 131072 })).toBe(true);
  });
});
