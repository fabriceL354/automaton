import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { runPilotReadiness, stopPilotReadiness, parseReadinessCommand, renderReadinessReport } from "../agent/pilot-readiness.js";
import { runPilotPreparation, preparationControlView } from "../agent/pilot-preparation.js";
import { loadPreparation, preparationStoreRoot, decodePreparation } from "../agent/pilot-preparation-store.js";
import { pilotStopRoot } from "../agent/pilot-stop.js";
import { buildHandoverPlan, validateSupervision } from "../agent/pilot-readiness-model.js";
import { readAllocationSources } from "../agent/allocation-sources.js";
import { initializeLedger, reserveExperiment, recordAuthorizedEvent } from "../agent/economic-ledger.js";
import { runLedgerScout } from "../agent/ledger-runner.js";
import { createLocalWorkspaceTools } from "../agent/local-tools.js";
import { inMode, plan, projectFixture, projectCommand, TOKEN } from "./scout-control-fixtures.js";
import { startControlApi } from "../agent/control-api.js";
import { createPreparationExample } from "../../scripts/scout-v12-7-example.mjs";
let temp: string, root: string;
const prep = (command: any = { kind: "prepare" }, now?: string) => inMode("pilot-preparation", () => runPilotPreparation({ root, command, ...(now ? { now: () => now } : {}) }));
const run = (command: any = { kind: "prepare-handover" }, now?: string) => inMode("pilot-readiness", () => runPilotReadiness({ root, command, ...(now ? { now: () => now } : {}) }));
const stop = (command: any = { kind: "halt", reason: "operator-stop" }) => inMode("pilot-readiness", () => stopPilotReadiness({ root, command }));
const read = (file: string) => fs.readFile(path.join(root, file), "utf8");
const stateRaw = () => fs.readFile(path.join(preparationStoreRoot(root), "state.json"), "utf8");
const scope = (p: any) => ({ project_id: p.project_id, dossier_hash: p.dossier_hash, action_id: p.requests[0].action_id, request_id: p.requests[0].request_id, fingerprint: p.requests[0].fingerprint });
async function edit(change: (d: any) => void) { const d = JSON.parse(await read("pilot-preparation-input.json")); change(d); await fs.writeFile(path.join(root, "pilot-preparation-input.json"), JSON.stringify(d)); }
async function authorize() {
  // Synthetic test only: exercises the non-fictional decision path, no real project.
  await edit(d => d.dossiers.forEach((p: any) => { p.fictional = false; }));
  const p = (await prep()).projects[0], r = p.requests[0];
  await prep({ kind: "review", project_id: p.project_id, dossier_hash: p.dossier_hash, quote_cents: 1000, cost_proof_id: p.dossier.proofs[0].proof_id });
  await prep({ kind: "approve", project_id: p.project_id, action_id: r.action_id, request_id: r.request_id, fingerprint: r.fingerprint });
  return p;
}
function child(operation = "prepare-handover", held?: (p: ReturnType<typeof spawn>) => Promise<void>) {
  return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    const p = spawn(process.execPath, ["src/__tests__/fixtures/readiness-child.mjs", root, operation], { cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let out = ""; p.stdout!.on("data", d => { out += d; }); p.stderr!.on("data", d => { out += d; });
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("Readiness child exceeded 15-second deadline")); }, 15000);
    p.on("message", async message => { if (message === "LOCK_HELD" && held) { try { await held(p); p.send("CONTINUE"); } catch (e) { p.kill("SIGKILL"); clearTimeout(timer); reject(e); } } });
    p.on("error", e => { clearTimeout(timer); reject(e); }); p.on("close", code => { clearTimeout(timer); resolve({ code, out }); });
  });
}
beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-readiness-test-")); root = path.join(temp, "workspace"); await createPreparationExample(root); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(temp, { recursive: true, force: true }); });
describe("V12.8 exact, non-executable handover", () => {
  it("requires the existing prepared V12.7 batch", async () => { await expect(run()).rejects.toThrow("V12.7"); });
  it("retains exactly two earmarks and never writes any V5/V9 transfer", async () => {
    const ledger = await read("economic-ledger.json"); await prep(); const r = await run();
    expect(r.handover).toMatchObject({ executable: false, financial_transfer_performed: false, current_preparation_earmarked_cents: 2000, current_total_exposure_cents: 2000, proposed_total_exposure_after_atomic_reclassification_cents: 2000, bank_balance_cents: null });
    expect(r.handover.lines).toHaveLength(2); expect(r.handover.lines.every(l => l.additional_exposure_cents === 0 && l.current_v5_reservation_cents === 0 && l.target_v9_project_id === null)).toBe(true);
    expect(await read("economic-ledger.json")).toBe(ledger); expect(await fs.readdir(root)).not.toContain("project-batch.json");
    expect(r.projects.every(p => !p.ready_for_real_launch && p.blockers.includes("ATOMIC_HANDOVER_NOT_IMPLEMENTED"))).toBe(true);
  });
  it("repeating or restarting cannot duplicate an earmark or handover event", async () => {
    await prep(); expect((await child()).code).toBe(0); const before = await stateRaw(); expect((await child()).code).toBe(0);
    expect(await stateRaw()).toBe(before); expect((await run({ kind: "report" })).audit).toHaveLength(1);
  });
  it("reports without initializing, renewing or mutating history", async () => {
    await prep(); const before = await stateRaw(); const r = await run({ kind: "report" });
    expect(r.handover_prepared).toBe(false); expect(r.projects[0].blockers).toContain("HANDOVER_NOT_PREPARED"); expect(await stateRaw()).toBe(before);
  });
  it("accounts for historical standalone V5 commitments, even released ones", async () => {
    let ledger = reserveExperiment(initializeLedger(10000), { ...plan, opportunity_name: "Old standalone", experiment_budget_eur: 1, requires_real_spending: true });
    const id = ledger.entries[1].experiment!.id;
    ledger = recordAuthorizedEvent(ledger, { type: "release", experiment_id: id, amount_cents: 100, description: "Released in fixture", authorization: { source: "human", reference: "fixture-release" } });
    await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(ledger));
    await prep(); const r = await run();
    expect(r.handover.standalone_v5_commitment_count).toBe(1); expect(r.handover.capacity_blockers).toContain("PROJECT_LIMIT_EXCEEDED");
    expect(r.handover.current_total_exposure_cents).toBe(2000);
  });
  it("counts the same V9/V5 reservation once and includes historical expenses", async () => {
    const p = await projectFixture(root);
    await projectCommand(root, "--approve-project", p.plan.project_id, "--experiment-id", p.experiment_id, "--request-id", p.approval.request.request_id);
    await projectCommand(root, "--start-project", p.plan.project_id, "--experiment-id", p.experiment_id, "--request-id", p.approval.request.request_id);
    await projectCommand(root, "--close-experiment", p.plan.project_id, "--experiment-id", p.experiment_id, "--request-id", p.approval.request.request_id, "--expense-cents", "300", "--revenue-cents", "0", "--classification", "inconclusive", "--asset-policy", "retire");
    await prep(); const r = await run();
    expect(r.handover.historical_project_count).toBe(1); expect(r.handover.standalone_v5_commitment_count).toBe(0);
    expect(r.handover.historical_recorded_expense_cents).toBe(300); expect(r.handover.current_total_exposure_cents).toBe(1300);
  });
  it("does not reserve again for a planned V9 project", async () => {
    const b = (await projectCommand(root, "--create-batch")).batch.batch_id;
    await projectCommand(root, "--create-project", b, "--name", "Existing plan", "--hypothesis", "Fixture", "--budget-cents", "1000", "--duration-days", "7");
    await prep(); const r = await run(); expect(r.handover.historical_v9_unreserved_planned_cents).toBe(1000); expect(r.handover.current_total_exposure_cents).toBe(2000);
  });
  it("flags a possible historical name collision instead of guessing ownership", async () => {
    await prep(); const loaded = await loadPreparation(root), sources = await readAllocationSources(root, "research.json");
    sources.financial.ledger = reserveExperiment(sources.financial.ledger, { ...plan, opportunity_name: loaded.state!.projects[0].candidate.title, experiment_budget_eur: 1, requires_real_spending: true });
    const r = buildHandoverPlan(sources, loaded.state!.projects);
    expect(r.capacity_blockers).toContain("POSSIBLE_DUPLICATE_HISTORICAL_COMMITMENT"); expect(r.capacity_blockers).toContain("SPENDING_CEILING_EXCEEDED");
  });
});
describe("V12.8 supervision and exact authorization checks", () => {
  it("requires explicit mode and refuses aliases/additional command fields", async () => {
    await expect(runPilotReadiness({ root, command: { kind: "report" } })).rejects.toThrow("Explicit");
    expect(() => parseReadinessCommand(["xxreport"])).toThrow(); await expect(run({ kind: "report", execute: true })).rejects.toThrow();
  });
  it.each(["--pay", "--execute", "--transfer", "--start", "--resume", "--publish", "--open-account", "--confirm-payment", "--approve-all"])("rejects forbidden command %s", flag => { expect(() => parseReadinessCommand([flag])).toThrow("FORBIDDEN"); });
  it("a current approval only passes an informational check, without execution", async () => {
    const p = await authorize(), ledger = await read("economic-ledger.json"); await run();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
    const r = await run({ kind: "check-action", scope: scope(p) });
    expect(r.audit.at(-1)?.result).toBe("EXACT_AUTHORIZATION_CURRENT_NO_EXECUTION"); expect(r.execution_allowed).toBe(false); expect(fetch).not.toHaveBeenCalled();
    expect(r.projects[0].manual_launch_status).toBe("NOT_RECORDED"); expect(r.projects[0].experiment.started_at).toBeNull(); expect(await read("economic-ledger.json")).toBe(ledger);
    // V12.7 and V12.5 must not advertise launch-ready once V12.8 is sealed.
    expect((await prep({ kind: "inspect" })).projects[0].readiness).toBe("BLOCKED");
    expect((await preparationControlView(root))!.projects[0].blockers).toContain("ATOMIC_HANDOVER_NOT_IMPLEMENTED");
  });
  it.each(["project_id", "dossier_hash", "action_id", "request_id", "fingerprint"])("rejects and audits mismatched %s", async field => {
    const p = await authorize(); await run(); const wrong = { ...scope(p), [field]: field.endsWith("hash") || field === "fingerprint" ? "f".repeat(64) : "wrong-id" };
    await expect(run({ kind: "check-action", scope: wrong })).rejects.toThrow("SCOPE_MISMATCH");
    expect((await run({ kind: "events" })).audit.at(-1)?.result).toBe("SCOPE_MISMATCH");
  });
  it("rejects expiry at the exact boundary and preserves the decision history", async () => {
    const p = await authorize(); await run();
    await expect(run({ kind: "check-action", scope: scope(p) }, p.dossier.review_expires_at)).rejects.toThrow("APPROVAL_EXPIRED");
    const r = await run({ kind: "report" }, p.dossier.review_expires_at);
    expect(r.projects[0].authorization_status).toBe("NOT_CURRENTLY_APPROVED"); expect(r.projects[0].exact_authorizations[0].status).toBe("approved");
    expect(r.audit.at(-1)?.result).toBe("APPROVAL_EXPIRED"); expect(r.projects[0].experiment.deadline).toBeNull();
  });
  it.each(["pending", "denied"])("rejects %s authorization", async status => {
    const p = (await prep()).projects[0]; if (status === "denied") { const s = scope(p); await prep({ kind: "deny", project_id: s.project_id, action_id: s.action_id, request_id: s.request_id, fingerprint: s.fingerprint }); }
    await run(); await expect(run({ kind: "check-action", scope: scope(p) })).rejects.toThrow("APPROVAL_REQUIRED");
  });
  it("keeps fictional dossiers blocked even with exact approved requests", async () => {
    const p = (await prep()).projects[0], s = scope(p);
    await prep({ kind: "approve", project_id: s.project_id, action_id: s.action_id, request_id: s.request_id, fingerprint: s.fingerprint });
    await run(); await expect(run({ kind: "check-action", scope: s })).rejects.toThrow("DOSSIER_BLOCKED");
  });
  it("does not turn declarations or public archives into bank confirmations", async () => {
    const p = await authorize(); await run();
    for (const [id, kind, amount, phase] of [["expense-claim", "expense", 500, "experiment"], ["experiment-revenue", "revenue", 700, "experiment"], ["later-revenue", "revenue", 300, "post_experiment"]] as const)
      await prep({ kind: "declare", project_id: p.project_id, declaration_id: id, economic_kind: kind, amount_cents: amount, phase, proof_id: p.dossier.proofs[0].proof_id });
    const r = await run({ kind: "report" }), e = r.projects[0].economics;
    expect(e).toMatchObject({ planned_budget_cents: 1000, budget_assigned_cents: 1000, declared_expense_cents: 500, expense_really_verified_cents: null, estimated_revenue_cents: 1500, declared_revenue_cents: 1000, experiment_declared_revenue_cents: 700, post_experiment_declared_revenue_cents: 300, revenue_really_confirmed_cents: null });
    expect(r.projects[0].asset_after_experiment.income_end_date).toBeNull(); expect(r.projects[0].experiment.started_at).toBeNull();
    expect(renderReadinessReport(r)).toContain("Autorisation ≠ exécution"); expect(renderReadinessReport(r)).toContain(p.requests[0].fingerprint);
  });
  it("supervised declarations reject expired or unauthorized dossiers", async () => {
    const p = (await prep()).projects[0]; await run();
    const c = { kind: "declare", project_id: p.project_id, declaration_id: "claim", economic_kind: "expense", amount_cents: 100, phase: "experiment", proof_id: null };
    await expect(prep(c)).rejects.toThrow("Current exact authorization"); await expect(prep(c, p.dossier.review_expires_at)).rejects.toThrow("Current exact authorization");
  });
});
describe("V12.8 corruption, interruption and emergency stop", () => {
  it("serializes real competing processes without duplicate reservation or audit", async () => {
    await prep(); const results = await Promise.all([child(), child()]); expect(results.some(r => r.code === 0)).toBe(true);
    expect(results.every(r => r.code === 0 || r.code === 2 && r.out.includes("Ledger locked"))).toBe(true);
    const r = await run({ kind: "report" }); expect(r.audit).toHaveLength(1); expect(r.handover.current_total_exposure_cents).toBe(2000);
  });
  it.each(["crash-before-rename", "crash-after-rename"])("fails closed after %s, retaining whole old or new state", async operation => {
    await prep(); const old = await stateRaw(), before = await loadPreparation(root);
    expect((await child(operation)).code).toBe(operation === "crash-before-rename" ? 31 : 32);
    await expect(run()).rejects.toThrow("stale lock");
    const raw = await stateRaw(), state = decodePreparation(raw, root, before.key!);
    if (operation === "crash-before-rename") expect(raw).toBe(old); else expect(state.supervision?.events).toHaveLength(1);
    expect(state.projects.reduce((n, p) => n + p.reserved_budget_cents, 0)).toBe(2000);
    expect((await stop()).stopped).toBe(true); // stop remains available with the abandoned lock
  });
  it("halt while another process owns the lock blocks its final admission", async () => {
    await prep(); const result = await child("hold-lock", async () => { expect((await stop()).stopped).toBe(true); });
    expect(result.code).toBe(2); expect(result.out).toContain("EMERGENCY_STOP"); await expect(run()).rejects.toThrow("EMERGENCY_STOP");
  });
  it("stop persists across fresh processes and blocks legacy writers and approvals", async () => {
    const p = (await prep()).projects[0]; await run(); const before = await stateRaw();
    expect((await child("halt")).code).toBe(0); expect((await child()).out).toContain("EMERGENCY_STOP");
    await expect(prep({ kind: "approve", project_id: p.project_id, action_id: p.requests[0].action_id, request_id: p.requests[0].request_id, fingerprint: p.requests[0].fingerprint })).rejects.toThrow("EMERGENCY_STOP");
    await expect(inMode("ledger", () => runLedgerScout({ root }))).rejects.toThrow("EMERGENCY_STOP"); expect(await stateRaw()).toBe(before);
    const r = await run({ kind: "report" }); expect(r.emergency_stop.stopped).toBe(true); expect(r.projects.every(p => p.blockers.includes("EMERGENCY_STOP"))).toBe(true);
    const receipt = await fs.readFile(path.join(pilotStopRoot(root), "receipt.json"), "utf8"); await stop(); expect(await fs.readFile(path.join(pilotStopRoot(root), "receipt.json"), "utf8")).toBe(receipt);
  });
  it("stop is available before preparation and prevents future preparation", async () => { await stop(); await expect(prep()).rejects.toThrow("EMERGENCY_STOP"); });
  it.each(["symlink", "hardlink"])("an unsafe %s lock cannot prevent emergency stop", async kind => {
    await prep(); const target = path.join(temp, "unrelated.txt"), lock = path.join(root, ".economic-ledger.lock");
    await fs.writeFile(target, "Unrelated bytes must stay intact");
    if (kind === "symlink") await fs.symlink(target, lock); else await fs.link(target, lock);
    expect((await stop()).stopped).toBe(true); await expect(run()).rejects.toThrow("EMERGENCY_STOP");
    expect(await fs.readFile(target, "utf8")).toBe("Unrelated bytes must stay intact");
  });
  it.each(["empty-directory", "bad-receipt", "symlink", "regular-file"])("an abnormal stop marker (%s) can never enable a writer", async shape => {
    await prep(); const store = pilotStopRoot(root);
    if (shape === "symlink") await fs.symlink(root, store); else if (shape === "regular-file") await fs.writeFile(store, "invalid"); else { await fs.mkdir(store, { mode: 0o700 }); if (shape === "bad-receipt") await fs.writeFile(path.join(store, "receipt.json"), "broken"); }
    await expect(run()).rejects.toThrow("EMERGENCY_STOP"); const r = await stop({ kind: "stop-status" }); expect(r.stopped).toBe(true); expect(r.receipt_status).toContain("INVALID");
  });
  it("corrupt business history cannot prevent emergency stop or be silently repaired", async () => {
    await prep(); const file = path.join(preparationStoreRoot(root), "state.json"); await fs.writeFile(file, "{bad");
    await expect(run({ kind: "report" })).rejects.toThrow(); expect((await stop()).stopped).toBe(true); expect(await fs.readFile(file, "utf8")).toBe("{bad");
  });
  it("detects tampered supervision state and authenticated audit-chain corruption", async () => {
    await prep(); await run(); const loaded = await loadPreparation(root), d = JSON.parse(await stateRaw()); d.state.supervision.events[0].execution_performed = true;
    await fs.writeFile(path.join(preparationStoreRoot(root), "state.json"), JSON.stringify(d)); await expect(run()).rejects.toThrow("authentication");
    const s = structuredClone(loaded.state!.supervision!); s.events[0].previous_hash = "f".repeat(64);
    expect(() => validateSupervision(s, loaded.state!.updated_at)).toThrow("chain");
  });
  it.each(["dossier", "proof", "research", "ledger"])("refuses modified %s with no new decisions", async kind => {
    await prep(); await run(); const before = await stateRaw();
    if (kind === "dossier") await edit(d => { d.dossiers[0].offer = "Changed"; });
    if (kind === "proof") await fs.appendFile(path.join(root, "evidence/quote-1.txt"), "changed");
    if (kind === "research") await fs.appendFile(path.join(root, "research.json"), " ");
    if (kind === "ledger") await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(initializeLedger(9999)));
    await expect(run()).rejects.toThrow(); expect(await stateRaw()).toBe(before);
  });
  it("missing evidence blocks exact authorization checks", async () => { const p = await authorize(); await run(); await fs.unlink(path.join(root, p.dossier.proofs[0].file)); await expect(run({ kind: "check-action", scope: scope(p) })).rejects.toThrow("DOSSIER_BLOCKED"); });
  it("clock rollback cannot make old authorizations current again", async () => { await prep(); const r = await run(); await expect(run({ kind: "report" }, new Date(Date.parse(r.generated_at) - 1000).toISOString())).rejects.toThrow("clock rollback"); });
  it("model tools cannot write readiness or stop artifacts", async () => {
    const tool = createLocalWorkspaceTools(root).find(t => t.name === "write_file")!;
    for (const file of ["pilot-readiness.json", "pilot-stop.json", ".pilot-stop.json"]) expect(await tool.execute({ path: file, content: "unsafe" }, {} as any)).toContain("runtime-controlled");
  });
  it("Control API remains read-only and surfaces stop without leaking prose", async () => {
    await prep(); await run(); await stop();
    vi.stubEnv("SCOUT_MODE", "control-api");
    const api = await startControlApi({ root, env: { SCOUT_CONTROL_API_TOKEN: TOKEN, SCOUT_CONTROL_API_PORT: "0" } });
    try { const response = await fetch(api.url + "/v1/preparation", { headers: { authorization: `Bearer ${TOKEN}` } }); expect(response.status).toBe(200); const data = await response.json(); expect(data.preparation.emergency_stopped).toBe(true); expect(JSON.stringify(data)).not.toContain("Prestataire fictif"); }
    finally { await api.close(); }
  });
});
