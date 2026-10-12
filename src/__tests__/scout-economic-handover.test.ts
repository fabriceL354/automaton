/** Synthetic local bookkeeping fixtures only. No sale, bank proof or real pilot. */
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createPreparationExample } from "../../scripts/scout-v12-7-example.mjs";
import { runPilotPreparation, assertPreparationCapacity } from "../agent/pilot-preparation.js";
import { loadPreparation, preparationStoreRoot } from "../agent/pilot-preparation-store.js";
import { runPilotReadiness } from "../agent/pilot-readiness.js";
import { runOperationalPlanning } from "../agent/operational-planning.js";
import { runEconomicHandover, parseHandoverCommand, type HandoverCommand } from "../agent/economic-handover.js";
import { loadHandover, decodeHandover, HANDOVER_FILE, writeDirectory } from "../agent/economic-handover-store.js";
import { readProjectContext } from "../agent/project-manager.js";
import { projectStoreRoot } from "../agent/project-store.js";
import { initializeLedger, reserveExperiment, parseEconomicLedger } from "../agent/economic-ledger.js";
import { runLedgerScout, locked } from "../agent/ledger-runner.js";
import { haltPilot, pilotStopped } from "../agent/pilot-stop.js";
import { simulateFictionalScenarios } from "../agent/fictional-simulation.js";
import { createLocalWorkspaceTools } from "../agent/local-tools.js";
import { startControlApi } from "../agent/control-api.js";
import { plan, TOKEN } from "./scout-control-fixtures.js";
import type { HandoverRequest } from "../agent/economic-handover-model.js";
// Mutable test-only module wrapper for real filesystem fault injection.
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));
let parent: string, root: string, projects: any[], nowOverride: string | undefined;
const read = (name: string) => fs.readFile(path.join(root, name), "utf8");
async function mode<T>(value: string, operation: () => Promise<T>) { vi.stubEnv("SCOUT_MODE", value); return operation(); }
const run = (command: HandoverCommand = { kind: "inspect" }) => mode("economic-handover", () => runEconomicHandover({ root, command, ...(nowOverride ? { now: () => nowOverride } : {}) }));
const args = (r: HandoverRequest, kind: "approve" | "deny" | "transfer"): HandoverCommand => ({ kind, project_id: r.scope.project_id, dossier_hash: r.scope.dossier_hash, request_id: r.scope.request_id, fingerprint: r.fingerprint });
async function setup(capital = 2000, approve = true) {
  await createPreparationExample(root);
  const input = JSON.parse(await read("pilot-preparation-input.json"));
  // Exercises the real decision contract with synthetic documents in a temp dir.
  input.dossiers.forEach((d: any) => { d.fictional = false; });
  await fs.writeFile(path.join(root, "pilot-preparation-input.json"), JSON.stringify(input));
  await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(initializeLedger(capital)));
  projects = (await mode("pilot-preparation", () => runPilotPreparation({ root, command: { kind: "prepare" } }))).projects;
  if (approve) for (const p of projects) {
    await mode("pilot-preparation", () => runPilotPreparation({ root, command: { kind: "review", project_id: p.project_id, dossier_hash: p.dossier_hash, quote_cents: 1000, cost_proof_id: p.dossier.proofs[0].proof_id } }));
    for (const r of p.requests) await mode("pilot-preparation", () => runPilotPreparation({ root, command: { kind: "approve", project_id: p.project_id, action_id: r.action_id, request_id: r.request_id, fingerprint: r.fingerprint } }));
  }
  await mode("pilot-readiness", () => runPilotReadiness({ root, command: { kind: "prepare-handover" } }));
}
async function request(index = 0, approve = true) {
  const p = projects[index];
  const prepared = await run({ kind: "prepare", project_id: p.project_id, dossier_hash: p.dossier_hash });
  const r = prepared.requests.at(-1)!;
  if (approve) await run(args(r, "approve"));
  return r;
}
function failedRename(destination: string) {
  const rename = fs.rename;
  return vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to) === destination) throw new Error("INJECTED_INTERRUPT");
    return rename(from, to);
  });
}
async function fileTree(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await fileTree(target)); else result.push(target);
  }
  return result;
}
async function snapshotAll() {
  const files = await fileTree(parent);
  return Object.fromEntries(await Promise.all(files.map(async f => [f, (await fs.readFile(f)).toString("hex")])));
}
beforeEach(async () => { parent = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v142-test-")); root = path.join(parent, "workspace"); nowOverride = undefined; projects = []; });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(parent, { recursive: true, force: true }); });

describe("V14.2 exact local accounting transfer", () => {
  it("reclassifies two 10 EUR earmarks into the ORIGINAL V5/V9 stores, without bank money or starts", async () => {
    await setup(); const old = parseEconomicLedger(await read("economic-ledger.json"));
    const before = (await loadPreparation(root)).state!;
    const a = await request(); const first = await run(args(a, "transfer"));
    expect(first).toMatchObject({ active_preparation_reserved_cents: 1000, v5_reserved_cents: 1000, available_bookkeeping_cents: 1000, execution_allowed: false, bank_verified_available_cents: null, money_moved_cents: 0 });
    const b = await request(1); const second = await run(args(b, "transfer"));
    expect(second).toMatchObject({ active_preparation_reserved_cents: 0, v5_reserved_cents: 2000, available_bookkeeping_cents: 0, capital_is_bank_balance: false });
    const context = await readProjectContext(root);
    expect(context.ledger.entries.slice(0, old.entries.length)).toEqual(old.entries);
    expect(context.ledger.entries.map(e => e.type)).toEqual(["initialization", "reserve", "reserve"]);
    expect(context.model.projects).toHaveLength(2);
    expect(context.model.projects.every(p => p.status === "reserved" && p.approval?.request.status === "pending" && p.started_at === null && p.result === null)).toBe(true);
    const after = (await loadPreparation(root)).state!;
    expect(after.projects.every(p => p.reserved_budget_cents === 1000 && p.accounting_transfer?.amount_cents === 1000)).toBe(true);
    expect(after.financial_pin).toEqual(before.financial_pin); expect(after.supervision).toEqual(before.supervision);
    expect(second.transfers.every(t => t.status === "ACCOUNTING_TRANSFER_INSTALLED")).toBe(true);
  });
  it("requires preparation's exact approvals as well as a separate transfer decision", async () => {
    await setup(2000, false);
    await expect(run({ kind: "prepare", project_id: projects[0].project_id, dossier_hash: projects[0].dossier_hash })).rejects.toThrow("DOSSIER_BLOCKED");
    expect(parseEconomicLedger(await read("economic-ledger.json")).reserved_balance_cents).toBe(0);
  });
  it("rejects a pending transfer authorization", async () => { await setup(); const r = await request(0, false); await expect(run(args(r, "transfer"))).rejects.toThrow("APPROVAL_REQUIRED"); });
  it("rejects a denied transfer authorization and terminal contradictory decisions", async () => {
    await setup(); const r = await request(0, false); await run(args(r, "deny"));
    await expect(run(args(r, "transfer"))).rejects.toThrow("APPROVAL_REQUIRED");
    await expect(run(args(r, "approve"))).rejects.toThrow("TERMINAL");
  });
  it.each(["project_id", "dossier_hash", "request_id", "fingerprint"])("rejects a mismatched %s", async field => {
    await setup(); const r = await request(); const c = args(r, "transfer") as any;
    c[field] = field.endsWith("hash") || field === "fingerprint" ? "f".repeat(64) : "wrong-reference";
    await expect(run(c)).rejects.toThrow(); expect(parseEconomicLedger(await read("economic-ledger.json")).reserved_balance_cents).toBe(0);
  });
  it("rejects expiration at its exact boundary without renewal", async () => {
    await setup(); const r = await request(); nowOverride = r.scope.expires_at;
    await expect(run(args(r, "transfer"))).rejects.toThrow("EXPIRED");
    await expect(run({ kind: "prepare", project_id: r.scope.project_id, dossier_hash: r.scope.dossier_hash })).rejects.toThrow();
  });
  it("rejects clock rollback before a decision", async () => { await setup(); const r = await request(0, false); nowOverride = new Date(Date.parse(r.scope.created_at) - 1000).toISOString(); await expect(run(args(r, "approve"))).rejects.toThrow(); });
  it("rechecks expiration immediately before the durable commit, not only at entry", async () => {
    await setup(); const r = await request(); const before = await snapshotAll(); let calls = 0;
    await mode("economic-handover", () => expect(runEconomicHandover({ root, command: args(r, "transfer"), now: () => ++calls === 1 ? new Date().toISOString() : r.scope.expires_at })).rejects.toThrow("EXPIRED"));
    expect(await snapshotAll()).toEqual(before);
  });
  it("rejects clock rollback while constructing the transaction before committing any files", async () => {
    await setup(); const r = await request(); const before = await snapshotAll(); let calls = 0;
    await mode("economic-handover", () => expect(runEconomicHandover({ root, command: args(r, "transfer"), now: () => ++calls === 1 ? new Date().toISOString() : r.scope.created_at })).rejects.toThrow("CLOCK_ROLLBACK"));
    expect(await snapshotAll()).toEqual(before);
  });
  it("does not confuse the 100 EUR reference with insufficient accounting availability", async () => {
    await setup(500);
    expect(projects).toHaveLength(0);
    expect((await run()).available_bookkeeping_cents).toBe(500);
    const sources = { financial: { ledger: initializeLedger(500), model: { projects: [] } } } as any;
    await expect(run({ kind: "prepare", project_id: "not-prepared", dossier_hash: "f".repeat(64) })).rejects.toThrow();
    // Direct capacity boundary covers a full earmark that cannot be funded.
    expect(() => assertPreparationCapacity(sources, [{ reserved_budget_cents: 1000, dossier: { duration_days: 7 } }] as any)).toThrow("INSUFFICIENT_BUDGET");
  });
  it("rejects excessive cumulative exposure including a new standalone V5 commitment", async () => {
    await setup(10000); const r = await request();
    const l = reserveExperiment(parseEconomicLedger(await read("economic-ledger.json")), { ...plan, experiment_budget_eur: 1, requires_real_spending: true });
    await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(l));
    await expect(run(args(r, "transfer"))).rejects.toThrow("SPENDING_CEILING_EXCEEDED");
    expect(l.reserved_balance_cents).toBe(100);
  });
  it("serializes two simultaneous transfer calls without duplicate commitments", async () => {
    await setup(); const r = await request(); const results = await Promise.allSettled([run(args(r, "transfer")), run(args(r, "transfer"))]);
    expect(results.some(r => r.status === "fulfilled")).toBe(true);
    expect(parseEconomicLedger(await read("economic-ledger.json")).entries).toHaveLength(2);
    expect((await loadHandover(root)).state.transactions).toHaveLength(1);
  });
  it("two independent processes cannot duplicate the same approved transfer", async () => {
    await setup(); const r = await request();
    const child = () => new Promise<number | null>((resolve, reject) => {
      const p = spawn(process.execPath, ["src/__tests__/fixtures/handover-child.mjs", root, JSON.stringify(args(r, "transfer"))], { cwd: process.cwd(), env: { ...process.env, SCOUT_MODE: "economic-handover" }, stdio: "ignore" });
      const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("Handover child exceeded 15-second deadline")); }, 15000);
      p.on("error", reject); p.on("close", code => { clearTimeout(timer); resolve(code); });
    });
    const codes = await Promise.all([child(), child()]); expect(codes).toContain(0);
    expect(parseEconomicLedger(await read("economic-ledger.json")).entries).toHaveLength(2);
    expect((await loadHandover(root)).state.transactions).toHaveLength(1);
  });
  it("admits one unconsumed scope at a time instead of silently staling the second", async () => {
    await setup(); await request();
    await expect(run({ kind: "prepare", project_id: projects[1].project_id, dossier_hash: projects[1].dossier_hash })).rejects.toThrow("OTHER_REQUEST_OUTSTANDING");
  });
  it("returns the same durable receipt after an ACK loss and after expiry", async () => {
    await setup(); const r = await request(); await run(args(r, "transfer")); const bytes = await snapshotAll();
    nowOverride = r.scope.expires_at; const repeat = await run(args(r, "transfer"));
    expect(repeat.transfers).toHaveLength(1); expect(await snapshotAll()).toEqual(bytes);
    expect(repeat.execution_allowed).toBe(false);
  });
  it("repeats request preparation without regenerating IDs or signatures", async () => {
    await setup(); const r = await request(0, false); const bytes = await snapshotAll();
    const repeated = await run({ kind: "prepare", project_id: r.scope.project_id, dossier_hash: r.scope.dossier_hash });
    expect(repeated.requests[0]).toEqual(r); expect(await snapshotAll()).toEqual(bytes);
  });
});

