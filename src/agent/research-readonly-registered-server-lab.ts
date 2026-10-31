import {
  createLabDeviceRegistry
} from './research-device-registry-lab.js';

import {
  startLoopbackReadonlyHttpsLab
} from './research-readonly-https-server-lab.js';

type RegisteredServerOptions = {
  enabled?: boolean;
  payload: string;
  registryFile: string;
  tls?: {
    key: string | Buffer;
    cert: string | Buffer;
  };
};

/**
 * Experimental registered HTTPS server.
 *
 * Loopback only.
 * Disabled by default.
 * Persistent revocation checked on every request.
 * No commercial execution.
 */
export async function startRegisteredLoopbackReadonlyHttpsLab(
  options: RegisteredServerOptions
) {
  if (options?.enabled !== true) {
    throw new Error('LAB_HTTPS_DISABLED');
  }

  const registry = createLabDeviceRegistry(
    options.registryFile
  );

  const expectedHash = registry.readHash();

  if (registry.isRevoked(expectedHash)) {
    throw new Error('LAB_DEVICE_REVOKED');
  }

  return startLoopbackReadonlyHttpsLab({
    enabled: true,
    payload: options.payload,
    expectedDeviceTokenHash: expectedHash,
    isRevoked: () => registry.isRevoked(expectedHash),
    tls: options.tls
  });
}
