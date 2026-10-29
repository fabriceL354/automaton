import { parseMobileResearchImport, type ImportedPreview } from './mobileResearchImport';
import { toMobileResearchPreview } from '../../../../src/agent/research-mobile-preview';
import type { MobileResearchInput } from '../../../../src/agent/research-mobile-preview';
import { assertResearchProjectionBoundary, parseResearchBoundaryJson }
  from '../../../../src/agent/research-data-boundary';

const MAX_FILE_CHARS = 131072;
const MAX_EVIDENCE = 10;
const MAX_OPPORTUNITIES = 3;
const SAFETY_FLAGS = [
  'project_created',
  'approval_created',
  'external_action_executed',
  'money_spent',
  'capability_granted',
  'installation_performed'
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validHttpsUrl(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('https://') &&
    v.length <= 500 && !/\s/.test(v);
}

/**
 * Offline, untrusted document import. This does not verify that Scout
 * produced the file, or that any referenced website is authentic.
 * Nothing is executed, uploaded, or persisted as a project.
 */
export function parseResearchResultFile(raw: string): ImportedPreview {
  if (!raw.trim() || raw.length > MAX_FILE_CHARS) {
    throw new Error('INVALID_FILE_SIZE');
  }
  const data = parseResearchBoundaryJson(raw);
  if (!isRecord(data)) throw new Error('INVALID_FILE');

  // Keep compatibility with the existing short, untrusted mobile preview.
  if (Object.hasOwn(data, 'cards')) {
    return parseMobileResearchImport(raw);
  }
  assertResearchProjectionBoundary(data);

  // Accept a genuine *shape* of a Scout read-only research.json output.
  // Shape and quote checks do not authenticate its origin.
  if (data.version !== '11.1' ||
      (data.status !== 'PASS' && data.status !== 'BLOCKED' &&
       data.status !== 'INSUFFICIENT_EVIDENCE') ||
      !Array.isArray(data.evidence) ||
      !Array.isArray(data.opportunities) ||
      data.evidence.length > MAX_EVIDENCE ||
      data.opportunities.length > MAX_OPPORTUNITIES ||
      !isRecord(data.security)) {
    throw new Error('INVALID_SCOUT_OUTPUT');
  }
  if (SAFETY_FLAGS.some(flag => (data.security as Record<string, unknown>)[flag] !== false)) {
    throw new Error('INVALID_SECURITY_FLAGS');
  }

  const ids = new Set<string>();
  for (const source of data.evidence) {
    if (!isRecord(source) ||
        typeof source.source_id !== 'string' ||
        !source.source_id || source.source_id.length > 128 ||
        !validHttpsUrl(source.url) ||
        typeof source.text !== 'string' ||
        !source.text || source.text.length > 2400 ||
        ids.has(source.source_id)) {
      throw new Error('INVALID_EVIDENCE');
    }
    ids.add(source.source_id);
  }

  if (data.status !== 'PASS' && data.opportunities.length !== 0) {
    throw new Error('UNEXPECTED_BLOCKED_OPPORTUNITIES');
  }

  for (const opportunity of data.opportunities) {
    if (!isRecord(opportunity) ||
        typeof opportunity.name !== 'string' ||
        !opportunity.name.trim() || opportunity.name.length > 80 ||
        (opportunity.kind !== 'QUICK_SERVICE' &&
         opportunity.kind !== 'DURABLE_ASSET') ||
        opportunity.execution_authorized !== false ||
        !isRecord(opportunity.evidence) ||
        typeof opportunity.evidence.source_id !== 'string' ||
        !ids.has(opportunity.evidence.source_id) ||
        !validHttpsUrl(opportunity.evidence.url) ||
        typeof opportunity.evidence.quote !== 'string' ||
        opportunity.evidence.quote.length < 16 ||
        opportunity.evidence.quote.length > 180 ||
        (opportunity.cost_basis !== 'UNKNOWN' &&
         opportunity.cost_basis !== 'ASSUMPTION' &&
         opportunity.cost_basis !== 'SOURCE_ESTIMATE') ||
        (opportunity.estimated_cost_cents !== null &&
         (typeof opportunity.estimated_cost_cents !== 'number' ||
          !Number.isSafeInteger(opportunity.estimated_cost_cents) ||
          opportunity.estimated_cost_cents < 0 ||
          opportunity.estimated_cost_cents > 10000))) {
      throw new Error('INVALID_OPPORTUNITY');
    }
  }

  // Runtime-validated subset of the full output contract required by
  // the existing read-only projection function.
  const preview = toMobileResearchPreview(data as unknown as MobileResearchInput);
  if (preview.cards.length !== data.opportunities.length) {
    throw new Error('UNVERIFIED_RECORDED_EVIDENCE');
  }
  return parseMobileResearchImport(JSON.stringify(preview));
}