describe("V14.2 durable commit and incident recovery", () => {
  it("refuses a failed parent-directory durability barrier before committing financial state", async () => {
    await setup(); const r = await request(), before = await snapshotAll(), open = fs.open;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (file, ...args: any[]) => {
      if (String(file) === parent) throw new Error("INJECTED_PARENT_SYNC_FAILURE");
      return (open as any)(file, ...args);
    });
    await expect(run(args(r, "transfer"))).rejects.toThrow("PARENT_SYNC_FAILURE"); spy.mockRestore();
    expect(await snapshotAll()).toEqual(before);
  });
  it("interruption before journal commit changes no financial/source authority", async () => {
    await setup(); const r = await request(), before = await snapshotAll();
    const spy = failedRename(path.join(preparationStoreRoot(root), HANDOVER_FILE));
    await expect(run(args(r, "transfer"))).rejects.toThrow("INJECTED_INTERRUPT"); spy.mockRestore();
    expect(await snapshotAll()).toEqual(before); expect((await loadHandover(root)).state.transactions).toHaveLength(0);
    expect((await run(args(r, "transfer"))).v5_reserved_cents).toBe(1000);
  });
  it.each([
    ["workspace", "economic-ledger.json"], ["workspace", "economic-report.txt"], ["workspace", "project-batch.json"],
    ["workspace", "projects.json"], ["workspace", "assets.json"], ["workspace", "project-report.txt"],
    ["preparation", "state.json"], ["projects", "integrity-key"], ["projects", "state.json"],
  ] as const)("recovers interruption while installing %s/%s from the single durable decision", async (area, name) => {
    await setup(); const r = await request(); const spy = failedRename(path.join(writeDirectory(root, area), name));
    await expect(run(args(r, "transfer"))).rejects.toThrow("INJECTED_INTERRUPT"); spy.mockRestore();
    expect((await run()).transfers[0].status).toBe("COMMITTED_RECOVERY_REQUIRED");
    await expect(mode("pilot-preparation", () => runPilotPreparation({ root, command: { kind: "inspect" } }))).rejects.toThrow("INSTALLATION_PENDING");
    await expect(run(args(r, "transfer"))).rejects.toThrow("RECOVERY_REQUIRED");
    nowOverride = r.scope.expires_at; const recovered = await run({ kind: "recover" });
    expect(recovered.v5_reserved_cents).toBe(1000); expect(recovered.active_preparation_reserved_cents).toBe(1000);
    expect((await readProjectContext(root)).model.projects).toHaveLength(1);
    expect((await run(args(r, "transfer"))).transfers).toHaveLength(1);
  });
  it("handles interruption after all files are durable but before installation acknowledgement", async () => {
    await setup(); const r = await request(); const rename = fs.rename; let journals = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === path.join(preparationStoreRoot(root), HANDOVER_FILE) && ++journals === 2) throw new Error("LOST_INSTALL_ACK");
      return rename(from, to);
    });
    await expect(run(args(r, "transfer"))).rejects.toThrow("LOST_INSTALL_ACK"); spy.mockRestore();
    const before = await read("economic-ledger.json"); expect((await run({ kind: "recover" })).v5_reserved_cents).toBe(1000);
    expect(await read("economic-ledger.json")).toBe(before);
  });
  it("refuses conflicting recovery bytes before overwriting anything", async () => {
    await setup(); const r = await request(); const spy = failedRename(path.join(root, "projects.json"));
    await expect(run(args(r, "transfer"))).rejects.toThrow(); spy.mockRestore();
    await fs.writeFile(path.join(root, "projects.json"), "untrusted third value"); const before = await snapshotAll();
    await expect(run({ kind: "recover" })).rejects.toThrow("RECOVERY_CONFLICT"); expect(await snapshotAll()).toEqual(before);
  });
  it("an active stop prevents new transfers", async () => {
    await setup(); const r = await request(); await haltPilot(root, "operator-stop", new Date().toISOString());
    await expect(run(args(r, "transfer"))).rejects.toThrow("EMERGENCY_STOP");
    expect(parseEconomicLedger(await read("economic-ledger.json")).reserved_balance_cents).toBe(0);
  });
  it("a stop during commit remains terminal; recovery completes accounting only", async () => {
    await setup(); const r = await request(); const rename = fs.rename; let stopped = false;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (!stopped && String(to) === path.join(preparationStoreRoot(root), HANDOVER_FILE)) { stopped = true; await haltPilot(root, "operator-stop", new Date().toISOString()); }
    });
    await expect(run(args(r, "transfer"))).rejects.toThrow("EMERGENCY_STOP"); spy.mockRestore();
    expect((await run({ kind: "recover" })).execution_allowed).toBe(false);
    expect(await pilotStopped(root)).toBe(true);
    await expect(mode("ledger", () => runLedgerScout({ root }))).rejects.toThrow("EMERGENCY_STOP");
  });
  it("a killed process leaves a closed lock; restart never steals it, then explicit recovery is idempotent", async () => {
    await setup(); const r = await request(); vi.stubEnv("SCOUT_MODE", "economic-handover");
    const child = spawn(process.execPath, ["src/__tests__/fixtures/handover-child.mjs", root, JSON.stringify(args(r, "transfer")), "pause-ledger"], { cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Handover child exceeded 15-second deadline")); }, 15000);
      child.on("error", reject);
      child.on("message", m => { if (m === "PAUSED") child.kill("SIGKILL"); });
      child.on("close", (_code, signal) => { clearTimeout(timer); signal === "SIGKILL" ? resolve() : reject(new Error("Child failed before interruption")); });
    });
    expect((await loadHandover(root)).state.transactions[0].installed).toBe(false);
    await expect(run({ kind: "recover" })).rejects.toThrow("stale lock");
    const owner = JSON.parse(await read(".economic-ledger.lock"));
    expect(() => process.kill(owner.pid, 0)).toThrow();
    // Simulated HUMAN inspection/removal in this disposable fixture, never a
    // runtime stale-lock recovery policy or instruction for a live workspace.
    await fs.unlink(path.join(root, ".economic-ledger.lock"));
    const recovered = await run({ kind: "recover" }); expect(recovered.v5_reserved_cents).toBe(1000);
    const bytes = await snapshotAll(); await run({ kind: "recover" }); expect(await snapshotAll()).toEqual(bytes);
  });
});

