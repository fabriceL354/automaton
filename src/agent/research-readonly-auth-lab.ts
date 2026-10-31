import {
  createHash,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

/**
 * Experimental device authentication.
 *
 * No network access.
 * No persistent secret storage.
 * No commercial execution.
 */

export function generateLabDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashLabDeviceToken(
  token: string
): string {
  return createHash('sha256')
    .update(token, 'utf8')
    .digest('hex');
}

export function createLabDeviceAuthorizer(
  expectedHash: string,
  isRevoked: () => boolean
) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error('INVALID_DEVICE_HASH');
  }

  const expected = Buffer.from(expectedHash, 'hex');

  return (authorization: unknown): boolean => {
    try {
      if (isRevoked()) return false;

      if (typeof authorization !== 'string') {
        return false;
      }

      if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(
        authorization
      )) {
        return false;
      }

      const token = authorization.slice(7);

      if (
        Buffer.from(token, 'base64url')
          .toString('base64url') !== token
      ) {
        return false;
      }

      const actual = createHash('sha256')
        .update(token, 'utf8')
        .digest();

      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  };
}
