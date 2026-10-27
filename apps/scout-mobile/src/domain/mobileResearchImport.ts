import {
  quotedCostMatches
} from '../../../../src/agent/research-evidence-policy';

export type ImportedCard = {
  name: string;
  kind: 'QUICK_SERVICE' | 'DURABLE_ASSET';
  cost_cents: number | null;
  cost_basis: 'UNKNOWN' | 'ASSUMPTION' | 'SOURCE_ESTIMATE';
  source_url: string;
  source_quote: string;
  source_status: 'RECORDED_QUOTE_MATCH';
  execution_authorized: false;
};

export type ImportedPreview = {
  status: 'PASS' | 'BLOCKED' | 'INSUFFICIENT_EVIDENCE';
  cards: ImportedCard[];
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[]
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    keys.every(key => expected.includes(key));
}

/**
 * Import non authentifie, lecture seule.
 * Aucune requete reseau, aucune execution.
 */
export function parseMobileResearchImport(
  raw: string
): ImportedPreview {
  if (!raw.trim() || raw.length > 12000) {
    throw new Error('INVALID_IMPORT_SIZE');
  }

  const data: unknown = JSON.parse(raw);

  if (!record(data) || !exactKeys(data, ['status', 'cards'])) {
    throw new Error('INVALID_IMPORT');
  }

  const status = data.status;
  if (
    status !== 'PASS' &&
    status !== 'BLOCKED' &&
    status !== 'INSUFFICIENT_EVIDENCE'
  ) {
    throw new Error('INVALID_STATUS');
  }

  if (!Array.isArray(data.cards) || data.cards.length > 3) {
    throw new Error('INVALID_CARDS');
  }

  if (status !== 'PASS' && data.cards.length !== 0) {
    throw new Error('INVALID_BLOCKED_RESULT');
  }

  const expected = [
    'name', 'kind', 'cost_cents', 'cost_basis',
    'source_url', 'source_quote', 'source_status',
    'execution_authorized'
  ];

  const cards: ImportedCard[] = [];

  for (const value of data.cards) {
    if (!record(value) || !exactKeys(value, expected)) {
      throw new Error('INVALID_CARD');
    }

    const name = value.name;
    const kind = value.kind;
    const cost = value.cost_cents;
    const basis = value.cost_basis;
    const url = value.source_url;
    const quote = value.source_quote;

    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 80 ||
      (kind !== 'QUICK_SERVICE' && kind !== 'DURABLE_ASSET')
    ) {
      throw new Error('INVALID_NAME_OR_KIND');
    }

    if (
      cost !== null &&
      (typeof cost !== 'number' ||
        !Number.isSafeInteger(cost) ||
        cost < 0 || cost > 10000)
    ) {
      throw new Error('INVALID_COST');
    }

    if (
      basis !== 'UNKNOWN' &&
      basis !== 'ASSUMPTION' &&
      basis !== 'SOURCE_ESTIMATE'
    ) {
      throw new Error('INVALID_BASIS');
    }

    if ((cost === null) !== (basis === 'UNKNOWN')) {
      throw new Error('INCONSISTENT_COST');
    }

    if (
      typeof url !== 'string' ||
      !url.startsWith('https://') ||
      url.length > 500 ||
      /\s/.test(url) ||
      typeof quote !== 'string' ||
      quote.length < 16 ||
      quote.length > 180
    ) {
      throw new Error('INVALID_SOURCE');
    }

    if (
      value.source_status !== 'RECORDED_QUOTE_MATCH' ||
      value.execution_authorized !== false
    ) {
      throw new Error('INVALID_AUTHORITY');
    }

    if (
      basis === 'SOURCE_ESTIMATE' &&
      (cost === null || !quotedCostMatches(quote, cost))
    ) {
      throw new Error('COST_NOT_SUPPORTED');
    }

    cards.push({
      name,
      kind,
      cost_cents: cost,
      cost_basis: basis,
      source_url: url,
      source_quote: quote,
      source_status: 'RECORDED_QUOTE_MATCH',
      execution_authorized: false
    });
  }

  return { status, cards };
}
