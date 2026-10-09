import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { runPilotPreparation, parsePreparationCommand, assertPreparationCapacity, preparationControlView } from "../agent/pilot-preparation.js";
import { preparationStoreRoot, loadPreparation } from "../agent/pilot-preparation-store.js";
import { parsePreparationInput, rejectSensitive, createPreparedProject } from "../agent/pilot-preparation-model.js";
import { digest } from "../agent/project-model.js";
import { readAllocationSources } from "../agent/allocation-sources.js";
import { initializeLedger, reserveExperiment } from "../agent/economic-ledger.js";
import { createLocalWorkspaceTools } from "../agent/local-tools.js";
import { runLedgerScout, recordLedgerEvent } from "../agent/ledger-runner.js";
import { startControlApi } from "../agent/control-api.js";
import { TOKEN, plan } from "./scout-control-fixtures.js";
// Compiled example is also the operator's delivered example, not a second fixture.
import { createPreparationExample } from "../../scripts/scout-v12-7-example.mjs";
let temp: string, root: string, input: any, fixture: any;
const invoke = (command: any = { kind: "prepare" }, now?: string) => runPilotPreparation({ root, command, ...(now ? { now: () => now } : {}) });
async function edit(change: (input: any) => void) { change(input); await fs.writeFile(path.join(root, "pilot-preparation-input.json"), JSON.stringify(input)); }
const read = (file: string) => fs.readFile(path.join(root, file), "utf8");
function child(operation = "prepare") {
  return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    const p = spawn(process.execPath, ["src/__tests__/fixtures/preparation-child.mjs", root, operation], { cwd: process.cwd(), env: { ...process.env, SCOUT_MODE: "pilot-preparation" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", d => { out += d; }); p.stderr.on("data", d => { out += d; });
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("Child exceeded bounded deadline")); }, 15000);
    p.on("error", e => { clearTimeout(timer); reject(e); }); p.on("close", code => { clearTimeout(timer); resolve({ code, out }); });
  });
}
beforeEach(async () => { vi.stubEnv("SCOUT_MODE", "pilot-preparation"); temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-preparation-test-")); root = path.join(temp, "workspace"); fixture = await createPreparationExample(root); input = JSON.parse(await read("pilot-preparation-input.json")); });
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await fs.rm(temp, { recursive: true, force: true }); });
describe("V12.7 preparation limits and selection", () => {
  it("admits two 1000-cent projects, keeps 10000 reference distinct from bank funds", async () => {
    const ledger = await read("economic-ledger.json"), r = await invoke();
    expect(r.projects).toHaveLength(2); expect(r.total_preparation_reserved_cents).toBe(2000); expect(r.capital_is_bank_balance).toBe(false);
    expect(await read("economic-ledger.json")).toBe(ledger); expect(r.real_money_spent_by_v12_7_cents).toBe(0);
    expect(r.projects.every(p => p.blockers.includes("FICTIONAL_PROJECT"))).toBe(true);
  });
  it("refuses a third project without increasing exposure", async () => {
    await fs.rm(root, { recursive: true }); await createPreparationExample(root, 3); const r = await invoke();
    expect(r.projects).toHaveLength(2); expect(r.events.some(e => e.subject_id === "research-opportunity-3" && e.event_type === "BLOCKED")).toBe(true);
  });
  it.each([1001, 1000.5, -1, Number.MAX_SAFE_INTEGER])("rejects invalid/over-ceiling budget %s", async budget => { await edit(i => { i.dossiers[0].budget_cents = budget; }); await expect(invoke()).rejects.toThrow(); });
  it.each([0, 8, 7.1])("rejects duration %s", async duration => { await edit(i => { i.dossiers[0].duration_days = duration; }); await expect(invoke()).rejects.toThrow(); });
  it("refuses total exposure above 2000 cents including standalone V5 reservation", async () => {
    const ledger = reserveExperiment(initializeLedger(10000), { ...plan, experiment_budget_eur: 1, requires_real_spending: true });
    await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(ledger)); const r = await invoke();
    expect(r.projects.length).toBeLessThan(2); expect(r.total_preparation_reserved_cents + 100).toBeLessThanOrEqual(2000);
    const sources = await readAllocationSources(root, "research.json");
    expect(() => assertPreparationCapacity(sources, input.dossiers.map((d: any, i: number) => createPreparedProject(d, fixture.candidates[i], new Date().toISOString())))).toThrow("SPENDING_CEILING_EXCEEDED");
  });
  it("surfaces insufficient bookkeeping capital and creates no payment", async () => { await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(initializeLedger(500))); const r = await invoke(); expect(r.projects).toHaveLength(0); expect(r.events.some(e => e.event_type === "INSUFFICIENT_BUDGET")).toBe(true); });
  it("requires exact candidate and ignores invented dossier identities", async () => { await edit(i => { i.dossiers[0].candidate_fingerprint = "f".repeat(64); }); await expect(invoke()).rejects.toThrow("fingerprint"); });
  it("missing archives block review and launch", async () => { await fs.unlink(path.join(root, input.dossiers[0].proofs[0].file)); const r = await invoke(); expect(r.projects[0].blockers).toContain("MISSING_EVIDENCE"); expect(r.events.some(e => e.event_type === "MISSING_EVIDENCE")).toBe(true); });
});
describe("V12.7 exact manual approvals", () => {
  it("rejects transfer to another project or action and altered fingerprint", async () => {
    const r = await invoke(), p = r.projects[0], request = p.requests[0];
    const c = { kind: "approve", project_id: p.project_id, action_id: request.action_id, request_id: request.request_id, fingerprint: request.fingerprint };
    await expect(invoke({ ...c, project_id: r.projects[1].project_id })).rejects.toThrow("scope");
    await expect(invoke({ ...c, action_id: "other-action" })).rejects.toThrow("scope"); await expect(invoke({ ...c, fingerprint: "f".repeat(64) })).rejects.toThrow("scope");
  });
  it("rejects expired approval even previously approved", async () => {
    const r = await invoke(), p = r.projects[0], req = p.requests[0];
    await invoke({ kind: "approve", project_id: p.project_id, action_id: req.action_id, request_id: req.request_id, fingerprint: req.fingerprint });
    const expired = p.dossier.review_expires_at;
    await expect(invoke({ kind: "approve", project_id: p.project_id, action_id: req.action_id, request_id: req.request_id, fingerprint: req.fingerprint }, expired)).rejects.toThrow("Expired");
    expect((await invoke({ kind: "inspect" }, expired)).projects[0].human_authorization).toBe("NOT_CURRENTLY_APPROVED");
  });
  it("approval never dispatches any payment/publication/network or mutates V5", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
    const ledger = await read("economic-ledger.json"), r = await invoke(), p = r.projects[0], req = p.requests[0];
    const decided = await invoke({ kind: "approve", project_id: p.project_id, action_id: req.action_id, request_id: req.request_id, fingerprint: req.fingerprint });
    expect(fetch).not.toHaveBeenCalled(); expect(await read("economic-ledger.json")).toBe(ledger); expect(decided.projects[0].requests[0].payment_proven).toBe(false);
    expect(decided.projects[0].action_authorized).toBe(false); expect(await fs.readdir(root)).not.toContain("external-action.json");
  });
  it("cannot override a denial or decide twice", async () => {
    const p = (await invoke()).projects[0], req = p.requests[0], c = { kind: "deny", project_id: p.project_id, action_id: req.action_id, request_id: req.request_id, fingerprint: req.fingerprint };
    await invoke(c); await expect(invoke({ ...c, kind: "approve" })).rejects.toThrow("consumed"); await expect(invoke(c)).rejects.toThrow("consumed");
  });
  it("separates commercial review from technical and human approval", async () => {
    await edit(i => { i.dossiers.forEach((d: any) => { d.fictional = false; }); });
    const p = (await invoke()).projects[0], req = p.requests[0];
    await invoke({ kind: "approve", project_id: p.project_id, action_id: req.action_id, request_id: req.request_id, fingerprint: req.fingerprint });
    expect((await invoke({ kind: "inspect" })).projects[0].blockers).toContain("COMMERCIAL_REVIEW_REQUIRED");
    const r = await invoke({ kind: "review", project_id: p.project_id, dossier_hash: p.dossier_hash, quote_cents: 1000, cost_proof_id: p.dossier.proofs[0].proof_id });
    expect(r.projects[0].readiness).toBe("READY_FOR_MANUAL_LAUNCH"); expect(r.projects[0].experimental_period.started_at).toBeNull();
    expect(r.projects[0].economics.human_documented_quote_cents).toBe(1000); expect(r.projects[0].economics.evidence_confirmed_expense_cents).toBeNull();
    expect(r.events.some(e => e.event_type === "READY_FOR_MANUAL_LAUNCH")).toBe(true);
  });
  it.each(["--pay", "--execute", "--publish", "--start", "--open-account", "--consume-approval", "--approve-all"])("refuses %s", async flag => { expect(() => parsePreparationCommand([flag])).toThrow("forbidden"); await expect(invoke({ kind: flag.slice(2) })).rejects.toThrow(); });
});
describe("V12.7 evidence, outcomes and persistence", () => {
  it("declarations and hypothetical revenues never become confirmed money", async () => {
    const p = (await invoke()).projects[0], ledger = await read("economic-ledger.json");
    await invoke({ kind: "declare", project_id: p.project_id, declaration_id: "claim-expense-one", economic_kind: "expense", amount_cents: 500, phase: "experiment", proof_id: null });
    const r = await invoke({ kind: "declare", project_id: p.project_id, declaration_id: "claim-revenue-one", economic_kind: "revenue", amount_cents: 1200, phase: "post_experiment", proof_id: p.dossier.proofs[0].proof_id });
    expect(r.projects[0].economics).toMatchObject({ declared_expense_cents: 500, evidence_confirmed_expense_cents: null, bank_verified_expense_cents: null, estimated_revenue_cents: 1500, confirmed_revenue_cents: null, post_experiment_declared_revenue_cents: 1200, experimental_result: null, lifetime_economic_result: null });
    expect(await read("economic-ledger.json")).toBe(ledger); expect(r.events.some(e => e.event_type === "ECONOMIC_RESULT_REVIEW_REQUIRED")).toBe(true);
  });
  it("restart in fresh processes cannot duplicate reservations", async () => { expect((await child()).code).toBe(0); const original = await fs.readFile(path.join(preparationStoreRoot(root), "state.json"), "utf8"); expect((await child()).code).toBe(0); expect(await fs.readFile(path.join(preparationStoreRoot(root), "state.json"), "utf8")).toBe(original); });
  it("two real processes cannot exceed exposure", async () => { const results = await Promise.all([child(), child()]); expect(results.some(r => r.code === 0)).toBe(true); const r = await invoke({ kind: "inspect" }); expect(r.projects).toHaveLength(2); expect(r.total_preparation_reserved_cents).toBe(2000); });
  it("hard crash leaves a fail-closed lock and does not create reservations", async () => { expect((await child("crash")).code).toBe(23); await expect(invoke()).rejects.toThrow("stale lock"); expect(await fs.readdir(root)).not.toContain("project-batch.json"); });
  it("detects canonical state alteration without repair", async () => { await invoke(); const file = path.join(preparationStoreRoot(root), "state.json"), d = JSON.parse(await fs.readFile(file, "utf8")); d.state.projects[0].reserved_budget_cents = 0; const raw = JSON.stringify(d); await fs.writeFile(file, raw); await expect(invoke()).rejects.toThrow("authentication"); expect(await fs.readFile(file, "utf8")).toBe(raw); });
  it("detects evidence modification and changed input", async () => { await invoke(); await fs.appendFile(path.join(root, input.dossiers[0].proofs[0].file), "alteration"); await expect(invoke()).rejects.toThrow("Evidence content changed"); });
  it("detects a changed dossier instead of renewing an approval", async () => { await invoke(); await edit(i => { i.dossiers[0].description = "Changed scope"; }); await expect(invoke()).rejects.toThrow("input changed"); });
  it("detects V5 rollback instead of regenerating a reservation", async () => { await invoke(); await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(initializeLedger(9999))); await expect(invoke()).rejects.toThrow("prefix mismatch"); });
  it("does not turn a preparation expiry into an experiment deadline", async () => { const r = await invoke(); const expired = await invoke({ kind: "inspect" }, r.projects[0].dossier.review_expires_at); expect(expired.events.some(e => e.event_type === "BLOCKED")).toBe(true); expect(expired.events.some(e => e.event_type === "EXPERIMENT_PERIOD_ENDED")).toBe(false); });
  it("refuses sensitive material inside a referenced evidence archive", async () => { const file = input.dossiers[0].proofs[0].file, raw = "CVV 123"; await fs.writeFile(path.join(root, file), raw); await edit(i => { i.dossiers[0].proofs[0].sha256 = digest(raw); }); await expect(invoke()).rejects.toThrow("SENSITIVE_INPUT_REJECTED"); });
  it("refuses multiple payment proposals whose combined maximum exceeds the project budget", async () => { await edit(i => { i.dossiers[0].human_actions.push({ ...i.dossiers[0].human_actions[0], action_id: "second-payment" }); }); await expect(invoke()).rejects.toThrow("SPENDING_CEILING_EXCEEDED"); });
  it("does not accept a fictional dossier as commercially verified", async () => { const p = (await invoke()).projects[0]; await expect(invoke({ kind: "review", project_id: p.project_id, dossier_hash: p.dossier_hash, quote_cents: 1000, cost_proof_id: p.dossier.proofs[0].proof_id })).rejects.toThrow("Commercial review"); });
  it("refuses replayed economic declarations", async () => { const p = (await invoke()).projects[0], c = { kind: "declare", project_id: p.project_id, declaration_id: "same-claim", economic_kind: "expense", amount_cents: 500, phase: "experiment", proof_id: null }; await invoke(c); await expect(invoke(c)).rejects.toThrow("duplicate"); });
  it("rejects an incomplete anchor", async () => { const store = preparationStoreRoot(root); await fs.mkdir(store, { mode: 0o700 }); await fs.writeFile(path.join(store, "integrity-key"), "a".repeat(64) + "\n", { mode: 0o600 }); await expect(invoke()).rejects.toThrow("Incomplete"); });
  it.each(["symlink", "hardlink"])("refuses %s evidence", async kind => { const target = path.join(root, input.dossiers[0].proofs[0].file), copy = path.join(temp, "copy.txt"); await fs.rename(target, copy); if (kind === "symlink") await fs.symlink(copy, target); else { await fs.link(copy, target); } await expect(invoke()).rejects.toThrow("unsafe file"); });
  it("rejects workspace escape and traversal proof names", async () => { await edit(i => { i.dossiers[0].proofs[0].file = "../secret.txt"; }); await expect(invoke()).rejects.toThrow("evidence"); await expect(runPilotPreparation({ root: root + "/../workspace", command: { kind: "prepare" } })).rejects.toThrow("Normalized"); });
  it.each(["CVV 123", "IBAN FR76 1234 1234 1234 1234 1234 123", "card_number 4111 1111 1111 1111", "password: sensitive", "Bearer abc-secret"])("rejects sensitive inputs without storing them", async secret => {
    expect(() => rejectSensitive(secret)).toThrow("SENSITIVE_INPUT_REJECTED"); await edit(i => { i.dossiers[0].description = secret; }); await expect(invoke()).rejects.toThrow("SENSITIVE_INPUT_REJECTED"); await expect(fs.lstat(preparationStoreRoot(root))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("model tools cannot write preparation contracts or approvals", async () => { const tool = createLocalWorkspaceTools(root).find(t => t.name === "write_file")!; expect(await tool.execute({ path: "pilot-preparation-input.json", content: "unsafe" }, {} as any)).toContain("runtime-controlled"); });
  it("legacy writers cannot create parallel exposure in a preparation workspace", async () => { await invoke(); vi.stubEnv("SCOUT_MODE", "ledger"); await expect(runLedgerScout({ root })).rejects.toThrow("sealed"); });
  it("an environment mode alone cannot unlock the direct financial writer", async () => { await invoke(); await expect(recordLedgerEvent({} as any, root)).rejects.toThrow("sealed"); });
  it.each(["Ouvrir un compte externe", "Acheter des crédits", "Acheter un abonnement"])("refuses the human action %s", async description => { await edit(i => { i.dossiers[0].human_actions[0].description = description; }); await expect(invoke()).rejects.toThrow("forbidden"); });
  it("rejects flag aliases", () => { expect(() => parsePreparationCommand(["xxprepare"])).toThrow("Exact preparation flag"); });
  it("local V12.5 exposes sanitized preparation events without action endpoints", async () => {
    await invoke(); vi.stubEnv("SCOUT_MODE", "control-api"); const api = await startControlApi({ root, env: { SCOUT_CONTROL_API_TOKEN: TOKEN, SCOUT_CONTROL_API_PORT: "0" } });
    try { const r = await fetch(api.url + "/v1/preparation", { headers: { authorization: `Bearer ${TOKEN}` } }); expect(r.status).toBe(200); const d = await r.json(); expect(d.preparation.projects).toHaveLength(2); expect(JSON.stringify(d)).not.toContain("Prestataire fictif");
      const ev = await fetch(api.url + "/v1/events", { headers: { authorization: `Bearer ${TOKEN}` } }); expect(ev.status).toBe(200); expect((await ev.json()).items.some((e: any) => e.event_type === "OPPORTUNITY_READY_FOR_REVIEW")).toBe(true);
    } finally { await api.close(); }
  });
});
