import { parseMobileResearchImport, type ImportedPreview } from './research-mobile-import.js';
import { parseResearchBoundaryJson } from './research-data-boundary.js';

export const PUBLIC_SYNC_MAX_BYTES = 12000;
export type PublicResearchEnvelope = {
  protocol: 'scout-research-result';
  protocol_version: 2;
  engine_id: string;
  research_id: string;
  revision: number;
  generated_at: string;
  classification: 'PUBLIC_DISPLAY_ONLY';
  data_origin: 'FICTIONAL_TEST' | 'PUBLIC_RESEARCH';
  authentication: 'UNAUTHENTICATED';
  execution_authorized: false;
  preview: ImportedPreview;
};

export function utf8Bytes(value: string): number {
  let count = 0;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    count += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
  }
  return count;
}
export function syncRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function syncExact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) {
    throw new Error('INVALID_PUBLIC_SYNC_FIELDS');
  }
}

/** Conservative declared-source syntax; no DNS lookup, fetch or link opening. */
export function displaySourceUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 500 || /[\s\\%?#]/u.test(raw)) return false;
  try {
    const url = new URL(raw);
    const host = url.hostname;
    // DNS names only, no literal IP, userinfo, local names, queries or fragments.
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      url.href === raw && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?![\s\S])/.test(host) &&
      !/^\d+(?:\.\d+)+(?![\s\S])/.test(host) &&
      !/(?:^|\.)(?:localhost|local|internal|lan|onion)(?![\s\S])/.test(host);
  } catch { return false; }
}

/** Shape validation only: neither publicness nor origin is proven by a label. */
export function parsePublicResearchEnvelope(raw: string): PublicResearchEnvelope {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > PUBLIC_SYNC_MAX_BYTES ||
      utf8Bytes(raw) > PUBLIC_SYNC_MAX_BYTES) throw new Error('INVALID_PUBLIC_SYNC_SIZE');
  const data = parseResearchBoundaryJson(raw);
  if (!syncRecord(data)) throw new Error('INVALID_PUBLIC_SYNC');
  syncExact(data, ['protocol', 'protocol_version', 'engine_id', 'research_id', 'revision',
    'generated_at', 'classification', 'data_origin', 'authentication', 'execution_authorized', 'preview']);
  if (data.protocol !== 'scout-research-result' || data.protocol_version !== 2 ||
      data.classification !== 'PUBLIC_DISPLAY_ONLY' || data.authentication !== 'UNAUTHENTICATED' ||
      data.execution_authorized !== false ||
      (data.data_origin !== 'FICTIONAL_TEST' && data.data_origin !== 'PUBLIC_RESEARCH')) {
    throw new Error('INVALID_PUBLIC_SYNC_AUTHORITY');
  }
  if (typeof data.engine_id !== 'string' || !/^engine-[A-Za-z0-9_-]{1,64}(?![\s\S])/.test(data.engine_id) ||
      typeof data.research_id !== 'string' || !/^research-[A-Za-z0-9_-]{1,64}(?![\s\S])/.test(data.research_id) ||
      !Number.isSafeInteger(data.revision) || (data.revision as number) < 1 ||
      typeof data.generated_at !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z(?![\s\S])/.test(data.generated_at) ||
      !Number.isFinite(Date.parse(data.generated_at)) || new Date(data.generated_at).toISOString() !== data.generated_at) {
    throw new Error('INVALID_PUBLIC_SYNC_METADATA');
  }
  const preview = parseMobileResearchImport(JSON.stringify(data.preview));
  if (preview.cards.some(card => !displaySourceUrl(card.source_url) ||
      /[\p{Cc}\p{Cf}]/u.test(card.name + card.source_quote))) throw new Error('INVALID_PUBLIC_SYNC_SOURCE');
  return {
    protocol: 'scout-research-result', protocol_version: 2,
    engine_id: data.engine_id, research_id: data.research_id, revision: data.revision as number,
    generated_at: data.generated_at, classification: 'PUBLIC_DISPLAY_ONLY',
    data_origin: data.data_origin, authentication: 'UNAUTHENTICATED', execution_authorized: false, preview
  };
}
