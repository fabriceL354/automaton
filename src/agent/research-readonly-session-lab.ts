import { createLabDeviceAuthorizer } from './research-readonly-auth-lab.js';
import { createFictionalReadOnlyResponder } from './research-readonly-lab.js';

type LabRequest = {
  method: string;
  path: string;
  authorization?: unknown;
};

type LabResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

/**
 * In-memory integration experiment only.
 *
 * This adapter never opens a socket or performs network I/O.
 * The internal test credential is not a real device credential.
 * Do not attach this adapter directly to an HTTP server.
 */
export function createAuthenticatedFictionalLabResponder(
  payload: string,
  expectedDeviceTokenHash: string,
  isRevoked: () => boolean
): (request: LabRequest) => LabResponse {

  const authorize = createLabDeviceAuthorizer(
    expectedDeviceTokenHash,
    isRevoked
  );

  const internalToken = 'test-token-internal';

  const respond = createFictionalReadOnlyResponder(
    payload,
    internalToken
  );

  return (request: LabRequest): LabResponse => {

    if (!request || !authorize(request.authorization)) {
      return {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'content-length': '0'
        },
        body: ''
      };
    }

    return respond({
      method: request.method,
      path: request.path,
      authorization: `Bearer ${internalToken}`
    });
  };
}
