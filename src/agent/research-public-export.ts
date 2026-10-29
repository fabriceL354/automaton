import { createHash } from 'node:crypto';
import { assertResearchProjectionBoundary, parseResearchBoundaryJson } from './research-data-boundary.js';
import { containsKnownPrivate, type PrivateQueryContext } from './query-guard.js';
import { toMobileResearchPreview, type MobileResearchInput } from './research-mobile-preview.js';
import { displaySourceUrl, parsePublicResearchEnvelope, syncExact, syncRecord,
  type PublicResearchEnvelope } from './research-public-sync.js';

const SECURITY_FLAGS = ['project_created', 'approval_created', 'external_action_executed',
  'money_spent', 'capability_granted', 'installation_performed'] as const;

export type PublicExportMetadata = Pick<PublicResearchEnvelope,
  'engine_id' | 'research_id' | 'revision' | 'generated_at' | 'data_origin'>;
export type PublicReleaseApproval = {
  approved_payload_sha256: string;
  reviewed_source_urls: readonly string[];
};

function digest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Pure local projection: does not read a file, run research, send or log data. */
function project(raw: string, metadata: PublicExportMetadata, context: PrivateQueryContext): string {
  if (typeof raw !== 'string' || !raw.trim() || Buffer.byteLength(raw) > 131072) throw new Error('INVALID_RESEARCH_FILE');
  syncExact(metadata as unknown as Record<string, unknown>,
    ['engine_id', 'research_id', 'revision', 'generated_at', 'data_origin']);
  const data = parseResearchBoundaryJson(raw);
  assertResearchProjectionBoundary(data);
  if (!syncRecord(data) || data.version !== '11.1' ||
      !['PASS', 'BLOCKED', 'INSUFFICIENT_EVIDENCE'].includes(String(data.status)) ||
      !Array.isArray(data.evidence) || data.evidence.length > 10 ||
      !Array.isArray(data.opportunities) || data.opportunities.length > 3 || !syncRecord(data.security)) {
    throw new Error('INVALID_RESEARCH_FILE');
  }
  const security = data.security;
  syncExact(security, SECURITY_FLAGS);
  if (SECURITY_FLAGS.some(flag => security[flag] !== false)) throw new Error('UNSAFE_RESEARCH_OUTPUT');
  if (data.status !== 'PASS' && data.opportunities.length) throw new Error('INVALID_BLOCKED_OPPORTUNITIES');
  const ids = new Set<string>();
  for (const source of data.evidence) {
    if (!syncRecord(source) || typeof source.source_id !== 'string' || !source.source_id ||
        source.source_id.length > 128 || ids.has(source.source_id) || !displaySourceUrl(source.url) ||
        typeof source.text !== 'string' || !source.text || source.text.length > 2400) throw new Error('INVALID_EXPORT_EVIDENCE');
    ids.add(source.source_id);
  }
  for (const item of data.opportunities) {
    if (!syncRecord(item) || !syncRecord(item.evidence) ||
        !ids.has(String(item.evidence.source_id)) || item.execution_authorized !== false ||
        typeof item.name !== 'string' || !['QUICK_SERVICE', 'DURABLE_ASSET'].includes(String(item.kind)) ||
        !['SOURCE_ESTIMATE', 'ASSUMPTION', 'UNKNOWN'].includes(String(item.cost_basis)) ||
        (item.estimated_cost_cents !== null && (!Number.isSafeInteger(item.estimated_cost_cents) ||
          (item.estimated_cost_cents as number) < 0 || (item.estimated_cost_cents as number) > 10000)) ||
        !displaySourceUrl(item.evidence.url) || typeof item.evidence.quote !== 'string' ||
        item.evidence.quote.length < 16 || item.evidence.quote.length > 180) throw new Error('INVALID_EXPORT_OPPORTUNITY');
  }
  const preview = toMobileResearchPreview(data as unknown as MobileResearchInput);
  if (preview.cards.length !== data.opportunities.length) throw new Error('UNVERIFIED_EXPORT_EVIDENCE');
  const message = parsePublicResearchEnvelope(JSON.stringify({
    protocol: 'scout-research-result', protocol_version: 2, ...metadata,
    classification: 'PUBLIC_DISPLAY_ONLY', authentication: 'UNAUTHENTICATED',
    execution_authorized: false, preview
  }));
  const serialized = JSON.stringify(message);
  if (containsKnownPrivate(serialized, context)) throw new Error('PRIVATE_EXPORT_REFUSED');
  return serialized;
}

/** Local review only. A digest is an approval binding, NOT authentication or DLP. */
export function reviewResearchExport(raw: string, metadata: PublicExportMetadata,
  context: PrivateQueryContext = {}) {
  const candidate = project(raw, metadata, context);
  const message = parsePublicResearchEnvelope(candidate);
  return {
    candidate,
    payload_sha256: digest(candidate),
    source_urls: [...new Set(message.preview.cards.map(card => card.source_url))]
  };
}

/** No export by default. Approval is trusted host/operator input, never from research.json. */
export function exportReviewedResearch(raw: string, metadata: PublicExportMetadata,
  approval?: PublicReleaseApproval, context: PrivateQueryContext = {}): string {
  if (!approval || !syncRecord(approval)) throw new Error('PUBLIC_RELEASE_APPROVAL_REQUIRED');
  syncExact(approval, ['approved_payload_sha256', 'reviewed_source_urls']);
  const candidate = project(raw, metadata, context);
  if (typeof approval.approved_payload_sha256 !== 'string' || digest(candidate) !== approval.approved_payload_sha256 ||
      !Array.isArray(approval.reviewed_source_urls) ||
      approval.reviewed_source_urls.some(url => !displaySourceUrl(url))) throw new Error('PUBLIC_RELEASE_APPROVAL_MISMATCH');
  const message = parsePublicResearchEnvelope(candidate);
  if (message.preview.cards.some(card => !approval.reviewed_source_urls.includes(card.source_url))) {
    throw new Error('PUBLIC_SOURCE_NOT_APPROVED');
  }
  return candidate;
}
