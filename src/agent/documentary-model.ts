/** Documentary observations, NEVER V5/V9 entries, bank facts or permissions. */
import { canonicalHash, exact, hex, same, time, uuid } from "./project-model.js";
import { integerCents } from "./asset-lifecycle.js";
import { reference, rejectSensitive } from "./pilot-preparation-model.js";
import type { AccountBinding } from "./seller-account-model.js";
import { validateAccountBinding } from "./seller-account-model.js";
export const DOCUMENTARY_LIMITS = Object.freeze({ events: 128, bytes: 512 * 1024, proofBytes: 16 * 1024, inputBytes: 16 * 1024 });
export const DOCUMENTARY_KINDS = ["expense", "order", "sale", "invoice", "receipt", "platform_fee", "payment_fee", "refund", "cancellation", "payment_pending", "payout", "payout_receipt"] as const;
export type DocumentaryKind = typeof DOCUMENTARY_KINDS[number];
export interface DocumentaryProof { file: string; sha256: string }
export interface DocumentaryInput {
  version: "14.4"; operation: "record" | "correct" | "document"; binding: "PREPARATION_ONLY" | "V14_2_ACCOUNTING_IDENTITY";
  kind: DocumentaryKind; amount_cents: number; currency: "EUR"; occurred_at: string;
  commercial_reference: string | null; related_commercial_reference: string | null; related_event_id: string | null; target_event_id: string | null;
  source: "HUMAN_DECLARATION" | "LOCAL_COMMERCIAL_ARCHIVE"; proof: DocumentaryProof | null;
}
export interface DocumentaryScope {
  operator_id: string; project_id: string; dossier_hash: string; candidate_fingerprint: string; input_hash: string; source_hash: string;
  account_binding: AccountBinding | null;
  economic_identity: { transfer_id: string; target_project_id: string; experiment_id: string; ledger_entry_id: string; ledger_entry_hash: string } | null;
}
export const RECONCILIATION_RULES = ["order-sale", "sale-receipt", "sale-fees", "sale-refunds", "payout-receipt"] as const;
export type ReconciliationRule = typeof RECONCILIATION_RULES[number];
export interface ReconciliationInput { version: "14.4"; rule: ReconciliationRule; event_ids: string[] }
export interface ReconciliationResult { status: "MATCH" | "INCONSISTENT" | "INCOMPLETE"; reason: string; difference_cents: number | null; basis_hash: string; bank_independently_confirmed: false }
export type DocumentaryCommandData = DocumentaryInput | ReconciliationInput;
export interface DocumentaryEvent {
  event_id: string; sequence: number; recorded_at: string; scope: DocumentaryScope; source_snapshot_hash: string;
  input: DocumentaryCommandData; reconciliation: ReconciliationResult | null;
  human_reference: string; previous_hash: string | null; hash: string; action_authorized: false; money_moved: false;
}
export interface DocumentaryState { version: "14.4"; workspace: string; operator_id: string; events: DocumentaryEvent[] }
export interface DocumentaryRow { root_id: string; event: DocumentaryEvent; input: DocumentaryInput }
export function commercialReference(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v)) throw new Error("DOCUMENTARY_REFERENCE_INVALID");
  rejectSensitive(v);
  if (/(?:secret|token|cookie|session|password|api.?key|totp)|^(?:sk_|pk_|whsec_|ghp_|github_pat_|eyJ)/i.test(v)) throw new Error("SENSITIVE_INPUT_REJECTED");
  return v;
}
export function parseDocumentaryInput(v: unknown): DocumentaryInput {
  const d = exact(v, ["version", "operation", "binding", "kind", "amount_cents", "currency", "occurred_at", "commercial_reference", "related_commercial_reference", "related_event_id", "target_event_id", "source", "proof"]) as unknown as DocumentaryInput;
  if (d.version !== "14.4" || !["record", "correct", "document"].includes(d.operation) || !["PREPARATION_ONLY", "V14_2_ACCOUNTING_IDENTITY"].includes(d.binding) || !DOCUMENTARY_KINDS.includes(d.kind) || d.currency !== "EUR" || !["HUMAN_DECLARATION", "LOCAL_COMMERCIAL_ARCHIVE"].includes(d.source)) throw new Error("DOCUMENTARY_SCHEMA_OR_SOURCE_FORBIDDEN");
  integerCents(d.amount_cents); time(d.occurred_at); commercialReference(d.commercial_reference); commercialReference(d.related_commercial_reference);
  if (d.kind === "cancellation" ? d.amount_cents !== 0 : d.amount_cents <= 0) throw new Error("DOCUMENTARY_AMOUNT_INVALID");
  for (const id of [d.related_event_id, d.target_event_id]) if (id !== null) reference(id);
  if (d.operation === "record" ? d.target_event_id !== null : d.target_event_id === null) throw new Error("DOCUMENTARY_TARGET_REQUIRED");
  if (d.operation === "correct" && (d.source !== "HUMAN_DECLARATION" || d.proof !== null) || d.operation === "document" && d.source !== "LOCAL_COMMERCIAL_ARCHIVE") throw new Error("DOCUMENTARY_CORRECTION_OR_ATTACHMENT_INVALID");
  if (["invoice", "receipt", "payout_receipt"].includes(d.kind) && d.source !== "LOCAL_COMMERCIAL_ARCHIVE") throw new Error("DOCUMENTARY_ARCHIVE_REQUIRED");
  if (d.source === "HUMAN_DECLARATION") { if (d.proof !== null) throw new Error("DOCUMENTARY_SOURCE_PROOF_MISMATCH"); }
  else {
    if (!d.proof) throw new Error("DOCUMENTARY_PROOF_REQUIRED");
    exact(d.proof, ["file", "sha256"]); hex(d.proof.sha256);
    if (!/^documentary-evidence\/[a-z][a-z0-9-]{0,79}\.json$/.test(d.proof.file)) throw new Error("DOCUMENTARY_CONFINED_JSON_REQUIRED");
  }
  if (["refund", "cancellation", "payment_pending"].includes(d.kind) && d.related_event_id === null) throw new Error("DOCUMENTARY_RELATION_REQUIRED");
  return d;
}
export function parseReconciliationInput(v: unknown): ReconciliationInput {
  const d = exact(v, ["version", "rule", "event_ids"]) as unknown as ReconciliationInput;
  if (d.version !== "14.4" || !RECONCILIATION_RULES.includes(d.rule) || !Array.isArray(d.event_ids) || d.event_ids.length < 2 || d.event_ids.length > 9 || new Set(d.event_ids).size !== d.event_ids.length) throw new Error("DOCUMENTARY_RECONCILIATION_INVALID");
  d.event_ids.forEach(reference); return d;
}
export function validateDocumentaryScope(s: DocumentaryScope) {
  exact(s, ["operator_id", "project_id", "dossier_hash", "candidate_fingerprint", "input_hash", "source_hash", "account_binding", "economic_identity"]);
  uuid(s.operator_id, "operator"); reference(s.project_id); [s.dossier_hash, s.candidate_fingerprint, s.input_hash, s.source_hash].forEach(hex);
  if (s.account_binding !== null) { validateAccountBinding(s.account_binding); if (s.account_binding.operator_id !== s.operator_id) throw new Error("DOCUMENTARY_ACCOUNT_OWNER_MISMATCH"); }
  if (s.economic_identity !== null) {
    const r = s.economic_identity; exact(r, ["transfer_id", "target_project_id", "experiment_id", "ledger_entry_id", "ledger_entry_hash"]);
    reference(r.transfer_id); uuid(r.target_project_id, "project"); hex(r.experiment_id); hex(r.ledger_entry_hash);
    if (!/^entry-[0-9]{6}$/.test(r.ledger_entry_id)) throw new Error("DOCUMENTARY_IDENTITY_INVALID");
  }
}
const projectMatch = (a: DocumentaryScope, b: DocumentaryScope) => a.project_id === b.project_id && a.dossier_hash === b.dossier_hash && a.operator_id === b.operator_id;
/** Strict curated JSON facts. It is NOT an independent original or bank proof. */
export function validateDocumentaryProof(raw: string, scope: DocumentaryScope, d: DocumentaryInput) {
  if (!raw.trim() || Buffer.byteLength(raw) > DOCUMENTARY_LIMITS.proofBytes) throw new Error("DOCUMENTARY_PROOF_SIZE");
  rejectSensitive(raw);
  const p = exact(JSON.parse(raw), ["version", "source", "project_id", "dossier_hash", "kind", "amount_cents", "currency", "occurred_at", "commercial_reference", "related_commercial_reference", "related_event_id"]);
  if (p.version !== "14.4" || p.source !== "OPERATOR_CURATED_COMMERCIAL_ARCHIVE" || p.project_id !== scope.project_id || p.dossier_hash !== scope.dossier_hash || !same([p.kind,p.amount_cents,p.currency,p.occurred_at,p.commercial_reference,p.related_commercial_reference,p.related_event_id], [d.kind,d.amount_cents,d.currency,d.occurred_at,d.commercial_reference,d.related_commercial_reference,d.related_event_id])) throw new Error("DOCUMENTARY_PROOF_FACTS_MISMATCH");
}
function sum(values: number[]): number {
  const n = values.reduce((s, v) => s + BigInt(v), 0n);
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("DOCUMENTARY_SUM_OVERFLOW"); return Number(n);
}
export function reconcileDocumentary(rows: DocumentaryRow[], request: ReconciliationInput): ReconciliationResult {
  parseReconciliationInput(request);
  const selected = request.event_ids.map(id => { const row = rows.find(r => r.event.event_id === id); if (!row) throw new Error("DOCUMENTARY_CURRENT_EVENT_REQUIRED"); return row; });
  const [first, ...rest] = selected, a = first.input;
  if (selected.some(r => !projectMatch(r.event.scope, first.event.scope))) throw new Error("DOCUMENTARY_CROSS_PROJECT_RECONCILIATION");
  const result = (status: ReconciliationResult["status"], reason: string, difference: number | null = null): ReconciliationResult => ({ status, reason, difference_cents: difference, basis_hash: canonicalHash(selected.map(r => r.event.hash)), bank_independently_confirmed: false });
  const kinds = rest.map(r => r.input.kind), single = rest.length === 1;
  const allowed = request.rule === "order-sale" ? a.kind === "order" && single && kinds[0] === "sale" : request.rule === "sale-receipt" ? a.kind === "sale" && single && ["receipt","invoice"].includes(kinds[0]) : request.rule === "sale-fees" ? a.kind === "sale" && kinds.every(k => ["platform_fee","payment_fee"].includes(k)) : request.rule === "sale-refunds" ? a.kind === "sale" && kinds.every(k => k === "refund") : a.kind === "payout" && single && kinds[0] === "payout_receipt";
  if (!allowed) throw new Error("DOCUMENTARY_RULE_KIND_MISMATCH");
  if (!a.commercial_reference || rest.some(r => !r.input.commercial_reference)) return result("INCOMPLETE", "COMMERCIAL_REFERENCE_UNKNOWN");
  if (rest.some(r => r.input.related_event_id !== first.root_id || r.input.occurred_at < a.occurred_at)) return result("INCONSISTENT", "RELATION_OR_DATE_MISMATCH");
  if (rest.some(r => r.input.related_commercial_reference === null)) return result("INCOMPLETE", "RELATED_COMMERCIAL_REFERENCE_UNKNOWN");
  if (rest.some(r => r.input.related_commercial_reference !== a.commercial_reference) || ["order-sale","sale-receipt","payout-receipt"].includes(request.rule) && rest[0].input.commercial_reference !== a.commercial_reference) return result("INCONSISTENT", "COMMERCIAL_REFERENCE_MISMATCH");
  if (["sale-fees","sale-refunds"].includes(request.rule)) {
    const components=rows.filter(r=>r.input.related_event_id===first.root_id && (request.rule === "sale-refunds" ? r.input.kind === "refund" : ["platform_fee","payment_fee"].includes(r.input.kind)));
    if(components.length !== rest.length || components.some(r=>!rest.includes(r))) return result("INCOMPLETE", "COMPONENTS_OMITTED");
  }
  if (rows.some(r => r.input.kind === "cancellation" && (r.input.related_event_id === first.root_id || a.kind === "sale" && r.input.related_event_id === a.related_event_id))) return result("INCONSISTENT", "CANCELLED_REFERENCE");
  const delta = sum(rest.map(r => r.input.amount_cents)) - a.amount_cents;
  if (["order-sale","sale-receipt","payout-receipt"].includes(request.rule) && delta !== 0) return result("INCONSISTENT", "AMOUNT_MISMATCH", delta);
  if (["sale-fees","sale-refunds"].includes(request.rule) && delta > 0) return result("INCONSISTENT", "COMPONENTS_EXCEED_SALE", delta);
  const required = ["sale-receipt","payout-receipt"].includes(request.rule) ? rest : selected;
  if (required.some(r => r.input.source !== "LOCAL_COMMERCIAL_ARCHIVE")) return result("INCOMPLETE", "UNDOCUMENTED_COMPONENT", delta);
  return result("MATCH", "DOCUMENTARY_CONCORDANCE_ONLY", delta);
}
export function replayDocumentary(s: DocumentaryState) {
  exact(s, ["version", "workspace", "operator_id", "events"]); uuid(s.operator_id, "operator");
  if (s.version !== "14.4" || typeof s.workspace !== "string" || !Array.isArray(s.events) || s.events.length > DOCUMENTARY_LIMITS.events) throw new Error("DOCUMENTARY_HISTORY_INVALID");
  const rows: DocumentaryRow[] = [], ids = new Set<string>(), proofOwners = new Map<string,string>();
  const reconciliations: DocumentaryEvent[] = []; let previous: string | null = null, at = "";
  for (const [i,e] of s.events.entries()) {
    exact(e, ["event_id", "sequence", "recorded_at", "scope", "source_snapshot_hash", "input", "reconciliation", "human_reference", "previous_hash", "hash", "action_authorized", "money_moved"]);
    reference(e.event_id); time(e.recorded_at); hex(e.source_snapshot_hash); validateDocumentaryScope(e.scope);
    const {hash:_hash,...body}=e;
    if (ids.has(e.event_id) || e.sequence !== i+1 || e.recorded_at < at || e.previous_hash !== previous || e.hash !== canonicalHash(body) || e.scope.operator_id !== s.operator_id || e.human_reference !== `local-cli:v14.4:${s.operator_id}:${e.event_id}` || e.action_authorized !== false || e.money_moved !== false) throw new Error("DOCUMENTARY_EVENT_INTEGRITY_INVALID");
    ids.add(e.event_id); at=e.recorded_at; previous=e.hash;
    if (Object.hasOwn(e.input,"rule")) {
      const input=parseReconciliationInput(e.input);
      if (!same(e.reconciliation,reconcileDocumentary(rows,input)) || input.event_ids.some(id=>!projectMatch(rows.find(r=>r.event.event_id===id)!.event.scope,e.scope))) throw new Error("DOCUMENTARY_RECONCILIATION_HISTORY_INVALID");
      reconciliations.push(e);continue;
    }
    const d=parseDocumentaryInput(e.input);
    if (d.occurred_at > e.recorded_at || e.reconciliation !== null || (d.binding === "V14_2_ACCOUNTING_IDENTITY") !== (e.scope.economic_identity !== null)) throw new Error("DOCUMENTARY_DATE_OR_BINDING_INVALID");
    let rootId=e.event_id;
    if(d.operation !== "record") {
      const target=rows.find(r=>r.event.event_id===d.target_event_id);
      if(!target || !projectMatch(target.event.scope,e.scope) || target.input.source !== "HUMAN_DECLARATION" || target.input.kind !== d.kind || target.input.related_event_id !== d.related_event_id || target.input.binding !== d.binding) throw new Error("DOCUMENTARY_CORRECTION_TARGET_INVALID");
      if(d.operation === "document") {
        const fields=(x:DocumentaryInput)=>[x.kind,x.amount_cents,x.currency,x.occurred_at,x.commercial_reference,x.related_commercial_reference,x.related_event_id,x.binding];
        if(!same(fields(target.input),fields(d))) throw new Error("DOCUMENTARY_ATTACHMENT_CHANGES_FACTS");
      }
      rootId=target.root_id;rows.splice(rows.indexOf(target),1);
    }
    if(d.related_event_id !== null) {
      const related=rows.find(r=>r.root_id===d.related_event_id);
      if(!related || !projectMatch(related.event.scope,e.scope)) throw new Error("DOCUMENTARY_RELATION_PROJECT_MISMATCH");
      if(d.kind === "refund" && related.input.kind !== "sale" || d.kind === "cancellation" && !["order","sale"].includes(related.input.kind) || d.kind === "payment_pending" && related.input.kind !== "sale") throw new Error("DOCUMENTARY_RELATION_KIND_MISMATCH");
    }
    if(rows.some(r=>projectMatch(r.event.scope,e.scope) && r.input.kind===d.kind && (d.commercial_reference !== null && r.input.commercial_reference===d.commercial_reference || same({...r.input,operation:"record",target_event_id:null,proof:null,source:"HUMAN_DECLARATION"},{...d,operation:"record",target_event_id:null,proof:null,source:"HUMAN_DECLARATION"})))) throw new Error("DOCUMENTARY_DUPLICATE_FACT");
    if(d.proof) {
      const owner=proofOwners.get(d.proof.sha256);if(owner && owner!==rootId) throw new Error("DOCUMENTARY_DUPLICATE_PROOF");proofOwners.set(d.proof.sha256,rootId);
    }
    rows.push({root_id:rootId,event:e,input:d});
  }
  return {rows,reconciliations};
}
export function documentarySummary(s: DocumentaryState, projectId: string, budget: number) {
  const replay=replayDocumentary(s), rows=replay.rows.filter(r=>r.event.scope.project_id===projectId);
  const recs=replay.reconciliations.filter(e=>e.scope.project_id===projectId).map(e=>({event_id:e.event_id,result:e.reconciliation!,current:(e.input as ReconciliationInput).event_ids.every(id=>rows.some(r=>r.event.event_id===id)) && e.reconciliation!.basis_hash === canonicalHash((e.input as ReconciliationInput).event_ids.map(id=>rows.find(r=>r.event.event_id===id)?.event.hash))}));
  for (const r of recs) if (r.current) {
    const e=replay.reconciliations.find(e=>e.event_id===r.event_id)!;
    r.current=same(reconcileDocumentary(rows,e.input as ReconciliationInput),r.result);
  }
  const derivedDocumented=new Set(recs.filter(r=>r.current&&r.result.status==="MATCH").flatMap(r=>{
    const e=replay.reconciliations.find(e=>e.event_id===r.event_id)!;return ["sale-receipt","payout-receipt"].includes((e.input as ReconciliationInput).rule)?[(e.input as ReconciliationInput).event_ids[0]]:[];
  }));
  const documented=(r:DocumentaryRow)=>r.input.source === "LOCAL_COMMERCIAL_ARCHIVE" || derivedDocumented.has(r.event.event_id);
  const totals=(kind:DocumentaryKind,doc=false)=>sum(rows.filter(r=>r.input.kind===kind&&(!doc||documented(r))).map(r=>r.input.amount_cents));
  const cancellations=new Set(rows.filter(r=>r.input.kind==="cancellation").map(r=>r.input.related_event_id));
  const sales=rows.filter(r=>r.input.kind==="sale"), issues:string[]=[];
  const cancelled=(r:DocumentaryRow)=>cancellations.has(r.root_id)||cancellations.has(r.input.related_event_id);
  for(const row of rows) if(row.input.related_event_id !== null && row.input.related_commercial_reference !== null) {
    const parent=rows.find(r=>r.root_id===row.input.related_event_id);
    if(!parent || parent.input.commercial_reference!==row.input.related_commercial_reference) issues.push("COMMERCIAL_RELATION_CONFLICT");
    if(parent&&row.input.kind==="payment_pending"&&row.input.amount_cents>parent.input.amount_cents)issues.push("PENDING_EXCEEDS_SALE");
  }
  let reportedNet=0n;
  for(const sale of sales){const refunds=sum(rows.filter(r=>r.input.kind==="refund"&&r.input.related_event_id===sale.root_id).map(r=>r.input.amount_cents));if(refunds>sale.input.amount_cents)issues.push("REFUNDS_EXCEED_SALE");reportedNet+=BigInt(cancelled(sale)?0:Math.max(0,sale.input.amount_cents-refunds));}
  const fees=sum([totals("platform_fee"),totals("payment_fee")]), expenses=totals("expense"), outflow=sum([fees,expenses]);
  const margin=Number(reportedNet)-outflow;
  const monetary=rows.filter(r=>["sale","expense","platform_fee","payment_fee","refund","cancellation"].includes(r.input.kind));
  const allDocumented=monetary.length>0&&monetary.every(documented);
  if(recs.some(r=>r.current&&r.result.status==="INCONSISTENT"))issues.push("DOCUMENTARY_RECONCILIATION_CONFLICT");
  const unlinked=rows.filter(r=>["sale","refund","platform_fee","payment_fee","payment_pending","payout"].includes(r.input.kind)&&!recs.some(c=>c.current&&c.result.status==="MATCH"&&(replay.reconciliations.find(e=>e.event_id===c.event_id)!.input as ReconciliationInput).event_ids.includes(r.event.event_id))).map(r=>r.root_id);
  return {project_id:projectId,declared_gross_sales_cents:totals("sale"),documented_gross_sales_cents:totals("sale",true),declared_expenses_cents:expenses,documented_expenses_cents:totals("expense",true),declared_fees_cents:fees,documented_fees_cents:sum([totals("platform_fee",true),totals("payment_fee",true)]),declared_refunds_cents:totals("refund"),documented_refunds_cents:totals("refund",true),cancelled_sales_cents:sum(sales.filter(cancelled).map(r=>r.input.amount_cents)),reported_sales_after_cancellations_and_refunds_cents:Number(reportedNet),pending_amount_cents:totals("payment_pending"),declared_payouts_cents:totals("payout"),documented_payouts_cents:totals("payout",true),partial_reported_margin_cents:monetary.length&&!issues.length?margin:null,partial_documentary_margin_cents:allDocumented&&!issues.length?margin:null,real_net_profit_cents:null,bank_independently_confirmed_receipts_cents:null,bank_independently_confirmed:false,taxes_and_other_charges_known:false,planned_spending_ceiling_cents:budget,reported_outflow_exceeds_planned_ceiling:outflow>budget,authorized_capital_increase_cents:0,issues:[...new Set(issues)],unreconciled_event_ids:unlinked,reconciliations:recs,unknowns:["TAXES_AND_OTHER_CHARGES","INDEPENDENT_COMMERCIAL_AUTHENTICITY","BANK_RECEIPTS","UNREPORTED_FEES_OR_REFUNDS"],basis:"PARTIAL_DOCUMENTARY_AND_HUMAN_ARITHMETIC_NOT_VERIFIED_PROFIT"};
}
