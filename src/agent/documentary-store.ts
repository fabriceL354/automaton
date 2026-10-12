/** Documentary journal only. Existing preparation key; V14.3's demonstrated
 * durable intent/install pattern. No V5/V9/preparation-state financial writes. */
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { atomicWrite, readConfined } from "./ledger-runner.js";
import { safePath } from "./local-tools.js";
import { preparationStoreRoot } from "./pilot-preparation-store.js";
import { assertPilotNotStopped } from "./pilot-stop.js";
import { canonicalHash, exact, hex, same, structured } from "./project-model.js";
import { DOCUMENTARY_LIMITS, replayDocumentary, type DocumentaryState } from "./documentary-model.js";
export const DOCUMENTARY_FILE = "documentary-state.json", DOCUMENTARY_WITNESS_BYTES = 2 * 1024 * 1024;
export const documentaryWitnessRoot = (root: string) => path.join(path.dirname(root), `.scout-documentary-witness-${canonicalHash(root).slice(0,32)}`);
const mac = (kind: string, value: unknown, key: Buffer) => createHmac("sha256",key).update(`scout-v14.4:${kind}\0`).update(JSON.stringify(value)).digest();
export function decodeDocumentary(raw: string, root: string, key: Buffer): DocumentaryState {
  if(Buffer.byteLength(raw)>DOCUMENTARY_LIMITS.bytes)throw new Error("DOCUMENTARY_HISTORY_SIZE_LIMIT");
  const d=exact(JSON.parse(raw),["state","mac"]),s=d.state as DocumentaryState;
  if(!timingSafeEqual(mac("state",s,key),Buffer.from(hex(d.mac),"hex")))throw new Error("DOCUMENTARY_AUTHENTICATION_FAILED");
  replayDocumentary(s);if(s.workspace!==root || !s.events.length)throw new Error("DOCUMENTARY_WORKSPACE_OR_EMPTY_STATE");return s;
}
export function encodeDocumentary(s: DocumentaryState, root: string, key: Buffer) {
  const raw=structured({state:s,mac:mac("state",s,key).toString("hex")});decodeDocumentary(raw,root,key);return raw;
}
export interface DocumentaryWitness { version:"14.4"; workspace:string; sequence:number; before:string|null; after:string; installed:boolean }
export function decodeDocumentaryWitness(raw:string,root:string,key:Buffer):DocumentaryWitness {
  if(Buffer.byteLength(raw)>DOCUMENTARY_WITNESS_BYTES)throw new Error("DOCUMENTARY_WITNESS_SIZE_LIMIT");
  const d=exact(JSON.parse(raw),["witness","mac"]),w=d.witness as DocumentaryWitness;
  if(!timingSafeEqual(mac("witness",w,key),Buffer.from(hex(d.mac),"hex")))throw new Error("DOCUMENTARY_WITNESS_AUTHENTICATION_FAILED");
  exact(w,["version","workspace","sequence","before","after","installed"]);
  if(w.version!=="14.4"||w.workspace!==root||typeof w.installed!=="boolean"||typeof w.after!=="string"||w.before!==null&&typeof w.before!=="string")throw new Error("DOCUMENTARY_WITNESS_INVALID");
  const after=decodeDocumentary(w.after,root,key),before=w.before===null?undefined:decodeDocumentary(w.before,root,key);
  if(w.sequence!==after.events.length || before&&before.operator_id!==after.operator_id || after.events.length !== (before?.events.length??0)+1 || !same(after.events.slice(0,-1),before?.events??[]))throw new Error("DOCUMENTARY_APPEND_ONLY_REQUIRED");
  return w;
}
async function privateRead(directory:string,name:string,bytes:number) {
  const raw=await readConfined(directory,name,bytes);
  if(raw!==undefined && ((await fs.stat(directory)).mode&0o077 || (await fs.stat(await safePath(directory,name))).mode&0o077))throw new Error("DOCUMENTARY_PRIVATE_FILES_REQUIRED");return raw;
}
async function keyFor(root:string) {
  const raw=await privateRead(preparationStoreRoot(root),"integrity-key",65);
  if(!raw||!/^[a-f0-9]{64}\n$/.test(raw))throw new Error("DOCUMENTARY_PREPARATION_ANCHOR_REQUIRED");return Buffer.from(raw.trim(),"hex");
}
async function stateRaw(root:string) {return privateRead(preparationStoreRoot(root),DOCUMENTARY_FILE,DOCUMENTARY_LIMITS.bytes);}
export async function loadDocumentary(root:string) {
  const key=await keyFor(root),raw=await stateRaw(root),directory=documentaryWitnessRoot(root);
  let exists=false;try{await fs.lstat(directory);exists=true;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  if(!exists){if(raw!==undefined)throw new Error("DOCUMENTARY_WITNESS_MISSING");return {key,state:undefined,witness:undefined};}
  await safePath(directory,"receipt.json");
  const witnessRaw=await privateRead(directory,"receipt.json",DOCUMENTARY_WITNESS_BYTES);
  if(!witnessRaw)throw new Error("DOCUMENTARY_WITNESS_INCOMPLETE; human inspection required");
  const witness=decodeDocumentaryWitness(witnessRaw,root,key);
  if(witness.installed && raw!==witness.after)throw new Error("DOCUMENTARY_ROLLBACK_OR_CONFLICT");
  return {key,witness,state:witness.installed?decodeDocumentary(raw!,root,key):undefined};
}
async function writeWitness(root:string,w:DocumentaryWitness,key:Buffer) {
  const raw=structured({witness:w,mac:mac("witness",w,key).toString("hex")});
  await atomicWrite(documentaryWitnessRoot(root),"receipt.json",raw,v=>decodeDocumentaryWitness(v,root,key));
  if(await privateRead(documentaryWitnessRoot(root),"receipt.json",DOCUMENTARY_WITNESS_BYTES)!==raw)throw new Error("DOCUMENTARY_WITNESS_REREAD_FAILED");
}
export async function recoverDocumentary(root:string) {
  const loaded=await loadDocumentary(root),w=loaded.witness;if(!w||w.installed)return;
  const current=await stateRaw(root);
  if((current??null)!==w.before && current!==w.after)throw new Error("DOCUMENTARY_RECOVERY_CONFLICT; human inspection required");
  if(current!==w.after)await atomicWrite(preparationStoreRoot(root),DOCUMENTARY_FILE,w.after,v=>decodeDocumentary(v,root,loaded.key));
  if(await stateRaw(root)!==w.after)throw new Error("DOCUMENTARY_INSTALL_REREAD_FAILED");
  const fd=await fs.open(preparationStoreRoot(root),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{await fd.sync();}finally{await fd.close();}
  w.installed=true;await writeWitness(root,w,loaded.key);await loadDocumentary(root);
}
/** Caller holds common lock, verifies proofs/scopes/source and stop. */
export async function commitDocumentary(root:string,next:DocumentaryState) {
  const loaded=await loadDocumentary(root);
  if(loaded.witness&&!loaded.witness.installed)throw new Error("DOCUMENTARY_RECOVERY_REQUIRED");
  const w:DocumentaryWitness={version:"14.4",workspace:root,sequence:next.events.length,before:await stateRaw(root)??null,after:encodeDocumentary(next,root,loaded.key),installed:false};
  decodeDocumentaryWitness(structured({witness:w,mac:mac("witness",w,loaded.key).toString("hex")}),root,loaded.key);
  await assertPilotNotStopped(root);
  if(!loaded.witness){
    await fs.mkdir(documentaryWitnessRoot(root),{mode:0o700});
    const fd=await fs.open(path.dirname(documentaryWitnessRoot(root)),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{await fd.sync();}finally{await fd.close();}
  }
  await assertPilotNotStopped(root);
  await writeWitness(root,w,loaded.key); // durable intent BEFORE documentary state installation
  await recoverDocumentary(root);
}
