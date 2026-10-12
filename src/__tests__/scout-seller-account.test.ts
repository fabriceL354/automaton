import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createPreparationExample } from "../../scripts/scout-v12-7-example.mjs";
import { runSellerAccount, parseAccountCommand, type AccountCommand } from "../agent/seller-account.js";
import { accountWitnessRoot, loadAccountWitness } from "../agent/seller-account-store.js";
import { runPilotPreparation, readPreparationSnapshot } from "../agent/pilot-preparation.js";
import { preparationStoreRoot, loadPreparation } from "../agent/pilot-preparation-store.js";
import { canonicalHash } from "../agent/project-model.js";
import { parseOpportunityPhases } from "../agent/research-model.js";
import { researchCandidates } from "../agent/allocation-sources.js";
import { runEconomicHandover } from "../agent/economic-handover.js";
import { runPilotReadiness } from "../agent/pilot-readiness.js";
import { runOperationalPlanning } from "../agent/operational-planning.js";
import { haltPilot } from "../agent/pilot-stop.js";
import { startControlApi } from "../agent/control-api.js";
import { TOKEN } from "./scout-control-fixtures.js";
import { initializeLedger } from "../agent/economic-ledger.js";
import { simulateFictionalScenarios } from "../agent/fictional-simulation.js";
import { createLocalWorkspaceTools } from "../agent/local-tools.js";
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));
let temp: string, root: string, at: string, input: any, research: any;
const account = (c: AccountCommand, when = at): Promise<any> => { process.env.SCOUT_MODE = "seller-account"; return runSellerAccount({ root, command: c, now: () => when }); };
const prep = (command: any = {kind:"inspect"}, when = at) => { process.env.SCOUT_MODE = "pilot-preparation"; return runPilotPreparation({root,command,now:()=>when}); };
const file = () => path.join(preparationStoreRoot(root), "state.json");
const receipt = () => path.join(accountWitnessRoot(root), "receipt.json");
const scopeCommand = (kind: "validate" | "deny" | "revoke" | "admit", r: any): AccountCommand => ({ kind, operator_id:r.scope.operator_id, account_id:r.scope.account_id, request_id:r.scope.request_id, fingerprint:r.fingerprint });
async function initialize() { return account({kind:"initialize"}); }
async function declare(kind: "declare" | "new-declaration" = "declare") {
  const h=await initialize();
  return account({kind,operator_id:h.operator_id,opportunity_id:input.dossiers[0].opportunity_id,dossier_hash:canonicalHash(input.dossiers[0]),platform:"etsy"});
}
async function validated() { const d=await declare(), r=d.accounts.at(-1); return (await account(scopeCommand("validate",r))).accounts.at(-1); }
async function admitted() { const r=await validated(); await account(scopeCommand("admit",r)); return r; }
function child(c: AccountCommand) {
  return new Promise<{code:number|null;out:string}>((resolve,reject)=>{
    const p=spawn(process.execPath,["src/__tests__/fixtures/account-child.mjs",root,JSON.stringify(c),at],{cwd:process.cwd(),env:{...process.env,SCOUT_MODE:"seller-account"},stdio:["ignore","pipe","pipe"]});
    let out=""; p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>out+=d);
    const timer=setTimeout(()=>{p.kill("SIGKILL");reject(new Error("Child deadline exceeded"));},15000);
    p.on("error",e=>{clearTimeout(timer);reject(e);});p.on("close",code=>{clearTimeout(timer);resolve({code,out});});
  });
}
beforeEach(async()=>{
  vi.stubEnv("SCOUT_MODE","seller-account");
  temp=await fs.mkdtemp(path.join(os.tmpdir(),"scout-account-test-"));root=path.join(temp,"workspace");
  await createPreparationExample(root);
  research=JSON.parse(await fs.readFile(path.join(root,"research.json"),"utf8"));
  const old=research.opportunities[0];
  research.opportunities[0]=parseOpportunityPhases({name:old.name,kind:old.kind,source_index:0},
    JSON.stringify({summary:old.summary,estimated_cost_cents:old.estimated_cost_cents,cost_basis:old.cost_basis,human_minutes_daily:old.human_minutes_daily,account_required:true}),
    JSON.stringify({market:old.market,platform:"Etsy",fees:old.fees,quote:old.evidence.quote}),
    JSON.stringify({risks:old.risks,reason_surfaced:old.reason_surfaced,mini_test_possible:old.mini_test.possible,mini_test_cost_cents:old.mini_test.estimated_cost_cents,mini_test_description:old.mini_test.description}),research.evidence,0);
  await fs.writeFile(path.join(root,"research.json"),JSON.stringify(research));
  input=JSON.parse(await fs.readFile(path.join(root,"pilot-preparation-input.json"),"utf8"));
  const candidates=researchCandidates(JSON.stringify(research));
  input.dossiers.forEach((d:any,i:number)=>{d.candidate_fingerprint=candidates[i].fingerprint;d.fictional=false;});
  await fs.writeFile(path.join(root,"pilot-preparation-input.json"),JSON.stringify(input));
  at=new Date(Date.now()+1000).toISOString();await prep({kind:"prepare"});
});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(temp,{recursive:true,force:true});});
describe("V14.3 local declaration, exact human validation and admission",()=>{
  it("preserves account_required and blocks initial admission",async()=>{
    const p=await prep();expect(p.projects).toHaveLength(1);expect(p.projects[0].candidate.opportunity_id).not.toBe(input.dossiers[0].opportunity_id);
    expect(JSON.parse(await fs.readFile(path.join(root,"research.json"),"utf8")).opportunities[0].account_required).toBe(true);
  });
  it("creates an opaque declaration and distinct pending validation",async()=>{
    const d=await declare();expect(d.accounts[0].state).toBe("pending");expect(d.accounts[0].scope.account_id).toMatch(/^account-/);
    expect(d.ownership_independently_verified).toBe(false);expect(d.full_restore_protected).toBe(false);
    expect((await prep()).projects).toHaveLength(1);
  });
  it("requires explicit validation then separate explicit admission",async()=>{
    const d=await declare(),r=d.accounts[0];await expect(account(scopeCommand("admit",r))).rejects.toThrow("VALIDATION_REQUIRED");
    await account(scopeCommand("validate",r));expect((await prep()).projects).toHaveLength(1);
    await account(scopeCommand("admit",r));const p=await prep();expect(p.projects).toHaveLength(2);expect(p.total_preparation_reserved_cents).toBe(2000);
    expect(p.projects.find(p=>p.account_validation)?.requests.every(r=>r.status==="pending")).toBe(true);
    expect(p.projects.find(p=>p.account_validation)?.blockers).toContain("ACCOUNT_PREPARATION_ONLY_EXECUTION_FORBIDDEN");
    expect(p.projects.find(p=>p.account_validation)?.action_authorized).toBe(false);
  });
  it.each(["operator_id","account_id","request_id","fingerprint"])("rejects substituted %s",async field=>{
    const r=(await declare()).accounts[0],c:any=scopeCommand("validate",r);
    c[field]=field==="fingerprint"?"f".repeat(64):`${field==="request_id"?"account-validation":field.slice(0,-3)}-${randomUUID()}`;
    await expect(account(c)).rejects.toThrow();expect((await account({kind:"inspect"})).accounts[0].state).toBe("pending");
  });
  it.each(["payhip","itch-io"])("rejects another platform %s",async platform=>{
    const i=await initialize();await expect(account({kind:"declare",operator_id:i.operator_id,opportunity_id:input.dossiers[0].opportunity_id,dossier_hash:canonicalHash(input.dossiers[0]),platform})).rejects.toThrow("PLATFORM_SCOPE");
  });
  it("rejects unknown candidate and another dossier",async()=>{
    const i=await initialize();const c:any={kind:"declare",operator_id:i.operator_id,opportunity_id:"research-opportunity-3",dossier_hash:canonicalHash(input.dossiers[0]),platform:"etsy"};
    await expect(account(c)).rejects.toThrow("DOSSIER");await expect(account({...c,opportunity_id:input.dossiers[0].opportunity_id,dossier_hash:"f".repeat(64)})).rejects.toThrow("DOSSIER");
  });
  it("rejects declaration without an initialized human operator",async()=>{
    await expect(account({kind:"declare",operator_id:`operator-${randomUUID()}`,opportunity_id:input.dossiers[0].opportunity_id,dossier_hash:canonicalHash(input.dossiers[0]),platform:"etsy"})).rejects.toThrow("OPERATOR");
  });
  it("rejects validation with no declared account",async()=>{
    const h=await initialize();await expect(account({kind:"validate",operator_id:h.operator_id,account_id:`account-${randomUUID()}`,request_id:`account-validation-${randomUUID()}`,fingerprint:"a".repeat(64)})).rejects.toThrow("SCOPE");
  });
  it("declaration retries are receipts and never renew validation",async()=>{
    const first=await declare(),raw=await fs.readFile(file(),"utf8");const second=await declare();expect(second.accounts).toEqual(first.accounts);expect(await fs.readFile(file(),"utf8")).toBe(raw);
  });
  it("duplicate validation is terminal",async()=>{
    const r=await validated();await expect(account(scopeCommand("validate",r))).rejects.toThrow("TERMINAL");
  });
  it("denial cannot be converted into validation",async()=>{
    const r=(await declare()).accounts[0];await account(scopeCommand("deny",r));await expect(account(scopeCommand("validate",r))).rejects.toThrow("TERMINAL");
  });
  it("revocation is preserved and blocks approval, admission and replay",async()=>{
    const r=await admitted();await account(scopeCommand("revoke",r));const p=await prep();expect(p.projects.find(p=>p.account_validation)?.blockers).toContain("ACCOUNT_VALIDATION_REVOKED");
    await expect(account(scopeCommand("validate",r))).rejects.toThrow("TERMINAL");await expect(account(scopeCommand("admit",r))).rejects.toThrow("VALIDATION_REQUIRED");
  });
  it("expired validation is reported and rejected immediately",async()=>{
    const r=await admitted(),when=r.scope.expires_at;expect((await account({kind:"inspect"},when)).accounts[0].state).toBe("expired");
    expect((await prep({kind:"inspect"},when)).projects.find(p=>p.account_validation)?.blockers).toContain("ACCOUNT_VALIDATION_EXPIRED");
    await expect(account(scopeCommand("admit",r),when)).rejects.toThrow();
  });
  it("explicit replacement declaration has a new ID; revoked request stays terminal",async()=>{
    const r=await validated();await account(scopeCommand("revoke",r));const d=await declare("new-declaration");expect(d.accounts).toHaveLength(2);expect(d.accounts[1].scope.account_id).not.toBe(r.scope.account_id);expect(d.accounts[1].state).toBe("pending");
    await expect(account(scopeCommand("validate",r))).rejects.toThrow("TERMINAL");
  });
  it("conservative admission refuses an existing supervision plan",async()=>{
    process.env.SCOUT_MODE="pilot-readiness";await runPilotReadiness({root,command:{kind:"prepare-handover"},now:()=>at});
    const r=await validated();await expect(account(scopeCommand("admit",r))).rejects.toThrow("AFTER_SUPERVISION");
  });
  it("changed source and missing evidence never admit a project",async()=>{
    const r=await validated();await fs.unlink(path.join(root,input.dossiers[0].proofs[0].file));await expect(account(scopeCommand("admit",r))).rejects.toThrow("MISSING_EVIDENCE");
    await fs.writeFile(path.join(root,"research.json"),JSON.stringify({...research,status:"INSUFFICIENT_EVIDENCE"}));await expect(account(scopeCommand("admit",r))).rejects.toThrow();
  });
});
describe("V14.3 preserved witness and crash protocol",()=>{
  it("detects revoked account state restored to earlier valid state",async()=>{
    const r=await validated(),old=await fs.readFile(file(),"utf8");await account(scopeCommand("revoke",r));await fs.writeFile(file(),old);
    await expect(account(scopeCommand("admit",r))).rejects.toThrow("ROLLBACK");await expect(prep()).rejects.toThrow("ROLLBACK");await expect(account({kind:"recover"})).rejects.toThrow("ROLLBACK");
  });
  it("detects restored account-project action authorizations",async()=>{
    await admitted();const p=(await prep()).projects.find(p=>p.account_validation)!,r=p.requests[0],old=await fs.readFile(file(),"utf8");
    await prep({kind:"approve",project_id:p.project_id,action_id:r.action_id,request_id:r.request_id,fingerprint:r.fingerprint});await fs.writeFile(file(),old);await expect(prep()).rejects.toThrow("ROLLBACK");
  });
  it("documents the accepted limit: restoring state AND witness restores old validation",async()=>{
    const r=await validated(),old=await fs.readFile(file(),"utf8"),w=await fs.readFile(receipt(),"utf8");await account(scopeCommand("revoke",r));await fs.writeFile(file(),old);await fs.writeFile(receipt(),w);
    const restored=await account({kind:"inspect"});expect(restored.accounts[0].state).toBe("validated");expect(restored.full_restore_protected).toBe(false);
  });
  it("detects a preserved witness even if preparation returns to pre-initialization",async()=>{
    const old=await fs.readFile(file(),"utf8");await initialize();await fs.writeFile(file(),old);await expect(account({kind:"initialize"})).rejects.toThrow("ROLLBACK");
  });
  it("refuses missing witness without resetting",async()=>{
    await initialize();await fs.rm(accountWitnessRoot(root),{recursive:true});await expect(account({kind:"initialize"})).rejects.toThrow("WITNESS_MISSING");await expect(prep()).rejects.toThrow("WITNESS_MISSING");
  });
  it("refuses an older witness against newer state",async()=>{
    await declare();const old=await fs.readFile(receipt(),"utf8");const r=(await account({kind:"inspect"})).accounts[0];await account(scopeCommand("validate",r));await fs.writeFile(receipt(),old);await expect(account({kind:"inspect"})).rejects.toThrow("ROLLBACK");
  });
  it("refuses incomplete initial witness latch",async()=>{
    await fs.mkdir(accountWitnessRoot(root),{mode:0o700});await expect(account({kind:"initialize"})).rejects.toThrow("INCOMPLETE");
  });
  it.each(["witness","history"])("refuses falsified %s",async target=>{
    await declare();const f=target==="witness"?receipt():file(),d=JSON.parse(await fs.readFile(f,"utf8"));
    if(target==="witness")d.witness.sequence++;else d.state.seller_accounts.events.pop();await fs.writeFile(f,JSON.stringify(d));await expect(account({kind:"inspect"})).rejects.toThrow(/AUTHENTICATION|authentication/);
  });
  it("interruption BEFORE durable witness commit preserves prior authorization",async()=>{
    const r=(await declare()).accounts[0],old=await fs.readFile(file(),"utf8"),rename=fs.rename;
    const spy=vi.spyOn(fs,"rename").mockImplementation(async(a,b)=>{if(String(b)===receipt())throw new Error("interrupted before commit");return rename(a,b);});
    await expect(account(scopeCommand("validate",r))).rejects.toThrow();spy.mockRestore();expect(await fs.readFile(file(),"utf8")).toBe(old);expect((await account({kind:"inspect"})).accounts[0].state).toBe("pending");
  });
  it.each(["before-state","after-state","after-install"])("restarts and recovers committed %s interruption exactly once",async stage=>{
    const r=(await declare()).accounts[0],rename=fs.rename;let receiptWrites=0;
    const spy=vi.spyOn(fs,"rename").mockImplementation(async(a,b)=>{
      if(String(b)===receipt()&&++receiptWrites===2&&stage==="after-install")throw new Error("installation ACK lost");
      if(String(b)===file()&&stage==="before-state")throw new Error("state not installed");
      await rename(a,b);if(String(b)===file()&&stage==="after-state")throw new Error("state installed ACK lost");
    });
    await expect(account(scopeCommand("validate",r))).rejects.toThrow();spy.mockRestore();await expect(prep()).rejects.toThrow("RECOVERY_REQUIRED");
    expect((await account({kind:"inspect"})).status).toBe("COMMITTED_RECOVERY_REQUIRED");
    const result=await child({kind:"recover"});expect(result.code).toBe(0);expect(JSON.parse(result.out).accounts[0].state).toBe("validated");
    const raw=await fs.readFile(file(),"utf8");await account({kind:"recover"});expect(await fs.readFile(file(),"utf8")).toBe(raw);expect((await loadAccountWitness(root)).witness?.installed).toBe(true);
  });
  it("recovery refuses an unexpected third state",async()=>{
    const r=(await declare()).accounts[0],rename=fs.rename;
    const spy=vi.spyOn(fs,"rename").mockImplementation(async(a,b)=>{if(String(b)===file())throw new Error("interrupt");return rename(a,b);});
    await expect(account(scopeCommand("validate",r))).rejects.toThrow();spy.mockRestore();await fs.writeFile(file(),"unexpected");await expect(account({kind:"recover"})).rejects.toThrow("CONFLICT");expect(await fs.readFile(file(),"utf8")).toBe("unexpected");
  });
  it("serializes competing real processes without duplicate validation",async()=>{
    const r=(await declare()).accounts[0],c=scopeCommand("validate",r);const outcomes=await Promise.all([child(c),child(c)]);
    expect(outcomes.filter(o=>o.code===0)).toHaveLength(1);expect((await account({kind:"inspect"})).audit.filter((e:any)=>e.kind==="validate")).toHaveLength(1);
  });
  it.each(["symlink","hardlink"])("refuses %s witness",async kind=>{
    await initialize();const copy=path.join(temp,"copy");await fs.rename(receipt(),copy);if(kind==="symlink")await fs.symlink(copy,receipt());else await fs.link(copy,receipt());await expect(account({kind:"inspect"})).rejects.toThrow();
  });
});
describe("V14.3 isolation and absence of execution",()=>{
  it.each(["--pay","--publish","--start","--execute","--login","--open-account","--approve-all"])("rejects %s",flag=>expect(()=>parseAccountCommand([flag])).toThrow("FORBIDDEN"));
  it.each(["password","Bearer secret","session-cookie","api-key","123456","seller@example.com","https://etsy.com/shop/me"])("has no accepting field for secret/login input %s",secret=>{
    expect(()=>parseAccountCommand(["--declare",`operator-${randomUUID()}`,input.dossiers[0].opportunity_id,canonicalHash(input.dossiers[0]),secret])).toThrow();
  });
  it("rejects extra secret fields instead of persisting them",async()=>{
    await expect(account({kind:"initialize",password:"secret"} as any)).rejects.toThrow();expect((await loadPreparation(root)).state?.seller_accounts).toBeUndefined();
  });
  it("does not connect, pay, publish or alter V5 even after admission",async()=>{
    const fetch=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("network forbidden")),ledger=await fs.readFile(path.join(root,"economic-ledger.json"),"utf8");
    await admitted();expect(fetch).not.toHaveBeenCalled();expect(await fs.readFile(path.join(root,"economic-ledger.json"),"utf8")).toBe(ledger);
    expect(await fs.readdir(root)).not.toContain("external-action.json");expect(await fs.readdir(root)).not.toContain("projects.json");
  });
  it("stop blocks new validation but still permits protective revocation",async()=>{
    const r=await validated();await haltPilot(root,"operator-stop",at);await expect(account(scopeCommand("admit",r))).rejects.toThrow("EMERGENCY_STOP");
    expect((await account(scopeCommand("revoke",r))).accounts[0].state).toBe("revoked");
  });
  it("V12.8 and V13 remain non-executable on an admitted account dossier",async()=>{
    const r=await admitted();process.env.SCOUT_MODE="pilot-readiness";const readiness=await runPilotReadiness({root,command:{kind:"prepare-handover"},now:()=>at});expect(readiness.execution_allowed).toBe(false);
    process.env.SCOUT_MODE="operational-planning";const report=await runOperationalPlanning({root,command:{kind:"plan"},now:()=>at});expect(report.execution_allowed).toBe(false);
    const p=(await prep()).projects.find(p=>p.account_validation)!;process.env.SCOUT_MODE="economic-handover";await expect(runEconomicHandover({root,command:{kind:"prepare",project_id:p.project_id,dossier_hash:p.dossier_hash},now:()=>at})).rejects.toThrow("DOSSIER_BLOCKED");
    await account(scopeCommand("revoke",r));
  });
  it("model tools cannot write account history, approvals, or separate witness",async()=>{
    await initialize();const tools=createLocalWorkspaceTools(root),write=tools.find(t=>t.name==="write_file")!;
    expect(await write.execute({path:"../"+path.basename(accountWitnessRoot(root))+"/receipt.json",content:"changed"} as any)).toMatch(/ERROR/);
    expect(await write.execute({path:"pilot-preparation-input.json",content:"changed"} as any)).toMatch(/ERROR/);
  });
  it("validates sources again immediately before commit and rejects clock rollback",async()=>{
    const r=(await declare()).accounts[0];let calls=0;process.env.SCOUT_MODE="seller-account";
    await expect(runSellerAccount({root,command:scopeCommand("validate",r),now:()=>++calls===1?at:new Date(Date.parse(at)-1).toISOString()})).rejects.toThrow("CLOCK_ROLLBACK");expect((await account({kind:"inspect"})).accounts[0].state).toBe("pending");
  });
});

