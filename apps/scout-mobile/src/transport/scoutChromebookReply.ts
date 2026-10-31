const MAX_BYTES = 128 * 1024;

export type ChromebookReply = {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
};

/**
 * Validates a response supplied by a trusted HTTPS adapter.
 *
 * Does not connect to a network.
 * Does not authenticate TLS certificates.
 * The caller must separately verify TLS and parse
 * the strict Scout V2 envelope.
 */
export function validateChromebookReply(
  reply: ChromebookReply,
  expectedUrl: string
): string {
  if (
    reply.status !== 200 ||
    reply.url !== expectedUrl ||
    !expectedUrl.startsWith('https://')
  ) {
    throw new Error('SCOUT_SYNC_RESPONSE_REFUSED');
  }

  const headers = Object.fromEntries(
    Object.entries(reply.headers).map(
      ([key, value]) => [key.toLowerCase(), value]
    )
  );

  if (
    headers['content-type']?.toLowerCase()
      .split(';')[0].trim() !== 'application/json' ||
    headers['cache-control'] !== 'no-store' ||
    (
      headers['content-encoding'] !== undefined &&
      headers['content-encoding'] !== 'identity'
    )
  ) {
    throw new Error('SCOUT_SYNC_HEADERS_REFUSED');
  }

  const body = reply.body;

  if (
    !(body instanceof Uint8Array) ||
    body.byteLength === 0 ||
    body.byteLength > MAX_BYTES
  ) {
    throw new Error('SCOUT_SYNC_SIZE_REFUSED');
  }

  if (headers['content-length'] !== undefined) {
    const length = headers['content-length'];

    if (
      !/^(0|[1-9][0-9]*)$/.test(length) ||
      Number(length) !== body.byteLength
    ) {
      throw new Error('SCOUT_SYNC_LENGTH_REFUSED');
    }
  }

  try {
    return new TextDecoder('utf-8', {
      fatal: true
    }).decode(body);
  } catch {
    throw new Error('SCOUT_SYNC_ENCODING_REFUSED');
  }
}