describe("V14.2 provenance and capability isolation", () => {
  it("rejects altered source archives", async () => {
    await setup(); const r = await request(); await fs.appendFile(path.join(root, projects[0].dossier.proofs[0].file), "changed");
    await expect(run(args(r, "transfer"))).rejects.toThrow("Evidence content changed");
  });
  it("rejects a rewritten source ledger even with a recalculated valid V5 chain", async () => {
    await setup(); const r = await request(); await fs.writeFile(path.join(root, "economic-ledger.json"), JSON.stringify(initializeLedger(10000)));
    await expect(run(args(r, "transfer"))).rejects.toThrow("prefix");
  });
  it("rejects a forged HMAC journal and foreign workspace transplant", async () => {
    await setup(); await request(); const raw = await fs.readFile(path.join(preparationStoreRoot(root), HANDOVER_FILE), "utf8");
    const d = JSON.parse(raw); d.state.requests[0].status = "denied";
    await fs.writeFile(path.join(preparationStoreRoot(root), HANDOVER_FILE), JSON.stringify(d)); await expect(run()).rejects.toThrow("AUTHENTICATION");
    const key = (await loadPreparation(root)).key!; expect(() => decodeHandover(raw, path.join(parent, "other"), key)).toThrow("STATE_INVALID");
  });
  it("rejects modified semantic transaction data even with a fresh HMAC", async () => {
    await setup(); const r = await request(); await run(args(r, "transfer"));
    const raw = JSON.parse(await fs.readFile(path.join(preparationStoreRoot(root), HANDOVER_FILE), "utf8")), key = (await loadPreparation(root)).key!;
    const ledgerImage = raw.state.transactions[0].writes.find((w: any) => w.area === "workspace" && w.name === "economic-ledger.json");
    ledgerImage.after = ledgerImage.before; // valid ORIGINAL timestamp; invalid committed delta
    raw.mac = createHmac("sha256", key).update(JSON.stringify(raw.state)).digest("hex");
    expect(() => decodeHandover(JSON.stringify(raw), root, key)).toThrow("LEDGER_DELTA_INVALID");
  });
  it("a deleted completed journal cannot silently reinitialize transfer audit", async () => {
    await setup(); const r = await request(); await run(args(r, "transfer"));
    await fs.unlink(path.join(preparationStoreRoot(root), HANDOVER_FILE));
    await expect(run()).rejects.toThrow("JOURNAL_MISSING");
    await expect(mode("pilot-preparation", () => runPilotPreparation({ root, command: { kind: "inspect" } }))).rejects.toThrow("JOURNAL_MISSING");
  });
  it("an installed ledger cannot be rolled back to its valid before image", async () => {
    await setup(); const r = await request(); await run(args(r, "transfer"));
    const t = (await loadHandover(root)).state.transactions[0];
    await fs.writeFile(path.join(root, "economic-ledger.json"), t.writes.find(w => w.name === "economic-ledger.json")!.before!);
    await expect(run()).rejects.toThrow("INSTALLED_STATE_CHANGED");
  });
  it("rejects symlink/hardlink journals rather than following an alternative authority", async () => {
    await setup(); await request(); const file = path.join(preparationStoreRoot(root), HANDOVER_FILE), copy = path.join(parent, "copy.json");
    await fs.rename(file, copy); await fs.symlink(copy, file); await expect(run()).rejects.toThrow();
    await fs.unlink(file); await fs.link(copy, file); await expect(run()).rejects.toThrow();
  });
  it("fails closed on a truncated journal and never repairs it as empty", async () => {
    await setup(); await request(); const file = path.join(preparationStoreRoot(root), HANDOVER_FILE);
    await fs.writeFile(file, "{\"state\":"); const before = await snapshotAll();
    await expect(run({ kind: "recover" })).rejects.toThrow(); expect(await snapshotAll()).toEqual(before);
  });
  it.each(["--pay", "--publish", "--start", "--execute", "--open-account", "--approve-all", "--resume"])("rejects forbidden route %s before changing files", flag => { expect(() => parseHandoverCommand([flag])).toThrow("FORBIDDEN"); });
  it("requires explicit mode and rejects additional fields", async () => {
    await setup(); vi.stubEnv("SCOUT_MODE", "local"); await expect(runEconomicHandover({ root, command: { kind: "inspect" } })).rejects.toThrow("Explicit");
    await expect(run({ kind: "inspect", execute: true } as any)).rejects.toThrow();
  });
  it("model tools cannot write handover authority and legacy financial/action hosts remain sealed", async () => {
    await setup(); const r = await request(); await run(args(r, "transfer"));
    const tool = createLocalWorkspaceTools(root).find(t => t.name === "write_file")!;
    expect(await tool.execute({ path: "economic-handover-state.json", content: "fake" } as any, {} as any)).toContain("runtime-controlled");
    expect(await tool.execute({ path: "../anchor/economic-handover-state.json", content: "fake" } as any, {} as any)).toContain("runtime-controlled");
    await expect(mode("ledger", () => runLedgerScout({ root }))).rejects.toThrow("sealed");
  });
  it("the HTTP Control API has no handover or generic approval route capable of accepting these scopes", async () => {
    await setup(); const r = await request(); await mode("control-api", async () => {
      const api = await startControlApi({ root, env: { SCOUT_CONTROL_API_PORT: "0", SCOUT_CONTROL_API_TOKEN: TOKEN } });
      try {
        const response = await fetch(api.url + "/v1/economic-handover", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: "{}" });
        expect(response.status).toBe(404);
        const approval = await fetch(api.url + `/v1/approvals/${r.scope.request_id}/approve`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: "{}" });
        expect(approval.status).toBe(400);
      } finally { await api.close(); }
    });
    expect((await loadHandover(root)).state.transactions).toHaveLength(0);
  });
  it("preserves V13 plans/decisions and never makes an archived plan executable", async () => {
    await setup(); const report = await mode("operational-planning", () => runOperationalPlanning({ root, command: { kind: "plan" } }));
    const planning = (await loadPreparation(root)).state!.planning, supervision = (await loadPreparation(root)).state!.supervision;
    const r = await request(); await run(args(r, "transfer"));
    const state = (await loadPreparation(root)).state!; expect(state.planning).toEqual(planning); expect(state.supervision).toEqual(supervision);
    expect(report.execution_allowed).toBe(false);
    await expect(mode("operational-planning", () => runOperationalPlanning({ root, command: { kind: "report" } }))).rejects.toThrow("HANDOVER_SOURCE_CHANGED");
    expect((await run()).execution_allowed).toBe(false);
  });
  it("V14.1 is still a pure fictional simulation and never changes a transferred workspace", async () => {
    await setup(); const r = await request(); await run(args(r, "transfer")); const before = await snapshotAll();
    const simulation = simulateFictionalScenarios({ version: "14.1", kind: "FICTIONAL_SIMULATION", currency: "EUR", scenarios: [{ scenario_id: "example", budget_cents: 1000, fixed_cost_cents: 100, unit_cost_cents: 0, unit_price_cents: 100, units: 2 }] });
    expect(simulation).toMatchObject({ fictional: true, real_evidence: false, execution_allowed: false });
    expect(await snapshotAll()).toEqual(before);
  });
  it("transfer never calls a model, fetch, payment or publication; financial outcomes stay unknown", async () => {
    await setup(); const r = await request(); const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("NETWORK_FORBIDDEN"));
    const result = await run(args(r, "transfer")); expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ payment_performed: false, publication_performed: false, project_started: false, execution_allowed: false, money_moved_cents: 0, bank_verified_available_cents: null });
  });
});
