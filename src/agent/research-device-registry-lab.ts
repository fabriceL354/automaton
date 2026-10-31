import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  fsyncSync,
  unlinkSync
} from 'node:fs';

import {
  dirname,
  isAbsolute
} from 'node:path';

import { randomBytes } from 'node:crypto';

type DeviceRecord = {
  version: 1;
  token_sha256: string;
  revoked: boolean;
};

const HASH = /^[a-f0-9]{64}$/;

function readRecord(file: string): DeviceRecord {
  let fd: number | undefined;

  try {
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );

    const stat = fstatSync(fd);

    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size < 1 ||
      stat.size > 512
    ) {
      throw new Error('INVALID_REGISTRY_FILE');
    }

    const data: unknown = JSON.parse(
      readFileSync(fd, 'utf8')
    );

    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data)
    ) {
      throw new Error('INVALID_REGISTRY_DATA');
    }

    const record = data as Record<string, unknown>;

    if (
      Object.keys(record).sort().join(',') !==
        'revoked,token_sha256,version' ||
      record.version !== 1 ||
      typeof record.token_sha256 !== 'string' ||
      !HASH.test(record.token_sha256) ||
      typeof record.revoked !== 'boolean'
    ) {
      throw new Error('INVALID_REGISTRY_DATA');
    }

    return record as DeviceRecord;

  } catch {
    throw new Error('LAB_REGISTRY_UNAVAILABLE');

  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Single-device experimental registry.
 * No network access and no plaintext token storage.
 * Not suitable for production deployment.
 */
export function createLabDeviceRegistry(file: string) {
  if (!isAbsolute(file)) {
    throw new Error('ABSOLUTE_PATH_REQUIRED');
  }

  function checkDirectory() {
    const dir = lstatSync(dirname(file));

    if (
      !dir.isDirectory() ||
      (dir.mode & 0o077) !== 0
    ) {
      throw new Error('PRIVATE_DIRECTORY_REQUIRED');
    }
  }

  return {
    enroll(tokenHash: string) {
      checkDirectory();

      if (!HASH.test(tokenHash)) {
        throw new Error('INVALID_DEVICE_HASH');
      }

      const record: DeviceRecord = {
        version: 1,
        token_sha256: tokenHash,
        revoked: false
      };

      writeFileSync(
        file,
        JSON.stringify(record),
        {
          flag: 'wx',
          mode: 0o600
        }
      );
    },

    readHash() {
      return readRecord(file).token_sha256;
    },

    isRevoked(expectedHash: string) {
      try {
        const record = readRecord(file);

        return (
          record.revoked ||
          record.token_sha256 !== expectedHash
        );
      } catch {
        return true;
      }
    },

    revoke() {
      checkDirectory();

      const record = readRecord(file);

      if (record.revoked) return;

      const temp =
        file + '.tmp-' + randomBytes(12).toString('hex');

      let fd: number | undefined;

      try {
        fd = openSync(
          temp,
          constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
          0o600
        );

        writeFileSync(fd, JSON.stringify({
          ...record,
          revoked: true
        }));

        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;

        renameSync(temp, file);

        const dirFd = openSync(
          dirname(file),
          constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW
        );

        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }

      } finally {
        if (fd !== undefined) closeSync(fd);

        try {
          unlinkSync(temp);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !==
            'ENOENT'
          ) throw error;
        }
      }
    }
  };
}
