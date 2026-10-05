import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, createHmac } from "node:crypto";
import { approvalStoreRoot, parseApprovalCommand, runApprovalScout, type ApprovalRequest } from "../agent/approval-gate.js";
import { initializeLedger, reserveExperiment, parseEconomicLedger, experimentReference, recordAuthorizedEvent } from "../agent/economic-ledger.js";
import { runLedgerScout } from "../agent/ledger-runner.js";
import { createLocalWorkspaceTools } from "../agent/local-tools.js";
import type { ExperimentPlan } from "../agent/experiment-runner.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const plan: ExperimentPlan = {
  version: 4, status: "planned", opportunity_name: "Service local", opportunity_score: 82,
  hypothesis: "Tester la demande pour un service local.", experiment_budget_eur: 10, duration_days: 3,
  actions: ["Préparer un prototype"], success_metrics: ["Obtenir trois réponses"], stop_conditions: ["Arrêter après trois jours"],
  expected_learning: "Mesurer la demande locale.", requires_real_spending: true, requires_external_account: false,
  requires_publication: false, requires_human_approval: true,
};
let temp: string, root: string;
let fetchMock: ReturnType<typeof vi.fn>;
const read = (name: string) => fs.readFile(path.join(root, name), "utf8");
const write = (name: string, data: unknown) => fs.writeFile(path.join(root, name), JSON.stringify(data));
const run = () => runApprovalScout({ root });
const approve = (requestId: string) => runApprovalScout({ root, command: { kind: "approve", requestId } });
const deny = (requestId: string) => runApprovalScout({ root, command: { kind: "deny", requestId } });
const renew = () => runApprovalScout({ root, command: { kind: "new-request" } });
async function fixture(value = plan) {
  await fs.mkdir(root, { recursive: true });
  await write("experiment.json", value);
  await write("economic-ledger.json", reserveExperiment(initializeLedger(10000), value));
}
async function absent(name = "approval.json") { await expect(fs.stat(path.join(root, name))).rejects.toThrow(); }
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-approval-"));
  root = path.join(temp, "workspace");
  vi.stubEnv("SCOUT_MODE", "approval");
  vi.stubEnv("OLLAMA_BASE_URL", "invalid");
  fetchMock = vi.fn(() => { throw new Error("No network or Ollama allowed"); });
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(fs.rename).mockClear();
  await fixture();
});
afterEach(async () => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  await fs.rm(temp, { recursive: true, force: true });
});

