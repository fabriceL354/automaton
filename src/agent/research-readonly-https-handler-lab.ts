import type {
  IncomingMessage,
  ServerResponse
} from 'node:http';

import {
  createAuthenticatedFictionalLabResponder
} from './research-readonly-session-lab.js';

/**
 * Experimental HTTPS request handler.
 *
 * Does not create or start a server.
 * Does not open sockets or ports.
 * Fictional data only.
 *
 * Never attach to a public HTTP endpoint.
 */

export function createReadOnlyHttpsLabHandler(
  payload: string,
  expectedDeviceTokenHash: string,
  isRevoked: () => boolean
) {
  const respond = createAuthenticatedFictionalLabResponder(
    payload,
    expectedDeviceTokenHash,
    isRevoked
  );

  return (
    req: IncomingMessage,
    res: ServerResponse
  ): void => {
    const socket = req.socket as typeof req.socket & {
      encrypted?: boolean;
      getProtocol?: () => string | null;
    };

    let secure = false;

    try {
      secure = socket?.encrypted === true &&
        socket.getProtocol?.() === 'TLSv1.3';
    } catch {
      secure = false;
    }

    if (!secure) {
      res.writeHead(403, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'content-length': '0',
        'x-content-type-options': 'nosniff'
      });
      res.end('');
      return;
    }

    const reply = respond({
      method: req.method ?? '',
      path: req.url ?? '',
      authorization: req.headers?.authorization
    });

    res.writeHead(reply.status, {
      ...reply.headers,
      'x-content-type-options': 'nosniff'
    });

    res.end(reply.body);
  };
}
