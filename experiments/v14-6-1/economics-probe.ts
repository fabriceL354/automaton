/** Isolated economics, one call per arm, synthetic fixtures only; no search, worker or coordinator. */
import { createHash } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { localResearchModel, type ResearchModel } from '../../src/agent/research-controller.js';
import { DEFAULT_SCOUT_MODEL, loadLocalScoutSettings } from '../../src/agent/local-runner.js';
import { ECONOMIC_CASES, type EconomicCase } from './economics-corpus.js';
import { baselineEconomics, optimizedEconomics, parseEconomics, guardEconomics, scoreEconomics,
  assertPublic, ECONOMIC_SYSTEM, type Economics } from './economics.js';
import { newMetrics, withEconomicTransport } from './economics-metrics.js';
import { selectBlock, ExperimentRefusal, LIMITS } from './progressive.js';
export type EconomicSettings = { numCtx: number; numPredict: number; timeoutMs: number };
export async function economicArm(fixture: EconomicCase, variant: 'A' | 'B', model: ResearchModel,
  settings: EconomicSettings, real = false, parent = new AbortController().signal) {
  // Both arms receive the same fixture object. B may preserve additional evidence A drops.
  const optimized = variant === 'B' ? optimizedEconomics(fixture) : null;
  const data = variant === 'A' ? baselineEconomics(fixture) : optimized!.data;
  assertPublic(data);
  const m = newMetrics(data);
  m.message_utf8_bytes = Buffer.byteLength(data) + Buffer.byteLength(ECONOMIC_SYSTEM);
  m.context_bound = m.message_utf8_bytes + 128 + Math.min(256, settings.numPredict);
  const source = fixture.sources.find(s => s.index === fixture.candidate.source_index)!;
  const passages = variant === 'A' ? [selectBlock(source.text, source.index, source.source_id)] : optimized!.passages;
  let parsed: Economics | null = null, accepted: Economics | null = null, refusal: string | null = null;
  let model_calls = 0, json_valid = false, economics_shape_valid = false;
  const began = performance.now();
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  const signal = AbortSignal.any([parent, timeout]);
  const operation = async () => {
    try {
      if (parent.aborted) throw new ExperimentRefusal('PARENT_ABORTED');
      if (data.length > LIMITS.inputChars || m.context_bound! > settings.numCtx) throw new ExperimentRefusal('CONTEXT_BUDGET_REFUSED');
      model_calls++;
      m.diagnostic = 'MODEL_PENDING';
      const raw = await new Promise<string>((resolve, reject) => {
        const abort = () => reject(new ExperimentRefusal(parent.aborted ? 'PARENT_ABORTED' : 'CALL_TIMEOUT'));
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => { signal.throwIfAborted(); return model.ask('economics', data, signal); })
          .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
      if (m.diagnostic !== 'CONTENT_RECEIVED' && real) throw new ExperimentRefusal(m.diagnostic);
      try { JSON.parse(raw); json_valid = true; } catch { /* parseEconomics supplies safe diagnostic */ }
      parsed = parseEconomics(raw); economics_shape_valid = true;
      if (variant === 'B') guardEconomics(parsed, fixture);
      accepted = parsed; m.diagnostic = 'ECONOMICS_CONTRACT_ACCEPTED';
    } catch (e) {
      refusal = parent.aborted ? 'PARENT_ABORTED' : timeout.aborted ? 'CALL_TIMEOUT' :
        e instanceof ExperimentRefusal ? e.code : m.diagnostic === 'MODEL_PENDING' ? 'MODEL_OR_TRANSPORT_ERROR' : m.diagnostic;
      m.diagnostic = refusal;
    }
  };
  if (real) await withEconomicTransport(m, parent, operation); else await operation();
  m.duration_ms = Math.round(performance.now() - began);
  return { scenario: fixture.id, variant, status: accepted ? 'ECONOMICS_CONTRACT_ACCEPTED' : 'REFUSED', refusal,
    model_calls, json_valid, economics_shape_valid, economics_contracts_accepted: Number(!!accepted),
    quality: scoreEconomics(accepted, fixture, refusal),
    model_quality_before_guard: parsed ? scoreEconomics(parsed, fixture, null) : null,
    supplied_source_count: new Set(passages.map(p => p.index)).size, supplied_passage_count: passages.length,
    omitted_source_count: fixture.sources.length - new Set(passages.map(p => p.index)).size,
    exact_duplicate_passages_removed: optimized?.duplicates ?? 0,
    literal_passages_verified: passages.every(p => fixture.sources.some(s => s.index === p.index && s.source_id === p.source_id && s.text.slice(p.start, p.end) === p.text)),
    source_characters: fixture.sources.reduce((n, s) => n + s.text.length, 0),
    supplied_evidence_characters: passages.reduce((n, p) => n + p.text.length, 0),
    // Legacy schema cannot encode UNKNOWN supervision/account. Values remain conservative estimates.
    human_minutes_are_estimates_if_unsourced: true, unknown_account_assumed_required: true,
    scout_final_contracts_accepted: 0, verified_live_citations: 0, economic_profitability_demonstrated: false,
    execution_authorized: false, coordinator_model_calls: 0, calls: [m] };
}
/** Same programmed response for A and B. Explicit adversarial cost fault is a unit fixture, not Qwen. */
export function economicScript(fixture: EconomicCase, faults = false): ResearchModel {
  return { async ask() {
    const o = fixture.oracle;
    const summary = fixture.id === 'contradictory' ? 'Coûts contradictoires; total inconnu. Droits à vérifier, aucune vente observée.' :
      fixture.id === 'documented' ? 'Coût pilote de 8 EUR, prix hypothétique de 5 EUR. Trois intentions ne prouvent aucune vente ni rentabilité.' :
      fixture.id === 'refusal' ? 'Refus : droits non vérifiés et instructions dangereuses; coûts inconnus, aucune preuve de vente.' :
      'Coûts inconnus; demande et frais à vérifier. Prix et promesses ne prouvent aucune vente.';
    return JSON.stringify({ summary, estimated_cost_cents: faults && fixture.id === 'misleading' ? 500 : o.cost,
      cost_basis: faults && fixture.id === 'misleading' || o.cost !== null ? 'SOURCE_ESTIMATE' : 'UNKNOWN',
      human_minutes_daily: o.minutes ?? 15, account_required: o.account ?? true });
  } };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => !/^(?:--ollama|--scripted-faults|--scenario=(?:documented|unknown-costs|misleading|refusal|contradictory|all)|--repetitions=[1-3]|--output=.+\.json)$/.test(a)) ||
      args.filter(a => a.startsWith('--output=')).length !== 1 || new Set(args.map(a => a.split('=')[0])).size !== args.length)
    throw new Error('Unsupported arguments');
  const real = args.includes('--ollama'), faults = args.includes('--scripted-faults');
  if (real && faults) throw new Error('Programmed fault forbidden with real model');
  const selected = args.find(a => a.startsWith('--scenario='))?.slice(11) ?? 'documented';
  const scenarios = ECONOMIC_CASES.filter(s => selected === 'all' || selected === s.id);
  const repetitions = Number(args.find(a => a.startsWith('--repetitions='))?.slice(14) ?? 1);
  const output = args.find(a => a.startsWith('--output='))?.slice(9);
  if (!output || !scenarios.length) throw new Error('Explicit output required');
  // Pin Chromebook protocol rather than inheriting the runtime's 300s default or increasing it.
  process.env.SCOUT_NUM_CTX ??= '2048'; process.env.SCOUT_NUM_PREDICT ??= '256'; process.env.SCOUT_TIMEOUT_MS ??= '105000';
  const settings = loadLocalScoutSettings();
  if (settings.numCtx !== 2048 || settings.numPredict !== 256 || settings.timeoutMs !== 105000)
    throw new Error('Use the fixed Chromebook protocol: 2048 / 256 / 105000');
  const plannedCalls = scenarios.length * repetitions * 2;
  const plannedInputChars = repetitions * scenarios.reduce((n, s) => n + baselineEconomics(s).length + optimizedEconomics(s).data.length, 0);
  if (plannedCalls > LIMITS.calls || plannedInputChars > LIMITS.totalInputChars)
    throw new Error('Existing experiment call or cumulative input budget exceeded; split independent scenarios');
  const runSignal = AbortSignal.timeout(LIMITS.totalMs);
  const report = { experiment: '14.6.1-ITERATION-3-ECONOMICS-ISOLATED-NOT-INTEGRATED',
    parent_commit: '09d2590e670533226bf95a162901e032546b940f', production_commit: '34fdac2cbdf8d582c5e3563538d3adbd246d2d0c',
    measurement: real ? 'REAL_LOCAL_OLLAMA_SYNTHETIC_CORPUS' : 'SCRIPTED_TEST_NOT_QWEN_OR_ECONOMIC_VALIDATION',
    model: real ? DEFAULT_SCOUT_MODEL : null, settings, temperature: 0, format: 'json', stream: false,
    system_identical_AB: true, source_fixture_identical_AB: true, oracle_identical_AB: true,
    corpus_sha256: createHash('sha256').update(JSON.stringify(ECONOMIC_CASES)).digest('hex'),
    selected, repetitions, programmed_adversarial_fault: faults, max_model_calls: plannedCalls,
    planned_input_characters: plannedInputChars,
    run_limits: { model_calls: LIMITS.calls, total_input_characters: LIMITS.totalInputChars, duration_ms: LIMITS.totalMs },
    order: 'AB then BA on alternate repetitions; no warmup excluded',
    live_web: false, synthetic_sources: true, hardware_validation_complete: false,
    general_economic_quality_validated: false, autonomous_use_authorized: false,
    results: [] as (Awaited<ReturnType<typeof economicArm>> & { repetition: number })[] };
  for (let repetition = 1; repetition <= repetitions; repetition++) for (const fixture of scenarios)
    for (const variant of (repetition % 2 ? ['A', 'B'] : ['B', 'A']) as ('A' | 'B')[]) {
      const model = real ? localResearchModel('http://127.0.0.1:11434', DEFAULT_SCOUT_MODEL) : economicScript(fixture, faults);
      const result = await economicArm(fixture, variant, model, settings, real, runSignal);
      report.results.push({ repetition, ...result });
      await writeFile(output + '.pending', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
      await rename(output + '.pending', output);
      console.log(`economics ${fixture.id} ${variant} ${result.status} calls=${result.model_calls} ms=${result.calls[0].duration_ms}`);
      // Do not cascade calls after a deadline/transport/memory-like failure. Resume only manually.
      if (result.refusal && /TIMEOUT|ABORT|TRANSPORT|ENVELOPE|BYTE_LIMIT|HTTP_ERROR|OLLAMA_ERROR/.test(result.refusal)) return;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { console.error('Economics probe failed; no prompts, responses or error bodies logged.'); process.exitCode = 1; });
