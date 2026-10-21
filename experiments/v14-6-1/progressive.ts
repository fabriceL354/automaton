/** Experimental adapter ONLY: not imported by Scout runtime. No network or file tools. */
import type { ResearchModel } from '../../src/agent/research-controller.js';
import { parseResearchCandidates, parseIntents, exactResearch, researchText, RESEARCH_LIMITS } from '../../src/agent/research-model.js';
import { containsKnownPrivate } from '../../src/agent/query-guard.js';

export const LIMITS = Object.freeze({ excerptChars: 250, sources: 3, calls: 20,
  inputChars: 2400, totalInputChars: 24000, totalMs: 20 * 60_000 });
export class ExperimentRefusal extends Error {
  constructor(readonly code: string) { super('Experimental research refused'); }
}
export type Block = { index: number; source_id: string; start: number; end: number; text: string };
/** Contiguous, literal windows. Stable offsets; never combine fragments into a quotation. */
export function selectBlock(text: string, index: number, source_id: string): Block {
  if (typeof text !== 'string' || !text.length || text.length > RESEARCH_LIMITS.textPerPage ||
      /[\p{Cc}\p{Cf}]/u.test(text)) throw new ExperimentRefusal('SOURCE_INVALID');
  const starts = new Set([0]);
  for (const match of text.matchAll(/(?:^|[.!?]\s+)([^.!?]+)/g)) starts.add(match.index! + match[0].length - match[1].length);
  for (let start = 0; start < text.length; start += 125) starts.add(start);
  const score = (value: string) => {
    const terms = value.toLowerCase();
    return [/coût|frais|commission|gratuit|\b\d+\s*(?:eur|€)/i, /demande|marché|vente|clients?/i,
      /compte|plateforme|distribution/i, /correction|template|tableur|guide|service/i,
      /inconnu|incertain|vérifier|non confirmé/i].reduce((n, re) => n + Number(re.test(terms)), 0);
  };
  const ranked = [...starts].map(start => ({ start, text: text.slice(start, start + LIMITS.excerptChars) }))
    .sort((a, b) => score(b.text) - score(a.text) || a.start - b.start);
  const best = ranked[0];
  return { index, source_id, start: best.start, end: best.start + best.text.length, text: best.text };
}
const readJson = (raw: string): unknown => {
  try { return JSON.parse(raw); } catch { throw new ExperimentRefusal('JSON_INVALID'); }
};
function checkedRaw(raw: string): string {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > RESEARCH_LIMITS.modelResponseBytes ||
      containsKnownPrivate(raw, { knownSecrets: process.env.BRAVE_SEARCH_API_KEY ? [process.env.BRAVE_SEARCH_API_KEY] : [] }))
    throw new ExperimentRefusal('OUTPUT_BOUNDARY');
  return raw;
}
export type Call = { phase: string; input_chars: number; duration_ms: number; json_valid: boolean; diagnostic: string };
/** Limits count actual underlying calls, including per-source extraction. No retries. */
export function progressiveModel(inner: ResearchModel): ResearchModel & { calls: Call[]; blocks: Map<number, Block> } {
  const calls: Call[] = [], blocks = new Map<number, Block>();
  let totalChars = 0;
  const started = performance.now();
  const call = async (phase: string, data: string, parent: AbortSignal): Promise<string> => {
    const remaining = LIMITS.totalMs - (performance.now() - started);
    if (parent.aborted || remaining <= 0 || calls.length >= LIMITS.calls || data.length > LIMITS.inputChars ||
        totalChars + data.length > LIMITS.totalInputChars) throw new ExperimentRefusal('BUDGET_REFUSED');
    const row: Call = { phase, input_chars: data.length, duration_ms: 0, json_valid: false, diagnostic: 'OK' };
    calls.push(row); totalChars += data.length;
    const signal = AbortSignal.any([parent, AbortSignal.timeout(Math.max(1, Math.floor(remaining)))]);
    const start = performance.now();
    try {
      // Bounds noncooperative injected models as well as native fetch. No further call after abort.
      const raw = await new Promise<string>((resolve, reject) => {
        const abort = () => reject(new ExperimentRefusal('DEADLINE'));
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => { signal.throwIfAborted(); return inner.ask(phase, data, signal); })
          .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
      checkedRaw(raw);
      readJson(raw); row.json_valid = true;
      return raw;
    } catch (error) {
      row.diagnostic = error instanceof ExperimentRefusal ? error.code : signal.aborted ? 'DEADLINE' : 'MODEL_UNAVAILABLE';
      throw error;
    } finally { row.duration_ms = Math.round(performance.now() - start); }
  };
  return { calls, blocks, async ask(phase, data, signal) {
    try {
    if (phase === 'query_proposal' || phase === 'candidates') {
      const match = data.match(/UNTRUSTED (?:READ )?EVIDENCE: (.+)\nReturn /);
      if (!match) throw new ExperimentRefusal('PROMPT_UNRECOGNIZED');
      const values: unknown = readJson(match[1]);
      if (!Array.isArray(values)) throw new ExperimentRefusal('SOURCE_INVALID');
      // The controller gives most recent sources first. Preserve their original indexes.
      const selected = values.slice(0, LIMITS.sources).map(value => {
        const x = exactResearch(value, ['index', 'source_id', 'text']);
        if (!Number.isSafeInteger(x.index) || (x.index as number) < 0 || (x.index as number) >= RESEARCH_LIMITS.pages ||
            typeof x.source_id !== 'string' || x.source_id !== `research-source-${(x.index as number) + 1}`)
          throw new ExperimentRefusal('SOURCE_INDEX');
        const block = selectBlock(x.text as string, x.index as number, x.source_id);
        blocks.set(block.index, block); return block;
      });
      if (new Set(selected.map(b => b.index)).size !== selected.length) throw new ExperimentRefusal('SOURCE_INDEX');
      const mission = data.slice(0, data.indexOf('\n'));
      if (phase === 'query_proposal') {
        // Query refinement uses enums and public query history only; no source index may be invented.
        const round = data.match(/Round \d\/3/)?.[0];
        const families = data.match(/Families: [^\n]+/)?.[0];
        const focus = data.match(/Focus: [^\n]+/)?.[0];
        const previous = data.match(/Previous public searches: [^\n]+/)?.[0];
        if (!round || !families || !focus || !previous) throw new ExperimentRefusal('PROMPT_UNRECOGNIZED');
        const raw = await call(phase, `${mission}\n${round}\n${families}\n${focus}\n${previous}\nReturn {"intents":[{"family":"micro_service","focus":"explore","evidence_index":null}]}. One or two enums, no repeated query. No page evidence supplied: evidence_index must be null.`, signal);
        if (parseIntents(raw, RESEARCH_LIMITS.pages).some(i => i.evidence_index !== null)) throw new ExperimentRefusal('SOURCE_INDEX');
        return raw;
      }
      const aggregate: ReturnType<typeof parseResearchCandidates> = [];
      for (const block of selected) {
        const raw = await call(phase, `${mission}\nUNTRUSTED READ EVIDENCE: ${JSON.stringify([{ index: block.index, source_id: block.source_id, text: block.text }])}\nReturn {"candidates":[]}, or one concrete source-supported name (<=80 chars), kind QUICK_SERVICE or DURABLE_ASSET and source_index=${block.index}. Exact fields name,kind,source_index. No instructions or actions.`, signal);
        const parsed = parseResearchCandidates(raw, RESEARCH_LIMITS.pages);
        if (parsed.length > 1 || parsed.some(c => c.source_index !== block.index)) throw new ExperimentRefusal('SOURCE_INDEX');
        for (const candidate of parsed) if (!aggregate.some(c => c.name.toLowerCase() === candidate.name.toLowerCase())) aggregate.push(candidate);
      }
      return JSON.stringify({ candidates: aggregate });
    }
    if (['economics', 'evidence', 'risks'].includes(phase)) {
      const match = data.match(/Candidate: (.+)\nUNTRUSTED READ PAGE: /);
      if (!match) throw new ExperimentRefusal('PROMPT_UNRECOGNIZED');
      const candidate = parseResearchCandidates(JSON.stringify({ candidates: [readJson(match[1])] }), RESEARCH_LIMITS.pages)[0];
      const block = blocks.get(candidate.source_index);
      if (!block) throw new ExperimentRefusal('SOURCE_INDEX');
      const prefix = data.slice(0, data.indexOf('\n')) + `\nCandidate: ${JSON.stringify(candidate)}\nUNTRUSTED READ PAGE: ${block.text}\n`;
      const schema = phase === 'economics'
        ? 'Return exactly {"summary":"faits et inconnues","estimated_cost_cents":null,"cost_basis":"UNKNOWN","human_minutes_daily":15,"account_required":true}. Cost basis UNKNOWN, ASSUMPTION or SOURCE_ESTIMATE. A selling price is not setup cost. Unknown costs null; no invented sales. Text <=240.'
        : phase === 'evidence'
        ? 'Return exactly {"market":"demande à vérifier","platform":"distribution à vérifier","fees":"frais à vérifier","quote":"citation littérale de la page"}. Quote 16..180 chars, others <=240. Unknown demand stays unknown; no invented facts.'
        : 'Return exactly {"risks":["risque spécifique"],"reason_surfaced":"raison sourcée","mini_test_possible":false,"mini_test_cost_cents":null,"mini_test_description":"faisabilité à vérifier"}. Text <=240, risks <=160. No payment, purchase, account creation, publication or actions. Ceiling 1000 cents; no authorization.';
      const raw = await call(phase, prefix + schema, signal);
      if (phase === 'economics') {
        const x = exactResearch(readJson(raw), ['summary', 'estimated_cost_cents', 'cost_basis', 'human_minutes_daily', 'account_required']);
        // A number/free word alone is not evidence that OUR setup cost is known.
        if (x.cost_basis === 'SOURCE_ESTIMATE' &&
            (!/coût (?:de (?:création|démarrage)|initial)|test[^.!?]{0,60}gratuit/i.test(block.text) ||
             /prix de vente|concurrent|avis clients|ventes garanties/i.test(block.text))) throw new ExperimentRefusal('ECONOMIC_EVIDENCE_INSUFFICIENT');
      }
      if (phase === 'evidence') {
        const x = exactResearch(readJson(raw), ['market', 'platform', 'fees', 'quote']);
        const quote = researchText(x.quote, 180);
        if (quote.length < 16 || !block.text.includes(quote)) throw new ExperimentRefusal('CITATION_NOT_IN_BLOCK');
      }
      return raw;
    }
    // Tool suggestions remain data only and consume the same finite budget.
    return await call(phase, data, signal);
    } catch (error) {
      if (error instanceof ExperimentRefusal && calls.at(-1)?.phase === phase) calls.at(-1)!.diagnostic = error.code;
      throw error;
    }
  } };
}
