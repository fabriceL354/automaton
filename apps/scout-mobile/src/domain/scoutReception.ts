import {
  RESEARCH_RECEPTION_MAX_BYTES,
  type ResearchReceptionMessage
} from '../../../../src/agent/research-reception';
import { parseMobileResearchImport, type ImportedPreview } from './mobileResearchImport';

export type ReceivedResearch = Omit<ResearchReceptionMessage, 'preview'> & {
  preview: ImportedPreview;
};

function byteLength(raw: string): number {
  let bytes = 0;
  for (const char of raw) {
    const point = char.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** All fields are allowlisted; no object is interpreted as an engine command. */
export function parseScoutReception(raw: string): ReceivedResearch {
  if (typeof raw !== 'string' || !raw.trim() ||
      raw.length > RESEARCH_RECEPTION_MAX_BYTES ||
      byteLength(raw) > RESEARCH_RECEPTION_MAX_BYTES) {
    throw new Error('INVALID_RECEPTION_SIZE');
  }
  const data: unknown = JSON.parse(raw);
  const keys = ['protocol', 'protocol_version', 'research_id', 'generated_at',
    'classification', 'authentication', 'execution_authorized', 'preview'];
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).length !== keys.length ||
      Object.keys(data).some(key => !keys.includes(key))) {
    throw new Error('INVALID_RECEPTION_FIELDS');
  }
  const value = data as Record<string, unknown>;
  if (value.protocol !== 'scout-research-result' || value.protocol_version !== 1 ||
      value.classification !== 'FICTIONAL_DEMO' ||
      value.authentication !== 'UNAUTHENTICATED' ||
      value.execution_authorized !== false) {
    throw new Error('INVALID_RECEPTION_AUTHORITY');
  }
  // Unlike $, this end assertion cannot stop before a final line terminator.
  if (typeof value.research_id !== 'string' ||
      !/^demo-[a-zA-Z0-9_-]{1,75}(?![\s\S])/.test(value.research_id) ||
      typeof value.generated_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.generated_at) ||
      !Number.isFinite(Date.parse(value.generated_at)) ||
      new Date(value.generated_at).toISOString() !== value.generated_at) {
    throw new Error('INVALID_RECEPTION_METADATA');
  }
  const preview = parseMobileResearchImport(JSON.stringify(value.preview));
  // Reserved, non-routable fiction namespace; even declared real sources are refused.
  if (preview.cards.some(card =>
    !/^https:\/\/demo\.scout\.invalid\/[a-z0-9/_-]+$/.test(card.source_url))) {
    throw new Error('NON_DEMO_SOURCE');
  }
  return {
    protocol: 'scout-research-result',
    protocol_version: 1,
    research_id: value.research_id,
    generated_at: value.generated_at,
    classification: 'FICTIONAL_DEMO',
    authentication: 'UNAUTHENTICATED',
    execution_authorized: false,
    preview
  };
}