describe("V14.3 additional safety boundaries",()=>{
  it.each([1000,1500])("admits at most one of two 10-EUR requests with %s cents actually available in bookkeeping",async cents=>{
    // Rebuild only this disposable fixture before account initialization.
    await fs.rm(preparationStoreRoot(root),{recursive:true});
    for(const [i,o] of research.opportunities.entries()) {
      research.opportunities[i]=parseOpportunityPhases({name:o.name,kind:o.kind,source_index:i},
        JSON.stringify({summary:o.summary,estimated_cost_cents:o.estimated_cost_cents,cost_basis:o.cost_basis,human_minutes_daily:o.human_minutes_daily,account_required:true}),
        JSON.stringify({market:o.market,platform:"Etsy",fees:o.fees,quote:o.evidence.quote}),
        JSON.stringify({risks:o.risks,reason_surfaced:o.reason_surfaced,mini_test_possible:o.mini_test.possible,mini_test_cost_cents:o.mini_test.estimated_cost_cents,mini_test_description:o.mini_test.description}),research.evidence,i);
    }
    const candidates=researchCandidates(JSON.stringify(research));input.dossiers.forEach((d:any,i:number)=>d.candidate_fingerprint=candidates[i].fingerprint);
    await fs.writeFile(path.join(root,"research.json"),JSON.stringify(research));await fs.writeFile(path.join(root,"pilot-preparation-input.json"),JSON.stringify(input));
    await fs.writeFile(path.join(root,"economic-ledger.json"),JSON.stringify(initializeLedger(cents)));
    await prep({kind:"prepare"});const a=await validated();await account(scopeCommand("admit",a));
    const operator=(await initialize()).operator_id,d=input.dossiers[1];
    const second=await account({kind:"declare",operator_id:operator,opportunity_id:d.opportunity_id,dossier_hash:canonicalHash(d),platform:"etsy"});
    const r=second.accounts.at(-1);await account(scopeCommand("validate",r));await expect(account(scopeCommand("admit",r))).rejects.toThrow(/CAPACITY|BUDGET/);
    expect((await prep()).total_preparation_reserved_cents).toBe(1000);expect((await prep()).capital_is_bank_balance).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(root,"economic-ledger.json"),"utf8")).available_balance_cents).toBe(cents);
  });
  it("an explicit admission retry creates no extra earmark",async()=>{
    const r=await admitted(),raw=await fs.readFile(file(),"utf8");await account(scopeCommand("admit",r));expect(await fs.readFile(file(),"utf8")).toBe(raw);expect((await prep()).total_preparation_reserved_cents).toBe(2000);
  });
  it("account revocation prevents positive V12.7 decisions but permits denial",async()=>{
    const a=await admitted(),p=(await prep()).projects.find(p=>p.account_validation)!,r=p.requests[0];await account(scopeCommand("revoke",a));
    const c={kind:"approve",project_id:p.project_id,action_id:r.action_id,request_id:r.request_id,fingerprint:r.fingerprint};await expect(prep(c)).rejects.toThrow("ACCOUNT_VALIDATION_NOT_CURRENT");
    const v=await prep({...c,kind:"deny"});expect(v.projects.find(p=>p.account_validation)?.requests[0].status).toBe("denied");
  });
  it("records revocation even after expiry, retaining all earlier events",async()=>{
    const r=await validated();const v=await account(scopeCommand("revoke",r),r.scope.expires_at);expect(v.accounts[0].state).toBe("revoked");expect(v.audit.map((e:any)=>e.kind)).toEqual(["declare","validate","revoke"]);
  });
  it("rejects a different OS owner",async()=>{
    await initialize();const original=process.getuid!();const spy=vi.spyOn(process,"getuid").mockReturnValue(original+1);await expect(account({kind:"initialize"})).rejects.toThrow("OPERATOR");spy.mockRestore();
  });
  it("validates expiration at the final decision commit",async()=>{
    const r=(await declare()).accounts[0];let calls=0;process.env.SCOUT_MODE="seller-account";
    await expect(runSellerAccount({root,command:scopeCommand("validate",r),now:()=>++calls===1?at:r.scope.expires_at})).rejects.toThrow("EXPIRED_BEFORE_COMMIT");
    expect((await account({kind:"inspect"})).accounts[0].state).toBe("pending");
  });
  it("refuses incomplete arguments, unknown fields and a non-explicit mode",async()=>{
    expect(()=>parseAccountCommand(["--declare"])).toThrow();process.env.SCOUT_MODE="local";await expect(runSellerAccount({root,command:{kind:"initialize"}})).rejects.toThrow("Explicit SCOUT_MODE");
  });
  it("a killed process leaves a blocking lock and recover installs only its durable intent",async()=>{
    const r=(await declare()).accounts[0];process.env.SCOUT_MODE="seller-account";
    const p=spawn(process.execPath,["src/__tests__/fixtures/account-child.mjs",root,JSON.stringify(scopeCommand("validate",r)),at,"pause-state"],{cwd:process.cwd(),env:{...process.env,SCOUT_MODE:"seller-account"},stdio:["ignore","pipe","pipe","ipc"]});
    let exited=false;const exit=new Promise<number|null>(resolve=>p.on("exit",code=>{exited=true;resolve(code);}));
    try {
      await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Crash fixture deadline")),15000);p.on("message",m=>{if(m==="PAUSED"){clearTimeout(timer);resolve();}});p.on("error",e=>{clearTimeout(timer);reject(e);});});
      expect((await loadAccountWitness(root)).witness?.installed).toBe(false);
      p.kill("SIGKILL");await exit;expect(exited).toBe(true);
      await expect(account({kind:"recover"})).rejects.toThrow("stale lock");
      // Test-only manual removal AFTER the child is confirmed dead, in a temp fixture.
      await fs.unlink(path.join(root,".economic-ledger.lock"));
      const recovered=await child({kind:"recover"});expect(recovered.code).toBe(0);expect(JSON.parse(recovered.out).accounts[0].state).toBe("validated");
    } finally {if(!exited){p.kill("SIGKILL");await exit;}}
  });
  it("V14.1 pure simulation leaves account and witness byte-identical",async()=>{
    await admitted();const state=await fs.readFile(file(),"utf8"),w=await fs.readFile(receipt(),"utf8");
    const result=simulateFictionalScenarios({version:"14.1",kind:"FICTIONAL_SIMULATION",currency:"EUR",scenarios:[{scenario_id:"synthetic",budget_cents:1000,fixed_cost_cents:500,unit_cost_cents:0,unit_price_cents:300,units:2}]});
    expect(result.fictional).toBe(true);expect(result.real_evidence).toBe(false);expect(result.execution_allowed).toBe(false);
    expect(await fs.readFile(file(),"utf8")).toBe(state);expect(await fs.readFile(receipt(),"utf8")).toBe(w);
  });
  it("keeps V14.2 exact transfers working on historical dossiers with the witness initialized",async()=>{
    // Separate ordinary V12.7 fixture, with no account_required candidates.
    const historical=path.join(temp,"historical");await createPreparationExample(historical);
    const oldInput=JSON.parse(await fs.readFile(path.join(historical,"pilot-preparation-input.json"),"utf8"));oldInput.dossiers.forEach((d:any)=>d.fictional=false);
    await fs.writeFile(path.join(historical,"pilot-preparation-input.json"),JSON.stringify(oldInput));process.env.SCOUT_MODE="pilot-preparation";
    const v=await runPilotPreparation({root:historical,command:{kind:"prepare"},now:()=>new Date().toISOString()});
    for(const p of v.projects){
      await runPilotPreparation({root:historical,command:{kind:"review",project_id:p.project_id,dossier_hash:p.dossier_hash,quote_cents:1000,cost_proof_id:p.dossier.proofs[0].proof_id},now:()=>new Date().toISOString()});
      for(const r of p.requests)await runPilotPreparation({root:historical,command:{kind:"approve",project_id:p.project_id,action_id:r.action_id,request_id:r.request_id,fingerprint:r.fingerprint},now:()=>new Date().toISOString()});
    }
    process.env.SCOUT_MODE="pilot-readiness";await runPilotReadiness({root:historical,command:{kind:"prepare-handover"},now:()=>new Date().toISOString()});
    process.env.SCOUT_MODE="seller-account";await runSellerAccount({root:historical,command:{kind:"initialize"},now:()=>new Date().toISOString()});
    for(const p of v.projects){
      process.env.SCOUT_MODE="economic-handover";
      const prepared=await runEconomicHandover({root:historical,command:{kind:"prepare",project_id:p.project_id,dossier_hash:p.dossier_hash},now:()=>new Date().toISOString()});
      const r=prepared.requests.at(-1)!;const c={project_id:p.project_id,dossier_hash:p.dossier_hash,request_id:r.scope.request_id,fingerprint:r.fingerprint};
      await runEconomicHandover({root:historical,command:{kind:"approve",...c},now:()=>new Date().toISOString()});
      const result=await runEconomicHandover({root:historical,command:{kind:"transfer",...c},now:()=>new Date().toISOString()});expect(result.execution_allowed).toBe(false);
    }
    process.env.SCOUT_MODE="seller-account";expect((await runSellerAccount({root:historical,command:{kind:"inspect"},now:()=>new Date().toISOString()})).initialized).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(historical,"economic-ledger.json"),"utf8")).reserved_balance_cents).toBe(2000);
  });
});

