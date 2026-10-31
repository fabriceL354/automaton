import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';

import {
  createReadOnlyHttpsLabHandler
} from './research-readonly-https-handler-lab.js';

type LabServerOptions = {
  enabled?: boolean;
  payload: string;
  expectedDeviceTokenHash: string;
  isRevoked: () => boolean;
  tls?: {
    key: string | Buffer;
    cert: string | Buffer;
  };
};

/**
 * Experimental loopback-only HTTPS server.
 *
 * Disabled by default.
 * Never binds to a public or LAN interface.
 * Never starts during module import.
 * No commercial operations.
 */
export async function startLoopbackReadonlyHttpsLab(
  options: LabServerOptions
) {
  if (options?.enabled !== true) {
    throw new Error('LAB_HTTPS_DISABLED');
  }

  if (!options.tls?.key || !options.tls?.cert) {
    throw new Error('LAB_TLS_MATERIAL_REQUIRED');
  }

  const handler = createReadOnlyHttpsLabHandler(
    options.payload,
    options.expectedDeviceTokenHash,
    options.isRevoked
  );

  const server = createServer({
    key: options.tls.key,
    cert: options.tls.cert,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3'
  }, handler);

  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.timeout = 5000;
  server.maxHeadersCount = 24;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };

    server.once('error', onError);

    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    host: '127.0.0.1',
    port: address.port,

    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error);
        else resolve();
      });
    })
  };
}
