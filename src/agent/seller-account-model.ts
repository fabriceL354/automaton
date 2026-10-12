/** Local human attestation only. Opaque runtime IDs; no account login data. */
import { canonicalHash, exact, hex, same, time, uuid } from "./project-model.js";
import { reference, type PreparedProject } from "./pilot-preparation-model.js";
export const ACCOUNT_LIMITS = Object.freeze({ events: 64, declarations: 8, days: 7 });
export const ACCOUNT_PLATFORMS = ["etsy", "payhip", "itch-io"] as const;
export type AccountPlatform = typeof ACCOUNT_PLATFORMS[number];
export function accountPlatform(v: unknown): AccountPlatform {
  if (!ACCOUNT_PLATFORMS.includes(v as AccountPlatform)) throw new Error("ACCOUNT_PLATFORM_UNSUPPORTED"); return v as AccountPlatform;
}
export function sourcePlatform(v: unknown): AccountPlatform {
  if (typeof v !== "string") throw new Error("ACCOUNT_PLATFORM_UNBOUND");
  return accountPlatform(v.normalize("NFKC").trim().toLowerCase() === "itch.io" ? "itch-io" : v.normalize("NFKC").trim().toLowerCase());
}
export interface AccountScope {
  operator_id: string; account_id: string; platform: AccountPlatform; source_platform: string;
  opportunity_id: string; candidate_fingerprint: string; project_id: string; dossier_hash: string;
  input_hash: string; source_hash: string; request_id: string; created_at: string; expires_at: string;
  purpose: "EXISTING_ACCOUNT_PREPARATION_ONLY"; ownership_proof: "UNVERIFIED_LOCAL_HUMAN_ATTESTATION";
}
export interface AccountEvent {
  sequence: number; at: string; kind: "declare" | "validate" | "deny" | "revoke" | "admit";
  scope: AccountScope; fingerprint: string; human_reference: string; previous_hash: string | null; hash: string;
  action_authorized: false; money_moved: false;
}
export interface AccountHistory { version: "14.3"; operator_id: string; owner_uid: number; initialized_at: string; events: AccountEvent[] }
export interface AccountBinding { operator_id: string; account_id: string; request_id: string; fingerprint: string }
export interface AccountRecord { scope: AccountScope; fingerprint: string; status: "pending" | "validated" | "denied" | "revoked"; admitted: boolean }
export function accountBinding(r: AccountRecord): AccountBinding {
  return { operator_id: r.scope.operator_id, account_id: r.scope.account_id, request_id: r.scope.request_id, fingerprint: r.fingerprint };
}
export function validateAccountBinding(v: AccountBinding) {
  exact(v, ["operator_id", "account_id", "request_id", "fingerprint"]);
  uuid(v.operator_id, "operator"); uuid(v.account_id, "account"); uuid(v.request_id, "account-validation"); hex(v.fingerprint);
}
export function replayAccounts(h: AccountHistory): AccountRecord[] {
  exact(h, ["version", "operator_id", "owner_uid", "initialized_at", "events"]);
  uuid(h.operator_id, "operator"); time(h.initialized_at);
  if (h.version !== "14.3" || !Number.isSafeInteger(h.owner_uid) || h.owner_uid < 0 || !Array.isArray(h.events) || h.events.length > ACCOUNT_LIMITS.events) throw new Error("ACCOUNT_HISTORY_INVALID");
  const records: AccountRecord[] = [], requests = new Set<string>(); let previous: string | null = null, at = h.initialized_at;
  for (const [i, e] of h.events.entries()) {
    exact(e, ["sequence", "at", "kind", "scope", "fingerprint", "human_reference", "previous_hash", "hash", "action_authorized", "money_moved"]);
    const s = e.scope;
    exact(s, ["operator_id", "account_id", "platform", "source_platform", "opportunity_id", "candidate_fingerprint", "project_id", "dossier_hash", "input_hash", "source_hash", "request_id", "created_at", "expires_at", "purpose", "ownership_proof"]);
    uuid(s.operator_id, "operator"); uuid(s.account_id, "account"); uuid(s.request_id, "account-validation"); accountPlatform(s.platform);
    reference(s.opportunity_id); reference(s.project_id); [s.candidate_fingerprint, s.dossier_hash, s.input_hash, s.source_hash].forEach(hex);
    time(e.at); time(s.created_at); time(s.expires_at);
    if (s.operator_id !== h.operator_id || sourcePlatform(s.source_platform) !== s.platform || s.created_at < h.initialized_at || s.created_at >= s.expires_at || Date.parse(s.expires_at) - Date.parse(s.created_at) > ACCOUNT_LIMITS.days * 86400000 || s.purpose !== "EXISTING_ACCOUNT_PREPARATION_ONLY" || s.ownership_proof !== "UNVERIFIED_LOCAL_HUMAN_ATTESTATION" || e.at < at || e.at < s.created_at || e.sequence !== i + 1 || e.previous_hash !== previous || e.fingerprint !== canonicalHash(s) || e.human_reference !== `local-cli:v14.3:${e.kind}:${h.operator_id}:${s.request_id}` || e.action_authorized !== false || e.money_moved !== false) throw new Error("ACCOUNT_EVENT_BINDING_INVALID");
    const { hash: _hash, ...body } = e;
    if (hex(e.hash) !== canonicalHash(body)) throw new Error("ACCOUNT_EVENT_HASH_INVALID");
    let r = records.find(r => r.scope.account_id === s.account_id);
    if (e.kind === "declare") {
      if (r || requests.has(s.request_id) || e.at !== s.created_at || records.length >= ACCOUNT_LIMITS.declarations) throw new Error("ACCOUNT_DECLARATION_DUPLICATE");
      r = { scope: s, fingerprint: e.fingerprint, status: "pending", admitted: false }; records.push(r); requests.add(s.request_id);
    } else {
      if (!r || !same(r.scope, s) || r.fingerprint !== e.fingerprint) throw new Error("ACCOUNT_SCOPE_MISMATCH");
      if (e.kind === "validate" || e.kind === "deny") {
        if (r.status !== "pending" || e.at >= s.expires_at) throw new Error("ACCOUNT_DECISION_TERMINAL_OR_EXPIRED");
        r.status = e.kind === "validate" ? "validated" : "denied";
      } else if (e.kind === "revoke") {
        if (!["pending", "validated"].includes(r.status)) throw new Error("ACCOUNT_REVOCATION_TERMINAL"); r.status = "revoked";
      } else if (e.kind === "admit") {
        if (r.status !== "validated" || r.admitted || e.at >= s.expires_at || records.some(other => other !== r && other.admitted && other.scope.project_id === s.project_id)) throw new Error("ACCOUNT_ADMISSION_FORBIDDEN"); r.admitted = true;
      } else throw new Error("ACCOUNT_EVENT_FORBIDDEN");
    }
    previous = e.hash; at = e.at;
  }
  return records;
}
export function appendAccountEvent(h: AccountHistory, kind: AccountEvent["kind"], scope: AccountScope, at: string) {
  const body = { sequence: h.events.length + 1, at, kind, scope, fingerprint: canonicalHash(scope), human_reference: `local-cli:v14.3:${kind}:${h.operator_id}:${scope.request_id}`, previous_hash: h.events.at(-1)?.hash ?? null, action_authorized: false as const, money_moved: false as const };
  h.events.push({ ...body, hash: canonicalHash(body) }); replayAccounts(h);
}
export function validateAccountProjects(h: AccountHistory | undefined, projects: PreparedProject[], updatedAt: string) {
  const records = h ? replayAccounts(h) : [];
  if (h && (h.initialized_at > updatedAt || h.events.some(e => e.at > updatedAt))) throw new Error("ACCOUNT_CLOCK_INVALID");
  for (const p of projects.filter(p => p.account_validation)) {
    const b = p.account_validation!; validateAccountBinding(b);
    const r = records.find(r => same(accountBinding(r), b));
    if (!r?.admitted || r.scope.project_id !== p.project_id || r.scope.dossier_hash !== p.dossier_hash || r.scope.opportunity_id !== p.candidate.opportunity_id || r.scope.candidate_fingerprint !== p.candidate.fingerprint) throw new Error("ACCOUNT_PROJECT_BINDING_INVALID");
  }
  if (records.some(r => r.admitted && !projects.some(p => p.account_validation && same(p.account_validation, accountBinding(r))))) throw new Error("ACCOUNT_ADMISSION_HISTORY_MISSING");
}
export function accountPreparationBlockers(p: PreparedProject, h: AccountHistory | undefined, now: string) {
  if (!p.account_validation) return [];
  const r = h && replayAccounts(h).find(r => same(accountBinding(r), p.account_validation));
  return !r || r.status === "pending" ? ["ACCOUNT_VALIDATION_REQUIRED"] : r.status === "revoked" ? ["ACCOUNT_VALIDATION_REVOKED"] : r.status === "denied" ? ["ACCOUNT_BLOCKED"] : now >= r.scope.expires_at ? ["ACCOUNT_VALIDATION_EXPIRED"] : [];
}
