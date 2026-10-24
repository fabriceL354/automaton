/** Static categories only. Never include a model value, key, source text or exception message. */
import { RESEARCH_LIMITS, researchInteger, researchText } from '../../src/agent/research-model.js';

export type FieldIssue = {
  field: 'root' | 'candidates' | 'candidate' | 'name' | 'kind' | 'source_index' | 'evidence_index';
  category: 'TYPE' | 'MISSING_FIELD' | 'EXTRA_FIELDS' | 'COUNT' | 'EMPTY' | 'LENGTH' |
    'CONTROL_OR_FORMAT' | 'PUBLIC_TEXT_REFUSED' | 'PLACEHOLDER' | 'ENUM' | 'INTEGER' |
    'RANGE' | 'NEGATIVE_ZERO' | 'SOURCE_NOT_SUPPLIED' | 'EXTRACTION_COUNT';
};
export type DiagnosticContext = { sourceIndexes?: readonly number[]; oneCandidate?: boolean; queryWithoutEvidence?: boolean };
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Context is derived from host-generated prompt structure, never from the model's claimed index. */
export function diagnosticContext(phase: string, data: string): DiagnosticContext {
  if (phase === 'query_proposal') return { queryWithoutEvidence: data.includes('evidence_index must be null.') };
  if (phase !== 'candidates') return {};
  const match = data.match(/UNTRUSTED READ EVIDENCE: (.+)\nReturn /);
  if (!match) return {};
  try {
    const entries: unknown = JSON.parse(match[1]);
    if (!Array.isArray(entries) || entries.length > RESEARCH_LIMITS.pages) return {};
    const indexes = entries.map(e => record(e) ? e.index : undefined);
    if (!indexes.every(i => typeof i === 'number' && Number.isSafeInteger(i) && i >= 0 && i < RESEARCH_LIMITS.pages)) return {};
    return { sourceIndexes: indexes as number[], oneCandidate: data.includes('Exact fields name,kind,source_index.') };
  } catch { return {}; }
}

export function candidateFieldIssues(value: unknown, context: DiagnosticContext = {}): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const add = (field: FieldIssue['field'], category: FieldIssue['category']) => {
    if (!issues.some(i => i.field === field && i.category === category)) issues.push({ field, category });
  };
  const fields = (x: Record<string, unknown>, expected: string[], field: FieldIssue['field']) => {
    if (expected.some(k => !Object.hasOwn(x, k))) add(field, 'MISSING_FIELD');
    if (Object.keys(x).some(k => !expected.includes(k))) add(field, 'EXTRA_FIELDS');
  };
  if (!record(value)) { add('root', 'TYPE'); return issues; }
  fields(value, ['candidates'], 'root');
  if (!Object.hasOwn(value, 'candidates')) return issues;
  if (!Array.isArray(value.candidates)) { add('candidates', 'TYPE'); return issues; }
  if (value.candidates.length > RESEARCH_LIMITS.candidates) add('candidates', 'COUNT');
  if (context.oneCandidate && value.candidates.length > 1) add('candidates', 'EXTRACTION_COUNT');
  // Bound diagnostic work independently of a malformed collection. Categories are deduplicated.
  for (const candidate of value.candidates.slice(0, RESEARCH_LIMITS.candidates + 1)) {
    if (!record(candidate)) { add('candidate', 'TYPE'); continue; }
    if (Object.keys(candidate).some(k => !['name', 'kind', 'source_index'].includes(k))) add('candidate', 'EXTRA_FIELDS');
    for (const field of ['name', 'kind', 'source_index'] as const) {
      if (!Object.hasOwn(candidate, field)) { add(field, 'MISSING_FIELD'); continue; }
      const v = candidate[field];
      if (field === 'name') {
        try { researchText(v, 80); } catch (error) {
          add(field, typeof v !== 'string' ? 'TYPE' : !v.trim() ? 'EMPTY' : v.length > 80 ? 'LENGTH' :
            /[\p{Cc}\p{Cf}]/u.test(v) ? 'CONTROL_OR_FORMAT' :
            error instanceof Error && error.message === 'Public research placeholder refused' ? 'PLACEHOLDER' : 'PUBLIC_TEXT_REFUSED');
        }
      } else if (field === 'kind') {
        if (typeof v !== 'string') add(field, 'TYPE');
        else if (v !== 'QUICK_SERVICE' && v !== 'DURABLE_ASSET') add(field, 'ENUM');
      } else {
        try {
          const index = researchInteger(v, RESEARCH_LIMITS.pages - 1);
          if (context.sourceIndexes && !context.sourceIndexes.includes(index)) add(field, 'SOURCE_NOT_SUPPLIED');
        } catch {
          add(field, typeof v !== 'number' ? 'TYPE' : !Number.isSafeInteger(v) ? 'INTEGER' : Object.is(v, -0) ? 'NEGATIVE_ZERO' : 'RANGE');
        }
      }
    }
  }
  return issues;
}
