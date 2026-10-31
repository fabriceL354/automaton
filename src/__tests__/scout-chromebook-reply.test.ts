import { describe, expect, it } from 'vitest';

import {
  validateChromebookReply,
  type ChromebookReply
} from '../../apps/scout-mobile/src/transport/scoutChromebookReply.js';

const URL = 'https://scout.example.test/v2/research-result';

function validReply(): ChromebookReply {
  return {
    status: 200,
    url: URL,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    },
    body: new TextEncoder().encode(
      '{"test":"fictional"}'
    )
  };
}

describe('Scout Chromebook Android reply validation', () => {
  it('accepts a correctly framed response', () => {
    expect(
      validateChromebookReply(validReply(), URL)
    ).toBe('{"test":"fictional"}');
  });

  it('rejects an HTTP error', () => {
    const reply = validReply();
    reply.status = 401;

    expect(() =>
      validateChromebookReply(reply, URL)
    ).toThrow();
  });

  it('rejects a different response URL', () => {
    const reply = validReply();
    reply.url = 'https://other.example.test/data';

    expect(() =>
      validateChromebookReply(reply, URL)
    ).toThrow();
  });

  it('rejects non-JSON responses', () => {
    const reply = validReply();
    reply.headers['content-type'] = 'text/html';

    expect(() =>
      validateChromebookReply(reply, URL)
    ).toThrow();
  });

  it('rejects cached responses', () => {
    const reply = validReply();
    reply.headers['cache-control'] = 'public';

    expect(() =>
      validateChromebookReply(reply, URL)
    ).toThrow();
  });

  it('rejects oversized responses', () => {
    const reply = validReply();
    reply.body = new Uint8Array(131073);

    expect(() =>
      validateChromebookReply(reply, URL)
    ).toThrow();
  });

  it('rejects a mismatched content length', () => {
    const reply = validReply();
    reply.headers['content-length'] = '999';

    expect(() =>
      validateChromebookReply(reply, URL)
    ).toThrow();
  });

  it('rejects invalid UTF-8', () => {
    const reply = validReply();
    reply.body = new Uint8Array([0xff]);

    expect(() =>
      validateChromebookReply(reply, URL)
    ).toThrow();
  });
});
