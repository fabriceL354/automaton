/** V12.7 preparation contracts. No executable capabilities or financial facts. */
import { canonicalHash, digest, exact, hex, time } from "./project-model.js";
import { integerCents, PROJECT_LIMITS } from "./asset-lifecycle.js";
import { publicHttpsUrl } from "../scout-web/network.js";
export const PREPARATION_LIMITS = Object.freeze({ ...PROJECT_LIMITS, REFERENCE_CAPITAL_CENTS: 10000, MAX_RECORDS: 256, MAX_BYTES: 512 * 1024 });
export const PREPARATION_EVENTS = ["OPPORTUNITY_READY_FOR_REVIEW", "APPROVAL_REQUIRED", "INSUFFICIENT_BUDGET", "SPENDING_CEILING_EXCEEDED", "MISSING_EVIDENCE", "READY_FOR_MANUAL_LAUNCH", "BLOCKED", "EXPERIMENT_PERIOD_ENDED", "ECONOMIC_RESULT_REVIEW_REQUIRED"] as const;
export type PreparationEventType = typeof PREPARATION_EVENTS[number];
export interface Proof { proof_id: string; file: string; sha256: string; purpose: "cost" | "market"; public_url: string | null }
export interface HumanAction { action_id: string; kind: "manual_payment" | "manual_publication" | "manual_work"; description: string; supplier: string | null; beneficiary: string | null; max_amount_cents: number; justification: string; risks: string[]; proof_ids: string[] }
export interface Dossier {
  opportunity_id: string; candidate_fingerprint: string; fictional: boolean; description: string; target_customers: string; offer: string;
  budget_cents: number; duration_days: number; review_expires_at: string; estimated_revenue_cents: number | null;
  commercial_uncertainties: string[]; operational_risks: string[]; success_conditions: string[]; stop_conditions: string[];
  proofs: Proof[]; human_actions: HumanAction[];
}
export interface PreparationInput { version: "12.7"; source: "research.json" | "opportunities.json"; dossiers: Dossier[] }
/** Reject rather than redact secrets; never reflect the offending value. Public
 * archives must be curated by the operator, not raw bank documents. */
