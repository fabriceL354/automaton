/** Dry serialization audit: real request construction with a programmed in-memory transport, NO Ollama. */
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ECONOMIC_CASES } from './economics-corpus.js';
import { economicArm, economicScript } from './economics-probe.js';
import { localResearchModel } from '../../src/agent/research-controller.js';
export async function economicWireAudit() {
  const original = globalThis.fetch;
  const settings = { numCtx: 2048, numPredict: 256, timeoutMs: 105000 };
  const results = [];
  try {
    for (const fixture of ECONOMIC_CASES) for (const variant of ['A', 'B'] as const) {
      globalThis.fetch = async () => new Response(JSON.stringify({ done: true, done_reason: 'stop',
        message: { content: await economicScript(fixture).ask('economics', '', new AbortController().signal) } }));
      // 'true' enables wire observation ONLY; transport is the local stub above.
      const result = await economicArm(fixture, variant, localResearchModel('http://127.0.0.1:11434'), settings, true);
      results.push({ scenario: fixture.id, variant, source_count: result.supplied_source_count,
        evidence_characters: result.supplied_evidence_characters, input_characters: result.calls[0].input_chars,
        input_utf8_bytes: result.calls[0].input_utf8_bytes, serialized_request_bytes: result.calls[0].request_bytes,
        message_utf8_bytes: result.calls[0].message_utf8_bytes, conservative_context_bound: result.calls[0].context_bound });
    }
  } finally { globalThis.fetch = original; }
  return { measurement: 'EXACT_SERIALIZATION_WITH_STUB_TRANSPORT_NOT_QWEN', real_model_executed: false,
    inference_times_available: false, actual_tokens_available: false, results };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !/^--output=.+\.json$/.test(args[0])) throw new Error('Explicit output required');
  process.env.SCOUT_NUM_CTX = '2048'; process.env.SCOUT_NUM_PREDICT = '256'; process.env.SCOUT_TIMEOUT_MS = '105000';
  await writeFile(args[0].slice(9), JSON.stringify(await economicWireAudit(), null, 2) + '\n', { mode: 0o600 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { console.error('Serialization audit failed; no model data logged.'); process.exitCode = 1; });
