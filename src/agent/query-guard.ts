/** Deterministic data-loss barrier. No inference, I/O or logging. */
export const MAX_QUERY_LENGTH = 300;
export const QUERY_PROVENANCE = Object.freeze(["INITIAL_PUBLIC_MISSION", "MODEL_REFINEMENT", "EVIDENCE_DERIVED"] as const);
export type QueryProvenance = typeof QUERY_PROVENANCE[number];
export interface PrivateQueryContext {
  knownSecrets?: readonly string[];
  privateIdentifiers?: readonly string[];
  privateSourceCopies?: readonly string[];
}
export type GuardDecision = { decision: "ACCEPT"; query: string } | { decision: "REJECT"; reason: string };

export function containsKnownPrivate(value: string, context: PrivateQueryContext = {}): boolean {
  const candidates = [value.normalize("NFKC").replace(/[\p{Cf}]/gu, "").toLowerCase()];
  // Decode bounded URL layers too: a credential in a result URL must never
  // become a GET to another site, even if the provider percent-encodes it.
  for (let layer = 0; layer < 5; layer++) {
    try {
      const decoded = decodeURIComponent(candidates.at(-1)!);
      if (decoded === candidates.at(-1)) break;
      candidates.push(decoded.normalize("NFKC").replace(/[\p{Cf}]/gu, "").toLowerCase());
    } catch { break; }
  }
  return [...context.knownSecrets ?? [], ...context.privateIdentifiers ?? [], ...context.privateSourceCopies ?? []]
    .filter(x => x.trim()).some(secret => [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("hex")].some(form => candidates.some(normalized => normalized.includes(form.normalize("NFKC").toLowerCase()))));
}

export function guardQuery(value: unknown, provenance: unknown, context: PrivateQueryContext = {}): GuardDecision {
  const reject = (reason: string): GuardDecision => ({ decision: "REJECT", reason });
  if (!QUERY_PROVENANCE.includes(provenance as QueryProvenance)) return reject("INVALID_PROVENANCE");
  if (typeof value !== "string" || !value.trim()) return reject("EMPTY_QUERY");
  if (value.length > MAX_QUERY_LENGTH) return reject("QUERY_TOO_LONG");
  // Reject controls, invisible formatting and encoded payloads before normalization.
  if (/[\p{Cc}\p{Cf}]/u.test(value) || /%[0-9a-f]{2}|&#|\\[ux][0-9a-f]/i.test(value)) return reject("CONTROL_OR_ENCODED_PAYLOAD");
  const query = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (query.length > MAX_QUERY_LENGTH) return reject("QUERY_TOO_LONG");
  if (containsKnownPrivate(query, context)) return reject("PRIVATE_DATA");
  if (/(?:https?|ftp|file|data):|www\.|\b[\w-]+\.(?:com|net|org|io|fr)\b|[<>={}\\]|(?:^|\s)[/~]|[a-z]:[\\/]|\.\.[/\\]/i.test(query)) return reject("URL_PATH_OR_PAYLOAD");
  if (/localhost|\.automaton|\b(?:home|etc|workspace|economic-ledger|approvals?|project-private|monitoring-private)\b/i.test(query)) return reject("PRIVATE_LOCATION");
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:[a-f0-9]{0,4}:){2,}|\b0x[a-f0-9]{6,}\b|\b\d{9,}\b/i.test(query)) return reject("IP_OR_LONG_NUMBER");
  if (/\b(?:api[ _-]?key|token|bearer|cookie|credential|password|passwd|mot de passe|secret|cvv|cvc|carte bancaire|credit card|wallet|seed phrase|private key)\b|\b(?:sk|pk|ghp|gho|AKIA)[_-]?[a-z0-9]{8,}|[a-z0-9_+/-]{24,}|\b\d(?:[ -]?\d){12,18}\b|\b\S+@\S+\b|\b(?:login|username|user)\s*[:=]/i.test(query)) return reject("SENSITIVE_CONTENT");
  if (/ignore.*(?:instruction|previous)|system prompt|send.*(?:file|data|secret)|exfiltrat|curl|web_search|read_file|write_file|execute|checkout/i.test(query)) return reject("UNTRUSTED_INSTRUCTION");
  return { decision: "ACCEPT", query };
}
