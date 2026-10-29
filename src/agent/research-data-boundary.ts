/** Pure data boundary, shared with Android. No model, Node API, network or storage. */
export const RESEARCH_ECONOMIC_WARNING = 'Aperçu partiel : coûts et revenus non validés. ' +
  'Frais complets et risques restent à examiner. Un coût nul ne démontre pas un bénéfice. Rentabilité non établie.';
export const LEGACY_RESEARCH_TRUST_WARNING = 'Origine et fournisseur non renseignés par ce format historique ; ' +
  'ne pas les déduire. Données non authentifiées.';

/** JSON.parse alone silently overwrites duplicate provenance/authority/cost keys. */
export function parseResearchBoundaryJson(raw: string): unknown {
  const value: unknown = JSON.parse(raw);
  const stack: { object: boolean; key: boolean; keys: Set<string> }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') {
      const start = i++;
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === '\\') i++;
        i++;
      }
      const top = stack[stack.length - 1];
      if (top?.object && top.key) {
        const key = JSON.parse(raw.slice(start, i + 1)) as string;
        if (top.keys.has(key)) throw new Error('DUPLICATE_RESEARCH_JSON_KEY');
        top.keys.add(key);
      }
    } else if (c === '{' || c === '[') {
      stack.push({ object: c === '{', key: c === '{', keys: new Set() });
    } else if (c === '}' || c === ']') stack.pop();
    else if (c === ':' && stack.length) stack[stack.length - 1].key = false;
    else if (c === ',' && stack.length) stack[stack.length - 1].key = stack[stack.length - 1].object;
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function allow(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('UNREPRESENTABLE_RESEARCH_FIELDS');
  }
}
const ROOT = ['version', 'status', 'reason', 'execution_budget_cents', 'research_horizon_cents',
  'queries', 'evidence', 'opportunities', 'tool_requests', 'capabilities', 'operator_attention',
  'metrics', 'security', 'private_state'];
const OPPORTUNITY = ['opportunity_id', 'name', 'kind', 'classification', 'estimated_cost_cents',
  'cost_basis', 'budget_excess_cents', 'summary', 'human_minutes_daily', 'market', 'platform', 'fees',
  'account_required', 'evidence', 'risks', 'reason_surfaced', 'mini_test', 'first_question',
  'execution_authorized', 'score'];
const SECURITY = ['project_created', 'approval_created', 'external_action_executed',
  'money_spent', 'capability_granted', 'installation_performed'];

/**
 * Refuse information the legacy preview cannot represent BEFORE selecting its subset.
 * Presence is authoritative for refusal, not the marker's value (including null/false).
 * Known host-only bookkeeping/private fields are deliberately NOT forwarded or examined.
 * Consumed values still pass the existing quote/cost/authority validators at each entry.
 */
export function assertResearchProjectionBoundary(value: unknown): asserts value is Record<string, unknown> {
  if (!record(value)) throw new Error('INVALID_RESEARCH_BOUNDARY');
  if (Object.hasOwn(value, 'economic_guard') || Object.hasOwn(value, 'experimental_model_provider')) {
    throw new Error('EXPERIMENTAL_RESEARCH_PROJECTION_REFUSED');
  }
  allow(value, ROOT);
  if (!['PASS', 'BLOCKED', 'INSUFFICIENT_EVIDENCE'].includes(String(value.status)) ||
      !Array.isArray(value.evidence) || value.evidence.length > 10 ||
      !Array.isArray(value.opportunities) || value.opportunities.length > 3) {
    throw new Error('INVALID_RESEARCH_BOUNDARY');
  }
  if (Object.hasOwn(value, 'security')) {
    const security = value.security;
    if (!record(security) || Object.keys(security).length !== SECURITY.length ||
        SECURITY.some(key => !Object.hasOwn(security, key) || security[key] !== false)) {
      throw new Error('UNSAFE_RESEARCH_OUTPUT');
    }
  }
  for (const source of value.evidence) {
    if (!record(source)) throw new Error('INVALID_RESEARCH_BOUNDARY');
    allow(source, ['source_id', 'url', 'text', 'query_id', 'round']);
  }
  for (const item of value.opportunities) {
    if (!record(item) || !record(item.evidence)) throw new Error('INVALID_RESEARCH_BOUNDARY');
    allow(item, OPPORTUNITY);
    allow(item.evidence, ['source_id', 'url', 'quote']);
    if (Object.hasOwn(item, 'mini_test')) {
      if (!record(item.mini_test)) throw new Error('INVALID_RESEARCH_BOUNDARY');
      allow(item.mini_test, ['possible', 'estimated_cost_cents', 'description']);
    }
  }
}
