/** Numeric/enumerated diagnostics only. No raw envelope, prompt, response or exception text escapes. */
import { ECONOMIC_SYSTEM } from './economics.js';
import { RESEARCH_LIMITS } from '../../src/agent/research-model.js';
export type EconomicsMetrics = {
  input_chars: number; input_utf8_bytes: number; request_bytes: number | null; message_utf8_bytes: number | null;
  context_bound: number | null; response_bytes: number; output_content_bytes: number | null;
  duration_ms: number; headers_ms: number | null; body_ms: number | null;
  prompt_tokens: number | null; output_tokens: number | null; ollama_total_ns: number | null;
  load_ns: number | null; prompt_eval_ns: number | null; eval_ns: number | null;
  prompt_tokens_per_second: number | null; output_tokens_per_second: number | null;
  done_reason: 'STOP' | 'LENGTH' | 'OTHER' | null;
  diagnostic: string; transport_calls: number;
};
export function newMetrics(data: string): EconomicsMetrics {
  return { input_chars: data.length, input_utf8_bytes: Buffer.byteLength(data), request_bytes: null,
    message_utf8_bytes: null, context_bound: null, response_bytes: 0, output_content_bytes: null,
    duration_ms: 0, headers_ms: null, body_ms: null, prompt_tokens: null, output_tokens: null,
    ollama_total_ns: null, load_ns: null, prompt_eval_ns: null, eval_ns: null,
    prompt_tokens_per_second: null, output_tokens_per_second: null, done_reason: null,
    diagnostic: 'NOT_STARTED', transport_calls: 0 };
}
export const safeNumber = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
export function inspectEconomicEnvelope(value: unknown, m: EconomicsMetrics) {
  const x = value as Record<string, any> | null;
  if (!x || typeof x !== 'object' || Array.isArray(x)) { m.diagnostic = 'ENVELOPE_INVALID'; return; }
  m.prompt_tokens = safeNumber(x.prompt_eval_count); m.output_tokens = safeNumber(x.eval_count);
  m.ollama_total_ns = safeNumber(x.total_duration); m.load_ns = safeNumber(x.load_duration);
  m.prompt_eval_ns = safeNumber(x.prompt_eval_duration); m.eval_ns = safeNumber(x.eval_duration);
  m.prompt_tokens_per_second = m.prompt_tokens !== null && m.prompt_eval_ns ? m.prompt_tokens * 1e9 / m.prompt_eval_ns : null;
  m.output_tokens_per_second = m.output_tokens !== null && m.eval_ns ? m.output_tokens * 1e9 / m.eval_ns : null;
  m.done_reason = x.done_reason === 'stop' ? 'STOP' : x.done_reason === 'length' ? 'LENGTH' : x.done_reason == null ? null : 'OTHER';
  if (x.error) m.diagnostic = 'OLLAMA_ERROR';
  else if (x.done === false || x.done_reason === 'length') m.diagnostic = 'TRUNCATED_OR_TOKEN_LIMIT';
  else if (typeof x.message?.content !== 'string') m.diagnostic = 'ENVELOPE_INVALID';
  else { m.output_content_bytes = Buffer.byteLength(x.message.content); m.diagnostic = 'CONTENT_RECEIVED'; }
}
export function abortDiagnostic(parent: AbortSignal, transport?: AbortSignal | null) {
  if (parent.aborted) return 'PARENT_ABORTED';
  if (transport?.aborted) return transport.reason?.name === 'TimeoutError' ? 'CALL_TIMEOUT' : 'TRANSPORT_ABORT_UNCLASSIFIED';
  return 'TRANSPORT_ERROR';
}
let active = false;
/** Same compact system and conservative guard as I2 progressiveContext for BOTH variants. */
export async function withEconomicTransport<T>(m: EconomicsMetrics, parent: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (active) throw new Error('Sequential economics benchmark required');
  active = true;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.pathname !== '/api/chat' || url.search || url.username || url.password || m.transport_calls)
      throw new Error('Unexpected economics transport');
    const body = JSON.parse(String(init?.body));
    if (!Array.isArray(body.messages) || body.messages.length !== 2 || body.stream !== false || body.format !== 'json')
      throw new Error('Unexpected economics envelope');
    body.messages[0].content = ECONOMIC_SYSTEM;
    m.message_utf8_bytes = body.messages.reduce((n: number, v: { content: string }) => n + Buffer.byteLength(v.content), 0);
    m.context_bound = m.message_utf8_bytes! + 128 + body.options.num_predict;
    if (m.context_bound! > body.options.num_ctx) { m.diagnostic = 'CONTEXT_BUDGET_REFUSED'; throw new Error('Context budget refused'); }
    const changed = { ...init, body: JSON.stringify(body) };
    m.request_bytes = Buffer.byteLength(changed.body); m.transport_calls++;
    const started = performance.now();
    let headersAt = started;
    try {
      const response = await original(input, changed);
      headersAt = performance.now(); m.headers_ms = Math.round(headersAt - started);
      if (!response.ok) { m.diagnostic = 'HTTP_ERROR'; await response.body?.cancel(); return new Response(null, { status: response.status }); }
      if (!response.body) { m.diagnostic = 'EMPTY_ENVELOPE'; return response; }
      let chunks: Uint8Array[] = [];
      const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          m.response_bytes += chunk.length;
          if (m.response_bytes > RESEARCH_LIMITS.modelResponseBytes) {
            chunks = []; m.diagnostic = 'RESPONSE_BYTE_LIMIT'; throw new Error('Response byte limit');
          }
          chunks.push(chunk); controller.enqueue(chunk);
        },
        flush() {
          m.body_ms = Math.round(performance.now() - headersAt);
          try { inspectEconomicEnvelope(JSON.parse(Buffer.concat(chunks).toString('utf8')), m); }
          catch { m.diagnostic = 'ENVELOPE_JSON_INVALID'; }
          chunks = [];
        },
      }));
      // Catch transport aborts during body consumption as well as before headers.
      init?.signal?.addEventListener('abort', () => { m.diagnostic = abortDiagnostic(parent, init?.signal); }, { once: true });
      return new Response(stream, { status: response.status, headers: response.headers });
    } catch {
      if (!['CONTEXT_BUDGET_REFUSED', 'HTTP_ERROR', 'RESPONSE_BYTE_LIMIT'].includes(m.diagnostic)) m.diagnostic = abortDiagnostic(parent, init?.signal);
      throw new Error('Local economics transport unavailable');
    }
  };
  try { return await operation(); } finally { globalThis.fetch = original; active = false; }
}
