/** Trusted local operator observations. No network, ledger writer or executor. */
import { locked, readConfined } from "./ledger-runner.js";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { safePath, scoutWorkspaceRoot } from "./local-tools.js";
import { readPreparationSnapshot } from "./pilot-preparation.js";
import { accountPreparationBlockers } from "./seller-account-model.js";
import { canonicalHash, exact, hex, same, time, uuid } from "./project-model.js";
import { reference } from "./pilot-preparation-model.js";
import { assertPilotNotStopped, normalizedPilotRoot, pilotStopped } from "./pilot-stop.js";
import { DOCUMENTARY_LIMITS, parseDocumentaryInput, parseReconciliationInput, validateDocumentaryProof, replayDocumentary, reconcileDocumentary, documentarySummary, type DocumentaryScope, type DocumentaryState, type DocumentaryInput, type DocumentaryCommandData, type DocumentaryEvent } from "./documentary-model.js";
import { loadDocumentary, recoverDocumentary, commitDocumentary } from "./documentary-store.js";
export type DocumentaryCommand = { kind:"inspect"|"recover" } | { kind:"append"|"reconcile"; operator_id:string; project_id:string; dossier_hash:string; event_id:string };
export function parseDocumentaryCommand(args:string[]):DocumentaryCommand {
  if(args.length===1&&["--inspect","--recover"].includes(args[0]))return {kind:args[0].slice(2) as "inspect"};
  if(args.length===5&&["--append","--reconcile"].includes(args[0]))return {kind:args[0].slice(2) as "append",operator_id:uuid(args[1],"operator"),project_id:reference(args[2]),dossier_hash:hex(args[3]),event_id:reference(args[4])};
  throw new Error("DOCUMENTARY_COMMAND_FORBIDDEN");
}
function validateCommand(c:DocumentaryCommand) {
  if("event_id" in c){exact(c,["kind","operator_id","project_id","dossier_hash","event_id"]);if(!same(c,parseDocumentaryCommand([`--${c.kind}`,c.operator_id,c.project_id,c.dossier_hash,c.event_id])))throw new Error("DOCUMENTARY_COMMAND_FORBIDDEN");}
  else{exact(c,["kind"]);parseDocumentaryCommand([`--${c.kind}`]);}
}
type Snapshot=Awaited<ReturnType<typeof readPreparationSnapshot>>;
const snapshotHash=(s:Snapshot)=>canonicalHash([s.state,s.sources,s.missing]);
function operator(s:Snapshot,id?:string) {
  const h=s.state.seller_accounts;
  if(!h||!process.getuid||h.owner_uid!==process.getuid()||id!==undefined&&h.operator_id!==id)throw new Error("DOCUMENTARY_V14_3_OPERATOR_REQUIRED");return h.operator_id;
}
function scopeFor(s:Snapshot,projectId:string,dossierHash:string,input?:DocumentaryInput):DocumentaryScope {
  const p=s.state.projects.find(p=>p.project_id===projectId&&p.dossier_hash===dossierHash);
  if(!p)throw new Error("DOCUMENTARY_EXACT_PREPARED_PROJECT_REQUIRED");
  const r=input?.binding==="V14_2_ACCOUNTING_IDENTITY"?p.accounting_transfer:undefined;
  if(input?.binding==="V14_2_ACCOUNTING_IDENTITY"&&!r)throw new Error("DOCUMENTARY_EXISTING_V14_2_IDENTITY_REQUIRED");
  return {operator_id:operator(s),project_id:p.project_id,dossier_hash:p.dossier_hash,candidate_fingerprint:p.candidate.fingerprint,input_hash:s.state.input_hash,source_hash:s.state.source_hash,account_binding:p.account_validation??null,economic_identity:r?{transfer_id:r.transfer_id,target_project_id:r.target_project_id,experiment_id:r.experiment_id,ledger_entry_id:r.ledger_entry_id,ledger_entry_hash:r.ledger_entry_hash}:null};
}
async function verifyProofs(root:string,state:DocumentaryState) {
  for(const e of state.events)if(Object.hasOwn(e.input,"operation")) {
    const d=e.input as DocumentaryInput;if(!d.proof)continue;
    // Hash ORIGINAL bytes and reject malformed UTF-8; replacement decoding
    // must never hide a byte change. Same confinement / no-follow boundary.
    const target=await safePath(root,d.proof.file);let fd;
    try{fd=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);}
    catch(error){if((error as NodeJS.ErrnoException).code === "ENOENT")throw new Error("DOCUMENTARY_PROOF_MISSING");throw error;}
    try{
      const stat=await fd.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>DOCUMENTARY_LIMITS.proofBytes)throw new Error("DOCUMENTARY_UNSAFE_PROOF");
      const bytes=await fd.readFile();if(bytes.length>DOCUMENTARY_LIMITS.proofBytes)throw new Error("DOCUMENTARY_PROOF_SIZE");
      if(createHash("sha256").update(bytes).digest("hex")!==d.proof.sha256)throw new Error("DOCUMENTARY_PROOF_CHANGED");
      const raw=new TextDecoder("utf-8",{fatal:true}).decode(bytes);validateDocumentaryProof(raw,e.scope,d);
    }finally{await fd.close();}
  }
}
function verifyBindings(state:DocumentaryState,s:Snapshot) {
  if(state.operator_id!==operator(s))throw new Error("DOCUMENTARY_OPERATOR_HISTORY_CHANGED");
  for(const e of state.events){
    const expected=scopeFor(s,e.scope.project_id,e.scope.dossier_hash,Object.hasOwn(e.input,"operation")?e.input as DocumentaryInput:undefined);
    // A reconciliation may retain its subject's historical V14.2 identity.
    if(e.scope.economic_identity!==null&&expected.economic_identity===null){
      const p=s.state.projects.find(p=>p.project_id===e.scope.project_id)!;
      if(!p.accounting_transfer)throw new Error("DOCUMENTARY_IDENTITY_HISTORY_CHANGED");
      expected.economic_identity={transfer_id:p.accounting_transfer.transfer_id,target_project_id:p.accounting_transfer.target_project_id,experiment_id:p.accounting_transfer.experiment_id,ledger_entry_id:p.accounting_transfer.ledger_entry_id,ledger_entry_hash:p.accounting_transfer.ledger_entry_hash};
    }
    if(!same(e.scope,expected))throw new Error("DOCUMENTARY_SCOPE_HISTORY_CHANGED");
    const p=s.state.projects.find(p=>p.project_id===e.scope.project_id)!;
    if(Object.hasOwn(e.input,"operation")&&(e.input as DocumentaryInput).occurred_at<p.created_at)throw new Error("DOCUMENTARY_EVENT_PREDATES_PREPARATION");
  }
}
function result(state:DocumentaryState,s:Snapshot,now:string,stopped:boolean) {
  return {version:"14.4",mode:"LOCAL_DOCUMENTARY_OBSERVATIONS_ONLY",operator_id:state.operator_id,events:state.events,
    projects:s.state.projects.map(p=>({ ...documentarySummary(state,p.project_id,p.dossier.budget_cents),dossier_hash:p.dossier_hash,recording_blockers:[...(stopped?["EMERGENCY_STOP"]:[]),...(p.dossier.fictional?["FICTIONAL_SCOPE"]:[]),...(now>=p.dossier.review_expires_at?["DOSSIER_REVIEW_EXPIRED"]:[]),...accountPreparationBlockers(p,s.state.seller_accounts,now)],economic_identity:p.accounting_transfer?{target_project_id:p.accounting_transfer.target_project_id,experiment_id:p.accounting_transfer.experiment_id,status:"ACCOUNTING_RESERVATION_ONLY_NOT_LAUNCH"}:null})),
    execution_allowed:false,bank_connection_performed:false,commercial_connection_performed:false,payment_performed:false,publication_performed:false,money_moved_cents:0,capital_is_bank_balance:false,authorized_capital_increase_cents:0,authenticated_learning_eligible:false,full_restore_protected:false,freshness_guarantee:"DOCUMENTARY_ROLLBACK_DETECTED_ONLY_WHILE_SEPARATE_LOCAL_WITNESS_IS_PRESERVED",
    notice:"DECLARATIONS_AND_CURATED_ARCHIVES_ARE_NOT_INDEPENDENT_BANK_CONFIRMATIONS; NO_LAUNCH_OR_FINANCIAL_WRITE"};
}
export async function runDocumentary(options:{root?:string;command:DocumentaryCommand;now?:()=>string}) {
  if(process.env.SCOUT_MODE!=="economic-documentation")throw new Error("Explicit SCOUT_MODE=economic-documentation required");
  validateCommand(options.command);const root=normalizedPilotRoot(options.root??scoutWorkspaceRoot()),c=options.command;
  return locked(root,async()=>{
    const clock=()=>time((options.now??(()=>new Date().toISOString()))()),now=clock();
    let loaded=await loadDocumentary(root);
    if(loaded.witness&&!loaded.witness.installed){
      if(c.kind==="inspect")return {version:"14.4",status:"COMMITTED_DOCUMENTARY_RECOVERY_REQUIRED",execution_allowed:false,bank_independently_confirmed:false};
      if(c.kind!=="recover")throw new Error("DOCUMENTARY_RECOVERY_REQUIRED");
      await recoverDocumentary(root);loaded=await loadDocumentary(root);
    }
    const s=await readPreparationSnapshot(root,now,await pilotStopped(root)),operatorId=operator(s,"operator_id" in c?c.operator_id:undefined);
    const state:DocumentaryState=loaded.state??{version:"14.4",workspace:root,operator_id:operatorId,events:[]};
    replayDocumentary(state);verifyBindings(state,s);await verifyProofs(root,state);
    if(state.events.some(e=>e.recorded_at>now))throw new Error("DOCUMENTARY_CLOCK_ROLLBACK");
    if(c.kind==="inspect"||c.kind==="recover")return result(state,s,now,await pilotStopped(root));
    if(!("event_id" in c))throw new Error("DOCUMENTARY_COMMAND_FORBIDDEN");
    await assertPilotNotStopped(root);
    const p=s.state.projects.find(p=>p.project_id===c.project_id&&p.dossier_hash===c.dossier_hash);
    if(!p||p.dossier.fictional||now>=p.dossier.review_expires_at||accountPreparationBlockers(p,s.state.seller_accounts,now).length)throw new Error("DOCUMENTARY_SCOPE_BLOCKED_OR_REVOKED");
    if(s.missing.some(m=>m.startsWith(p.dossier.opportunity_id+":")))throw new Error("DOCUMENTARY_DOSSIER_PROOF_MISSING");
    const filename=c.kind==="append"?"documentary-event-input.json":"documentary-reconciliation-input.json";
    const raw=await readConfined(root,filename,DOCUMENTARY_LIMITS.inputBytes);if(!raw)throw new Error("DOCUMENTARY_EXPLICIT_INPUT_REQUIRED");
    const input:DocumentaryCommandData=c.kind==="append"?parseDocumentaryInput(JSON.parse(raw)):parseReconciliationInput(JSON.parse(raw));
    const scope=scopeFor(s,c.project_id,c.dossier_hash,Object.hasOwn(input,"operation")?input as DocumentaryInput:undefined);
    if(c.kind==="reconcile") {
      const first=replayDocumentary(state).rows.find(r=>r.event.event_id===(input as import("./documentary-model.js").ReconciliationInput).event_ids[0]);
      if(!first||first.event.scope.project_id!==c.project_id||first.event.scope.dossier_hash!==c.dossier_hash)throw new Error("DOCUMENTARY_RECONCILIATION_SCOPE_MISMATCH");
      scope.economic_identity=first.event.scope.economic_identity;
    }
    const previous=state.events.find(e=>e.event_id===c.event_id);
    if(previous){if(!same(previous.input,input)||!same(previous.scope,scope))throw new Error("DOCUMENTARY_IDEMPOTENCY_CONFLICT");return result(state,s,now,false);}
    const next=structuredClone(state);
    const body={event_id:c.event_id,sequence:next.events.length+1,recorded_at:now,scope,source_snapshot_hash:snapshotHash(s),input,reconciliation:c.kind==="reconcile"?reconcileDocumentary(replayDocumentary(state).rows,input as import("./documentary-model.js").ReconciliationInput):null,human_reference:`local-cli:v14.4:${operatorId}:${c.event_id}`,previous_hash:next.events.at(-1)?.hash??null,action_authorized:false as const,money_moved:false as const};
    const e:DocumentaryEvent={...body,hash:canonicalHash(body)};next.events.push(e);replayDocumentary(next);verifyBindings(next,s);await verifyProofs(root,next);
    const at=clock();if(at<now||at>=p.dossier.review_expires_at||accountPreparationBlockers(p,s.state.seller_accounts,at).length)throw new Error("DOCUMENTARY_EXPIRED_OR_CLOCK_ROLLBACK_BEFORE_COMMIT");
    const current=await readPreparationSnapshot(root,at);
    if(snapshotHash(current)!==snapshotHash(s)||await readConfined(root,filename,DOCUMENTARY_LIMITS.inputBytes)!==raw||!same((await loadDocumentary(root)).state,loaded.state))throw new Error("DOCUMENTARY_SOURCES_CHANGED_BEFORE_COMMIT");
    await verifyProofs(root,next);await assertPilotNotStopped(root);
    e.recorded_at=at;const {hash:_old,...updated}=e;e.hash=canonicalHash(updated);replayDocumentary(next);
    await commitDocumentary(root,next);await assertPilotNotStopped(root);
    const after=await readPreparationSnapshot(root,clock(),await pilotStopped(root));verifyBindings(next,after);await verifyProofs(root,next);
    return result(next,after,clock(),await pilotStopped(root));
  },c.kind==="inspect"||c.kind==="recover"?"documentation-read":"documentation");
}
export async function runDocumentaryCli(args:string[]) {
  try{console.log(JSON.stringify(await runDocumentary({command:parseDocumentaryCommand(args)}),null,2));}
  catch{console.error(JSON.stringify({version:"14.4",status:"BLOCKED_LOCAL_INSPECTION_REQUIRED",execution_allowed:false,bank_independently_confirmed:false,money_moved_cents:0}));process.exitCode=1;}
}
