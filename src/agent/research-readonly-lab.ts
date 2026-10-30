import { timingSafeEqual } from 'node:crypto';
import { parsePublicResearchEnvelope } from './research-public-sync.js';

type LabRequest = {
  method: string;
  path: string;
  authorization?: string;
};

type LabResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

const PATH = '/v2/research-result';
const MAX_BYTES = 128 * 1024;

function equalTokens(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length &&
    timingSafeEqual(left, right);
}

function response(status: number, body = ''): LabResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(body))
    },
    body
  };
}

/**
 * Experimental in-memory responder.
 *
 * No HTTP server, socket, file access or network call.
 * Only fictional Scout V2 envelopes are accepted.
 *
 * A valid envelope is not proof of export approval.
 * Production release validation remains a separate requirement.
 */
export function createFictionalReadOnlyResponder(
  payload: string,
  testToken: string
) {
  if (!/^test-token-[a-z0-9]{1,32}$/.test(testToken)) {
    throw new Error('INVALID_LAB_TOKEN');
  }

  if (
    typeof payload !== 'string' ||
    !payload.length ||
    Buffer.byteLength(payload) > MAX_BYTES
  ) {
    throw new Error('INVALID_LAB_PAYLOAD');
  }

  const message = parsePublicResearchEnvelope(payload);

  if (
    message.data_origin !== 'FICTIONAL_TEST' ||
    message.authentication !== 'UNAUTHENTICATED' ||
    message.classification !== 'PUBLIC_DISPLAY_ONLY' ||
    message.execution_authorized !== false
  ) {
    throw new Error('NON_FICTIONAL_RESULT_REFUSED');
  }

  const safePayload = JSON.stringify(message);

  if (Buffer.byteLength(safePayload) > MAX_BYTES) {
    throw new Error('INVALID_LAB_PAYLOAD');
  }

  return (request: LabRequest): LabResponse => {
    if (request.method !== 'GET') {
      return response(405);
    }

    if (request.path !== PATH) {
      return response(404);
    }

    if (!equalTokens(
      request.authorization ?? '',
      `Bearer ${testToken}`
    )) {
      return response(401);
    }

    return response(200, safePayload);
  };
}