describe("V6 explicit human decisions and V4/V5 binding", () => {
  it("creates pending bound to V4, exact reserved cents/capabilities and a truthful report", async () => {
    const ledgerBefore = await read("economic-ledger.json");
    const request = await run();
    expect(request.version).toBe(6);
    expect(request.status).toBe("pending");
    expect(request.experiment_id).toBe(experimentReference(plan).id);
    expect(request.requested_capabilities).toEqual(["real_spending"]);
    expect(request.max_amount_cents).toBe(1000);
    expect(request.reservation_reference?.amount_cents).toBe(1000);
    expect(request.request_id).toMatch(/^request-/);
    expect(request.experiment_hash).toBe(createHash("sha256").update(await read("experiment.json")).digest("hex"));
    expect(JSON.parse(await read("approval-request.json"))).toEqual(request);
    expect(await run()).toEqual(request); // rerun never auto-approves or creates a second id
    await absent();
    const report = await read("approval-report.txt");
    for (const value of ["EN ATTENTE", request.request_id, "10.00 EUR", "Préparer un prototype", "real_spending", "Aucune dépense ni action externe n'a été exécutée par Scout."]) expect(report).toContain(value);
    expect(await read("economic-ledger.json")).toBe(ledgerBefore);
  });

  it("approves exactly one pending request and leaves all V5 bytes/totals unchanged", async () => {
    const before = await read("economic-ledger.json");
    const request = await run();
    expect((await approve(request.request_id)).status).toBe("approved");
    const result = JSON.parse(await read("approval.json"));
    expect(result).toMatchObject({ status: "approved", request_id: request.request_id, experiment_id: request.experiment_id,
      max_amount_cents: 1000, approved_capabilities: ["real_spending"], request_fingerprint: request.request_fingerprint,
      human_reference: `local-cli:approve:${request.request_id}` });
    expect(result.approved_at).toBeTruthy();
    expect((await run()).status).toBe("approved");
    await expect(approve(request.request_id)).rejects.toThrow("pending");
    await expect(deny(request.request_id)).rejects.toThrow("pending");
    expect(await read("economic-ledger.json")).toBe(before);
    expect(parseEconomicLedger(before)).toMatchObject({ initial_capital_cents: 10000, available_balance_cents: 9000, reserved_balance_cents: 1000,
      total_recorded_expenses_cents: 0, total_recorded_revenue_cents: 0, realized_net_result_cents: 0 });
    expect(await read("approval-report.txt")).toContain("APPROUVÉE");
    expect(await read("approval-report.txt")).not.toMatch(/paiement effectué|dépense effectuée/);
  });

  it("denies explicitly, preserves refusal and requires a fresh request for reconsideration", async () => {
    const old = await run();
    expect((await deny(old.request_id)).status).toBe("denied");
    expect((await run()).status).toBe("denied");
    expect(await read("approval-report.txt")).toContain("REFUSÉE");
    await absent();
    await expect(approve(old.request_id)).rejects.toThrow("pending");
    const fresh = await renew();
    expect(fresh.status).toBe("pending");
    expect(fresh.request_id).not.toBe(old.request_id);
    expect(fresh.request_fingerprint).not.toBe(old.request_fingerprint);
    await expect(approve(old.request_id)).rejects.toThrow("pending");
    await approve(fresh.request_id);
    const state = JSON.parse(await fs.readFile(path.join(approvalStoreRoot(root), "state.json"), "utf8"));
    expect(state.records.map((r: any) => r.request.status)).toEqual(["denied", "approved"]);
    expect(state.records[0].decision.human_reference).toBe(`local-cli:deny:${old.request_id}`);
  });

  it("explicit renewal invalidates the former approval and retains signed history", async () => {
    const old = await run(); await approve(old.request_id);
    const oldApproval = await read("approval.json");
    const fresh = await renew();
    await absent();
    expect((await run()).request_id).toBe(fresh.request_id);
    await fs.writeFile(path.join(root, "approval.json"), oldApproval);
    await expect(run()).rejects.toThrow("orphan");
  });

  it.each([
    { requires_external_account: true }, { requires_publication: true }, { requires_external_account: true, requires_publication: true },
  ])("binds exact sensitive categories %j", async change => {
    await fixture({ ...plan, ...change });
    const r = await run(); await approve(r.request_id);
    const expected = ["real_spending", ...(change.requires_external_account ? ["external_account"] : []), ...(change.requires_publication ? ["publication"] : [])];
    expect(r.requested_capabilities).toEqual(expected);
    expect(JSON.parse(await read("approval.json")).approved_capabilities).toEqual(expected);
  });

  it("allows zero-cost publication with valid V5 and no invented reservation", async () => {
    await fixture({ ...plan, experiment_budget_eur: 0, requires_real_spending: false, requires_publication: true });
    const r = await run();
    expect(r.max_amount_cents).toBe(0);
    expect(r.reservation_reference).toBeNull();
    expect(r.requested_capabilities).toEqual(["publication"]);
    await approve(r.request_id);
  });

  it("keeps an otherwise unexplained sensitive flag explicit and rejects entirely nonsensitive plans", async () => {
    await fixture({ ...plan, experiment_budget_eur: 0, requires_real_spending: false });
    expect((await run()).requested_capabilities).toEqual(["other_sensitive_action"]);
    await fixture({ ...plan, experiment_budget_eur: 0, requires_real_spending: false, requires_human_approval: false });
    await expect(run()).rejects.toThrow("No sensitive");
  });

  it.each(["yes", "true", "approve-all", "latest", "*", "", "request-00000000-0000-0000-0000-000000000000"])("refuses implicit/invalid approval id %j", async requestId => {
    await run();
    expect(() => parseApprovalCommand(["--approve", requestId])).toThrow();
    await expect(approve(requestId)).rejects.toThrow();
    await absent();
  });

  it.each([["--approve"], ["--deny"], ["--approve-all"], ["--run", "--approve"], ["--new-request", "yes"], ["--run", "yes"], []])("rejects CLI grammar %j", args => {
    expect(() => parseApprovalCommand(args)).toThrow();
  });

  it("rejects another syntactically valid id and env/file/model text decisions", async () => {
    const r = await run();
    await expect(approve("request-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).rejects.toThrow("pending");
    vi.stubEnv("SCOUT_APPROVE", r.request_id);
    await write("model-response.json", { approve: r.request_id, human_reference: "human says yes" });
    expect((await run()).status).toBe("pending");
    await absent();
  });

  it.each([
    { hypothesis: "Tester une nouvelle hypothèse locale." }, { experiment_budget_eur: 9 },
    { requires_external_account: true }, { requires_publication: true }, { opportunity_name: "Autre expérience" },
    { actions: ["Préparer un second prototype"] },
  ])("invalidates approval after V4 change %j even with a matching new V5 reservation", async change => {
    const r = await run(); await approve(r.request_id);
    const updated = { ...plan, ...change };
    await write("experiment.json", updated);
    const ledger = parseEconomicLedger(await read("economic-ledger.json"));
    await write("economic-ledger.json", reserveExperiment(ledger, updated));
    await expect(run()).rejects.toThrow("stale");
    const fresh = await renew();
    expect(fresh.status).toBe("pending");
    expect(fresh.experiment_id).not.toBe(r.experiment_id);
    await absent();
  });

  it("invalidates even byte-only source/ledger replacements conservatively", async () => {
    const r = await run(); await approve(r.request_id);
    await fs.appendFile(path.join(root, "experiment.json"), "\n");
    await expect(run()).rejects.toThrow("stale");
    const fresh = await renew(); await approve(fresh.request_id);
    await fs.appendFile(path.join(root, "economic-ledger.json"), "\n");
    await expect(run()).rejects.toThrow("stale");
  });

  it.each(["expense", "release"] as const)("rejects a partially consumed/released reservation (%s)", async type => {
    const r = await run(); await approve(r.request_id);
    const ledger = recordAuthorizedEvent(parseEconomicLedger(await read("economic-ledger.json")), { type, amount_cents: 1,
      experiment_id: experimentReference(plan).id, description: "Simulated fixture only", authorization: { source: "human", reference: "test-fixture" } });
    await write("economic-ledger.json", ledger);
    await expect(run()).rejects.toThrow("reservation");
    await expect(renew()).rejects.toThrow("reservation");
  });

  it("rejects absent/unrelated reservations and a request amount exceeding the reservation", async () => {
    await write("economic-ledger.json", initializeLedger(10000));
    await expect(run()).rejects.toThrow("reservation");
    await fixture({ ...plan, experiment_budget_eur: 9 });
    await write("experiment.json", plan);
    await expect(run()).rejects.toThrow("reservation");
    await fixture(); await run();
    const r = JSON.parse(await read("approval-request.json")); r.max_amount_cents = 1001;
    await write("approval-request.json", r);
    await expect(approve(r.request_id)).rejects.toThrow("Modified");
  });
});

describe("V6 tamper detection, confinement, atomicity and no external capability", () => {
  it.each(["experiment.json", "economic-ledger.json"])("refuses missing/corrupt input %s", async name => {
    await fs.unlink(path.join(root, name));
    await expect(run()).rejects.toThrow("requires existing");
    await absent("approval-request.json");
    await fs.writeFile(path.join(root, name), "broken");
    await expect(run()).rejects.toThrow();
    await absent("approval-request.json");
  });

  it("refuses invalid ledger totals/integrity and invalid experiment boolean", async () => {
    const ledger = parseEconomicLedger(await read("economic-ledger.json")); ledger.reserved_balance_cents++;
    await write("economic-ledger.json", ledger); await expect(run()).rejects.toThrow("mismatch");
    await fixture();
    await write("experiment.json", { ...plan, requires_real_spending: "true" });
    await expect(run()).rejects.toThrow();
    await absent("approval-request.json");
  });

  it.each(["max_amount_cents", "approved_capabilities", "human_reference", "status", "request_id", "approved_at"])("rejects changed approval field %s", async field => {
    const r = await run(); await approve(r.request_id);
    const forged = JSON.parse(await read("approval.json")); forged[field] = field === "max_amount_cents" ? 999 : "forged";
    await write("approval.json", forged);
    await expect(run()).rejects.toThrow("Modified");
    await expect(renew()).rejects.toThrow("Modified");
  });

  it.each(["approval-request.json", "approval.json", "approval-report.txt"])("fails closed when an output is missing/modified %s", async name => {
    const r = await run(); await approve(r.request_id);
    await fs.unlink(path.join(root, name));
    await expect(run()).rejects.toThrow("missing");
  });

  it("will not bootstrap around an orphan forged approval", async () => {
    await write("approval.json", { status: "approved" });
    await expect(run()).rejects.toThrow("orphan");
    await expect(fs.stat(path.join(approvalStoreRoot(root), "integrity-key"))).rejects.toThrow();
  });

  it("authenticates private history: rehashing or editing workspace artifacts cannot mint approval", async () => {
    const r = await run();
    const statePath = path.join(approvalStoreRoot(root), "state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    state.records[0].request.status = "approved";
    state.mac = createHash("sha256").update(JSON.stringify(state)).digest("hex");
    await fs.writeFile(statePath, JSON.stringify(state));
    await expect(approve(r.request_id)).rejects.toThrow("authentication");
    await absent();
  });

  it("strictly validates even authenticated malformed records (trusted fixture)", async () => {
    await run();
    const store = approvalStoreRoot(root), statePath = path.join(store, "state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    state.records[0].request.max_amount_cents = 1001;
    const { mac: _old, ...payload } = state;
    const key = Buffer.from((await fs.readFile(path.join(store, "integrity-key"), "utf8")).trim(), "hex");
    state.mac = createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex");
    await fs.writeFile(statePath, JSON.stringify(state));
    await expect(run()).rejects.toThrow("amount");
  });

  it("never regenerates a missing key or state over an existing authorization", async () => {
    await run();
    const store = approvalStoreRoot(root);
    await fs.unlink(path.join(store, "integrity-key"));
    await expect(run()).rejects.toThrow("Incomplete");
    await expect(fs.stat(path.join(store, "integrity-key"))).rejects.toThrow();
  });

  it.each(["experiment.json", "economic-ledger.json", "approval-request.json", "approval.json", "approval-report.txt"])("blocks symlink and hardlink input/output %s", async name => {
    await run();
    const outside = path.join(temp, "outside"); await fs.writeFile(outside, "untouched");
    await fs.rm(path.join(root, name), { force: true });
    await fs.symlink(outside, path.join(root, name));
    await expect(run()).rejects.toThrow();
    await fs.unlink(path.join(root, name));
    await fs.link(outside, path.join(root, name));
    await expect(run()).rejects.toThrow();
    expect(await fs.readFile(outside, "utf8")).toBe("untouched");
  });

  it.each(["state.json", "integrity-key"])("protects private anchor %s from symlinks/hardlinks", async name => {
    await run();
    const target = path.join(approvalStoreRoot(root), name), outside = path.join(temp, "outside");
    await fs.rename(target, outside); await fs.symlink(outside, target);
    await expect(run()).rejects.toThrow();
    await fs.unlink(target); await fs.link(outside, target);
    await expect(run()).rejects.toThrow();
  });

  it("blocks symlink workspaces and nonprivate integrity directories", async () => {
    const actual = root + "-actual"; await fs.rename(root, actual); await fs.symlink(actual, root);
    await expect(run()).rejects.toThrow("unsafe");
    await fs.unlink(root); await fs.rename(actual, root);
    await run(); await fs.chmod(approvalStoreRoot(root), 0o755);
    await expect(run()).rejects.toThrow("private");
  });

  it("atomically preserves previous signed state on failed decision rename", async () => {
    const r = await run(), store = approvalStoreRoot(root);
    const original = await fs.readFile(path.join(store, "state.json"), "utf8");
    vi.mocked(fs.rename).mockImplementationOnce(async (source, destination) => {
      expect(String(destination)).toBe(path.join(store, "state.json"));
      expect(JSON.parse(await fs.readFile(source, "utf8")).records[0].request.status).toBe("approved");
      expect(await fs.readFile(destination, "utf8")).toBe(original);
      throw new Error("disk failure before rename");
    });
    await expect(approve(r.request_id)).rejects.toThrow("disk failure");
    expect(await fs.readFile(path.join(store, "state.json"), "utf8")).toBe(original);
    expect((await run()).status).toBe("pending"); await absent();
  });

  it("fails closed after committed journal but failed view; never infers/repeats decision", async () => {
    const r = await run();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementationOnce(actual.rename).mockRejectedValueOnce(new Error("view failure"));
    await expect(approve(r.request_id)).rejects.toThrow("view failure");
    await expect(run()).rejects.toThrow("Modified");
    await absent();
  });

  it("rejects concurrent decisions and never steals V5/stale locks", async () => {
    const r = await run();
    const result = await Promise.allSettled([approve(r.request_id), deny(r.request_id)]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter(r => r.status === "rejected")).toHaveLength(1);
    await fs.writeFile(path.join(root, ".economic-ledger.lock"), "other V5 process");
    await expect(run()).rejects.toThrow("locked");
    vi.stubEnv("SCOUT_MODE", "ledger");
    await expect(runLedgerScout({ root })).rejects.toThrow("locked");
    expect(await read(".economic-ledger.lock")).toBe("other V5 process");
  });

  it("refuses acceptance if inputs change during a decision; stale files never authorize", async () => {
    const r = await run();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementationOnce(async (source, destination) => {
      await actual.rename(source, destination);
      await fs.appendFile(path.join(root, "experiment.json"), "\n");
    });
    await expect(approve(r.request_id)).rejects.toThrow("stale");
    await expect(run()).rejects.toThrow("stale");
  });

  it("blocks all model writes to approval artifacts and any read of the integrity anchor", async () => {
    await run();
    const tools = createLocalWorkspaceTools(root);
    expect(tools.map(t => t.name)).toEqual(["list_files", "read_file", "write_file"]);
    const writeTool = tools.find(t => t.name === "write_file")!;
    const readTool = tools.find(t => t.name === "read_file")!;
    for (const name of ["approval.json", "./approval.json", "approval-request.json", "approval-report.txt", ".approval.lock", "sub/approval.json"]) {
      expect(await (writeTool.execute as any)({ path: name, content: "forged" })).toContain("runtime-controlled");
    }
    const relative = path.relative(root, path.join(approvalStoreRoot(root), "integrity-key"));
    expect(await (readTool.execute as any)({ path: relative })).toContain("ERROR");
    expect(await (writeTool.execute as any)({ path: relative, content: "forged" })).toContain("ERROR");
  });

  it("runs actual CLI without Ollama/mission/network and requires explicit approval mode", async () => {
    const cliRoot = path.join(temp, ".automaton", "scout-workspace");
    await fs.mkdir(cliRoot, { recursive: true });
    for (const name of ["experiment.json", "economic-ledger.json"]) await fs.copyFile(path.join(root, name), path.join(cliRoot, name));
    const cli = (args: string[], mode = "approval") => promisify(execFile)(process.execPath, ["dist/index.js", ...args], {
      cwd: process.cwd(), env: { ...process.env, HOME: temp, SCOUT_MODE: mode, OLLAMA_BASE_URL: "invalid", SCOUT_MODEL: "not-a-model" }, timeout: 10000,
    });
    const pending = await cli(["--run"]); expect(pending.stdout).toContain("pending");
    const r: ApprovalRequest = JSON.parse(await fs.readFile(path.join(cliRoot, "approval-request.json"), "utf8"));
    await expect(cli(["--approve", "latest"])).rejects.toThrow();
    await expect(cli(["--approve", r.request_id], "local")).rejects.toThrow();
    expect((await cli(["--approve", r.request_id])).stdout).toContain("approved");
    expect((await cli(["--run"])).stdout).toContain("verified current binding");
    expect(parseEconomicLedger(await fs.readFile(path.join(cliRoot, "economic-ledger.json"), "utf8")).total_recorded_expenses_cents).toBe(0);
    const source = await fs.readFile("src/agent/approval-gate.ts", "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(|node:child_process|node:https?|recordLedgerEvent\s*\(|recordAuthorizedEvent\s*\(|loadLocalScoutConfig\s*\(/);
  });
});