describe("V14.3 HTTP and terminal stop boundary",()=>{
  it("exposes no HTTP route for accounts and preserves local preparation decision refusal",async()=>{
    const r=await admitted(),state=await fs.readFile(file(),"utf8"),w=await fs.readFile(receipt(),"utf8");
    process.env.SCOUT_MODE="control-api";const api=await startControlApi({root,env:{SCOUT_CONTROL_API_PORT:"0",SCOUT_CONTROL_API_TOKEN:TOKEN}});
    try {
      for(const endpoint of ["/v1/accounts/declare","/v1/accounts/validate","/v1/accounts/admit","/v1/accounts/recover"]){
        const response=await fetch(api.url+endpoint,{method:"POST",headers:{authorization:`Bearer ${TOKEN}`,"content-type":"application/json"},body:"{}"});expect(response.status).toBe(404);await response.text();
      }
      const response=await fetch(api.url+`/v1/approvals/${r.scope.request_id}/approve`,{method:"POST",headers:{authorization:`Bearer ${TOKEN}`,"content-type":"application/json"},body:"{}"});expect([400,409]).toContain(response.status);await response.text();
      expect(await fs.readFile(file(),"utf8")).toBe(state);expect(await fs.readFile(receipt(),"utf8")).toBe(w);
    } finally {await api.close();}
  });
  it("a stop arriving after durable intent remains terminal and never returns permission",async()=>{
    const r=(await declare()).accounts[0],rename=fs.rename;let stopped=false;
    const spy=vi.spyOn(fs,"rename").mockImplementation(async(a,b)=>{
      await rename(a,b);
      if(String(b)===receipt()&&!stopped){stopped=true;await haltPilot(root,"operator-stop",at);}
    });
    await expect(account(scopeCommand("validate",r))).rejects.toThrow("EMERGENCY_STOP");spy.mockRestore();
    const v=await account({kind:"inspect"});expect(v.execution_allowed).toBe(false);await expect(account(scopeCommand("admit",r))).rejects.toThrow("EMERGENCY_STOP");
  });
});
