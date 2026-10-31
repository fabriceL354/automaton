import {
  parsePublicResearchEnvelope
} from '../../../../src/agent/research-public-sync.js';

import type {
  PreparedReadOnlySyncTransport
} from '../../../../src/agent/research-sync-https-preparation.js';

import {
  validateChromebookReply,
  type ChromebookReply
} from './scoutChromebookReply';

/**
 * Experimental injected transport.
 *
 * No network connection.
 * No TLS certificate verification.
 * No real device credentials.
 *
 * SIMULATED_HTTPS is intentional.
 * Never use this implementation as a live HTTPS client.
 */
export function createChromebookTransportLab(
  expectedUrl: string,
  readInjectedReply: () => Promise<ChromebookReply>
): PreparedReadOnlySyncTransport {

  if (
    typeof expectedUrl !== 'string' ||
    !expectedUrl.startsWith('https://') ||
    !expectedUrl.endsWith('/v2/research-result') ||
    typeof readInjectedReply !== 'function'
  ) {
    throw new Error('INVALID_CHROMEBOOK_LAB_CONFIG');
  }

  let busy = false;

  return {
    mode: 'SIMULATED_HTTPS',

    async receive(): Promise<string> {
      if (busy) {
        throw new Error('CHROMEBOOK_LAB_BUSY');
      }

      busy = true;

      try {
        const reply = await readInjectedReply();

        const raw = validateChromebookReply(
          reply,
          expectedUrl
        );

        const message = parsePublicResearchEnvelope(raw);

        if (
          message.data_origin !== 'FICTIONAL_TEST' ||
          message.authentication !== 'UNAUTHENTICATED' ||
          message.execution_authorized !== false ||
          message.classification !== 'PUBLIC_DISPLAY_ONLY'
        ) {
          throw new Error('INVALID_LAB_RESULT');
        }

        return raw;

      } catch {
        throw new Error('CHROMEBOOK_REPLY_REFUSED');

      } finally {
        busy = false;
      }
    }
  };
}
