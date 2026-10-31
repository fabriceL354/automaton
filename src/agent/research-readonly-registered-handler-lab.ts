import {
  createLabDeviceRegistry
} from './research-device-registry-lab.js';

import {
  createReadOnlyHttpsLabHandler
} from './research-readonly-https-handler-lab.js';

/**
 * Experimental persistent authorization adapter.
 *
 * No server creation.
 * No network access.
 * No commercial execution.
 *
 * Revocation is checked on every request.
 */
export function createRegisteredReadOnlyHttpsLabHandler(
  payload: string,
  registryFile: string
) {
  const registry = createLabDeviceRegistry(registryFile);

  // Missing or corrupted registry prevents initialization.
  const expectedHash = registry.readHash();

  return createReadOnlyHttpsLabHandler(
    payload,
    expectedHash,
    () => registry.isRevoked(expectedHash)
  );
}