export function rejectSensitive(value: string): void {
  if (/\b(?:cvv|cvc|iban|password|passwd|mot de passe|api[_ -]?key|access[_ -]?token|bank[_ -]?(?:login|account)|card[_ -]?(?:number|details)|num[eé]ro de carte)\b|\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b|\b(?:\d[ -]?){13,19}\b|Bearer\s+\S+|-----BEGIN .*PRIVATE KEY-----/i.test(value)) throw new Error("SENSITIVE_INPUT_REJECTED");
}
function text(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 500 || /[\x00-\x1f\x7f]/.test(v)) throw new Error("Invalid bounded preparation text");
  rejectSensitive(v); return v;
}
export function reference(v: unknown): string {
  if (typeof v !== "string" || !/^[a-z][a-z0-9-]{0,119}$/.test(v)) throw new Error("Exact preparation reference required"); return v;
}
function list(v: unknown, minimum = 1): string[] {
  if (!Array.isArray(v) || v.length < minimum || v.length > 5) throw new Error("Bounded preparation list required"); return v.map(text);
}
export function parseDossier(v: unknown): Dossier {
  const d = exact(v, ["opportunity_id", "candidate_fingerprint", "fictional", "description", "target_customers", "offer", "budget_cents", "duration_days", "review_expires_at", "estimated_revenue_cents", "commercial_uncertainties", "operational_risks", "success_conditions", "stop_conditions", "proofs", "human_actions"]);
  reference(d.opportunity_id); hex(d.candidate_fingerprint);
  if (typeof d.fictional !== "boolean") throw new Error("Explicit fictional flag required");
  integerCents(d.budget_cents);
  if ((d.budget_cents as number) > 1000) throw new Error("SPENDING_CEILING_EXCEEDED");
  if (!Number.isSafeInteger(d.duration_days) || (d.duration_days as number) < 1 || (d.duration_days as number) > 7) throw new Error("Duration must be 1..7 days");
  time(d.review_expires_at); if (d.estimated_revenue_cents !== null) integerCents(d.estimated_revenue_cents);
  for (const name of ["description", "target_customers", "offer"] as const) text(d[name]);
  for (const name of ["commercial_uncertainties", "operational_risks", "success_conditions", "stop_conditions"] as const) list(d[name]);
  if (!Array.isArray(d.proofs) || d.proofs.length > 5 || !Array.isArray(d.human_actions) || d.human_actions.length < 1 || d.human_actions.length > 5) throw new Error("Proof/action limit");
  const proofs = d.proofs.map(v => {
    const p = exact(v, ["proof_id", "file", "sha256", "purpose", "public_url"]);
    reference(p.proof_id); hex(p.sha256);
    if (typeof p.file !== "string" || !/^evidence\/[a-z][a-z0-9-]{0,79}\.txt$/.test(p.file) || !["cost", "market"].includes(p.purpose as string)) throw new Error("Curated local evidence required");
    if (p.public_url !== null) {
      const url = publicHttpsUrl(text(p.public_url));
      if (url.search || url.hash || url.username || url.password || url.toString() !== p.public_url) throw new Error("Credential-free canonical public URL required");
    }
    return p as unknown as Proof;
  });
  const actions = d.human_actions.map(v => {
    const a = exact(v, ["action_id", "kind", "description", "supplier", "beneficiary", "max_amount_cents", "justification", "risks", "proof_ids"]);
    reference(a.action_id);
    if (!["manual_payment", "manual_publication", "manual_work"].includes(a.kind as string)) throw new Error("AUTOMATIC_ACTION_FORBIDDEN");
    text(a.description); text(a.justification); list(a.risks);
    for (const field of ["supplier", "beneficiary"] as const) if (a[field] !== null) text(a[field]);
    if (/abonnements?|subscriptions?|(?:achat|achet\w*|buy|purchas\w*).*(?:cr[eé]dits?|credits?)|(?:ouvrir|cr[eé]er|open|create).*(?:compte|account)/i.test([a.description, a.supplier, a.justification].join(" "))) throw new Error("Credit/subscription/account actions forbidden");
    integerCents(a.max_amount_cents);
    if ((a.max_amount_cents as number) > (d.budget_cents as number) || a.kind !== "manual_payment" && a.max_amount_cents !== 0) throw new Error("SPENDING_CEILING_EXCEEDED");
    if (!Array.isArray(a.proof_ids) || a.proof_ids.length > 5 || new Set(a.proof_ids).size !== a.proof_ids.length || a.proof_ids.some(id => !proofs.some(p => p.proof_id === id))) throw new Error("Unbound action evidence");
    return a as unknown as HumanAction;
  });
  if (new Set(proofs.map(p => p.proof_id)).size !== proofs.length || new Set(actions.map(a => a.action_id)).size !== actions.length) throw new Error("Duplicate proof/action");
  if (integerCents(actions.reduce((s, a) => s + a.max_amount_cents, 0)) > (d.budget_cents as number)) throw new Error("SPENDING_CEILING_EXCEEDED");
  return d as unknown as Dossier;
}
export function parsePreparationInput(raw: string): PreparationInput {
  if (Buffer.byteLength(raw) > 128 * 1024) throw new Error("Preparation input limit");
  const d = exact(JSON.parse(raw), ["version", "source", "dossiers"]);
  if (d.version !== "12.7" || !["research.json", "opportunities.json"].includes(d.source as string) || !Array.isArray(d.dossiers) || !d.dossiers.length || d.dossiers.length > 3) throw new Error("Invalid preparation input");
  const dossiers = d.dossiers.map(parseDossier);
  if (new Set(dossiers.map(d => d.opportunity_id)).size !== dossiers.length) throw new Error("Duplicate candidate dossier");
  return { version: "12.7", source: d.source as PreparationInput["source"], dossiers };
}
export interface PreparationRequest extends HumanAction {
  request_id: string; project_id: string; dossier_hash: string; created_at: string; expires_at: string; fingerprint: string;
  status: "pending" | "approved" | "denied"; decided_at: string | null; human_reference: string | null;
  action_authorized: false; payment_proven: false;
}
export interface PreparedProject {
  project_id: string; dossier: Dossier; dossier_hash: string; candidate: import("./allocation-sources.js").AllocationCandidate;
  created_at: string; reserved_budget_cents: number; requests: PreparationRequest[];
  commercial_review: { reviewed_at: string; cost_proof_id: string; confirmed_quote_cents: number; scope_hash: string; human_reference: string } | null;
  declarations: { declaration_id: string; kind: "expense" | "revenue"; amount_cents: number; recorded_at: string; phase: "experiment" | "post_experiment"; proof_id: string | null; verification: "UNVERIFIED_HUMAN_DECLARATION" }[];
}
export function requestFingerprint(r: PreparationRequest): string {
  const { fingerprint: _f, status: _s, decided_at: _d, human_reference: _h, ...body } = r; return canonicalHash(body);
}
export function createPreparedProject(dossier: Dossier, candidate: PreparedProject["candidate"], at: string): PreparedProject {
  const project_id = `prepared-project-${canonicalHash([candidate.origin, candidate.title.normalize("NFKC").trim().toLowerCase()]).slice(0, 32)}`;
  const dossier_hash = canonicalHash(dossier);
  const requests = dossier.human_actions.map(action => {
    const request: PreparationRequest = { ...action, request_id: `prepared-request-${digest(`${project_id}:${dossier_hash}:${action.action_id}`).slice(0, 32)}`,
      project_id, dossier_hash, created_at: at, expires_at: dossier.review_expires_at, fingerprint: "", status: "pending", decided_at: null, human_reference: null,
      action_authorized: false, payment_proven: false };
    request.fingerprint = requestFingerprint(request); return request;
  });
  return { project_id, dossier, dossier_hash, candidate, created_at: at, reserved_budget_cents: dossier.budget_cents, requests, commercial_review: null, declarations: [] };
}
export function preparationBlockers(p: PreparedProject, now: string): string[] {
  return [ ...(p.dossier.fictional ? ["FICTIONAL_PROJECT"] : []), ...(now >= p.dossier.review_expires_at ? ["APPROVAL_EXPIRED"] : []),
    ...(p.candidate.cost_basis !== "SOURCE_ESTIMATE" || !p.dossier.proofs.some(e => e.purpose === "cost") || !p.dossier.proofs.some(e => e.purpose === "market") ? ["MISSING_EVIDENCE"] : []),
    ...(!p.commercial_review ? ["COMMERCIAL_REVIEW_REQUIRED"] : []), ...(p.requests.some(r => r.status !== "approved") ? ["APPROVAL_REQUIRED"] : []),
    ...(p.requests.some(r => r.kind === "manual_payment" && (!r.supplier || !r.beneficiary || !r.proof_ids.some(id => p.dossier.proofs.some(e => e.proof_id === id && e.purpose === "cost")))) ? ["PAYMENT_DETAILS_UNVERIFIED"] : []) ];
}
