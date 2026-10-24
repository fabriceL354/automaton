/** One frozen source, one candidates call per arm. No query rounds, live web or Scout execution. */
import { createHash } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { localResearchModel, type ResearchModel } from '../../src/agent/research-controller.js';
import { DEFAULT_SCOUT_MODEL, loadLocalScoutSettings } from '../../src/agent/local-runner.js';
import { PUBLIC_RESEARCH_MISSION, parseResearchCandidates } from '../../src/agent/research-model.js';
import { observeModel, withOllamaMetrics, type Diagnostic } from './diagnostics.js';
import { progressiveModel, type CandidatePrompt } from './progressive.js';
import { SCENARIOS } from './corpus.js';

// Same first source as the short full B run: most recent global index 1, never local index 0.
export const PROBE_SOURCE = Object.freeze({ index: 1, source_id: 'research-source-2', text: SCENARIOS[0].texts[1] });
export async function probeArm(revision: CandidatePrompt, model: ResearchModel, real = false) {
  const calls: Diagnostic[] = [];
  const adapter = progressiveModel(observeModel(model, calls, true), { candidatePrompt: revision });
  let candidate_count: number | null = null;
  const operation = async () => {
    try {
      const raw = await adapter.ask('candidates', `PUBLIC MISSION: ${PUBLIC_RESEARCH_MISSION}\nUNTRUSTED READ EVIDENCE: ${JSON.stringify([PROBE_SOURCE])}\nReturn exact candidates.`, new AbortController().signal);
      candidate_count = parseResearchCandidates(raw, 10).length;
      return 'EXTRACTION_ACCEPTED' as const;
    } catch { return 'EXTRACTION_REJECTED' as const; }
  };
  const status = real ? await withOllamaMetrics(calls, operation, { progressiveContext: true }) : await operation();
  return { candidate_prompt: revision, status, candidate_count, calls, model_calls: calls.length,
    total_ms: calls.reduce((n, row) => n + row.duration_ms, 0),
    progressive_refusals: adapter.calls.filter(row => row.diagnostic !== 'OK'),
    economic_validation: 'NOT_PERFORMED', execution_authorized: false };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !/^(?:--ollama|--repetitions=[1-3]|--output=.+\.json)$/.test(arg))) throw new Error('Unsupported argument');
  const output = args.find(arg => arg.startsWith('--output='))?.slice(9);
  if (!output) throw new Error('Explicit output required');
  const real = args.includes('--ollama');
  const repetitions = Number(args.find(arg => arg.startsWith('--repetitions='))?.split('=')[1] ?? 1);
  const settings = loadLocalScoutSettings();
  const model = real ? localResearchModel('http://127.0.0.1:11434', DEFAULT_SCOUT_MODEL) :
    { async ask() { return '{"candidates":[{"name":"Template tableur","kind":"DURABLE_ASSET","source_index":1}]}'; } };
  const report = { experiment: '14.6.1-ITERATION-2-CANDIDATES-ONLY',
    measurement: real ? 'REAL_LOCAL_OLLAMA_SYNTHETIC_CORPUS' : 'SCRIPTED_TEST_NOT_MODEL_PERFORMANCE',
    real_model_requested: real, model: real ? DEFAULT_SCOUT_MODEL : null, settings,
    source_sha256: createHash('sha256').update(JSON.stringify(PROBE_SOURCE)).digest('hex'),
    synthetic_sources: true, live_web: false, repetitions, warmup_excluded: false,
    order: 'original-explicit then explicit-original on alternating repetitions',
    results: [] as (Awaited<ReturnType<typeof probeArm>> & { repetition: number })[] };
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const revision of (repetition % 2 ? ['original', 'explicit'] : ['explicit', 'original']) as CandidatePrompt[]) {
      const result = await probeArm(revision, model, real);
      report.results.push({ repetition, ...result });
      await writeFile(output + '.pending', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
      await rename(output + '.pending', output);
      console.log(`candidates ${revision} repetition=${repetition} ${result.status} calls=${result.model_calls} ms=${result.total_ms}`);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { console.error('Candidates probe failed; no model data logged.'); process.exitCode = 1; });
