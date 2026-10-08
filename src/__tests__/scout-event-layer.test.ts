import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { locked } from "../agent/ledger-runner.js";
import { readControlSnapshot } from "../agent/control-snapshot.js";
import { syncControlEvents, controlEventStoreRoot } from "../agent/control-events.js";
import { CONTROL_LIMITS, EVENT_MESSAGES } from "../agent/control-model.js";
import { approvalStoreRoot, runApprovalScout } from "../agent/approval-gate.js";
import { allocationStoreRoot } from "../agent/allocation-store.js";
import { decideExistingProjectApproval } from "../agent/project-manager.js";
import { base, read, write, inMode, approvalFixture, allocationFixture, projectFixture, projectCommand, researchFixture } from "./scout-control-fixtures.js";
import { buildAttentionItems } from "../agent/tool-discovery.js";
vi.mock("node:fs/promises", async original => { const actual = await original<typeof import("node:fs/promises")>(); return { ...actual, rename: vi.fn(actual.rename) }; });
let temp: string, root: string, fetchMock: ReturnType<typeof vi.fn>;
const projectEvents = () => locked(root, async () => syncControlEvents(root, await readControlSnapshot(root)));
const eventRaw = () => fs.readFile(path.join(controlEventStoreRoot(root), "state.json"), "utf8");
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "scout-events-test-")); root = path.join(temp, "workspace"); await base(root);
  vi.stubEnv("SCOUT_MODE", "control-api"); fetchMock = vi.fn(() => { throw new Error("No network/Ollama"); }); vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => { expect(fetchMock).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await fs.rm(temp, { recursive: true, force: true }); });
describe("V12.5 authenticated bounded event projections", () => {
  it("produces deterministic contiguous sequence, durable dedup and private permissions", async () => {
    await projectFixture(root); const events = await projectEvents(); expect(events.length).toBe(3); expect(events.map(e => e.sequence)).toEqual([1, 2, 3]);
    const raw = await eventRaw(); expect(await projectEvents()).toEqual(events); expect(await eventRaw()).toBe(raw);
    expect((await fs.stat(controlEventStoreRoot(root))).mode & 0o777).toBe(0o700);
    for (const n of ["state.json", "integrity-key"]) expect((await fs.stat(path.join(controlEventStoreRoot(root), n))).mode & 0o777).toBe(0o600);
    for (const e of events) { expect(e.short_message).toBe(EVENT_MESSAGES[e.event_type]); expect(e.payload).toEqual({ action_authorized: false, capability_granted: false }); }
  });
  it("only emits PROJECT_COMPLETED from canonical close-experiment", async () => {
    const p = await projectFixture(root), args = [p.plan.project_id, "--experiment-id", p.experiment_id, "--request-id", p.approval.request.request_id];
    await locked(root, () => decideExistingProjectApproval(root, p.plan.project_id, p.approval.request.request_id, "approve"));
    await projectCommand(root, "--start-project", ...args);
    expect((await projectEvents()).some(e => e.event_type === "PROJECT_COMPLETED")).toBe(false);
    await projectCommand(root, "--close-experiment", ...args, "--expense-cents", "0", "--revenue-cents", "0", "--classification", "inconclusive", "--asset-policy", "retire");
    const events = await projectEvents(); expect(events.filter(e => e.event_type === "PROJECT_COMPLETED")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ event_type: "PROJECT_COMPLETED", subject_id: p.plan.project_id, authority: "authenticated_state" });
    expect((await locked(root, () => readControlSnapshot(root))).projects[0]).toMatchObject({ status: "fully_closed", confirmed_expense_cents: 0, confirmed_revenue_cents: 0 });
  });
  it("does not call a cancelled project completed", async () => {
    const p = await projectFixture(root); await projectCommand(root, "--cancel-project", p.plan.project_id, "--experiment-id", p.experiment_id);
    expect((await projectEvents()).some(e => e.event_type === "PROJECT_COMPLETED")).toBe(false);
  });
  it("projects V11.1 tool/attention as information with no capability or approval", async () => {
    await researchFixture(root, true); const before = await read(root, "economic-ledger.json"); const events = await projectEvents();
    expect(events.map(e => e.event_type).sort()).toEqual(["OUT_OF_BUDGET_OPPORTUNITY", "TOOL_REQUEST"]);
    expect(events.every(e => e.authority === "informational_research" && !e.payload.capability_granted)).toBe(true);
    expect((await locked(root, () => readControlSnapshot(root))).approvals).toEqual([]); expect(await read(root, "economic-ledger.json")).toBe(before);
  });
  it("projects blocked research as HUMAN_INTERVENTION_REQUIRED", async () => {
    const research = await researchFixture(root); research.status = "BLOCKED"; research.operator_attention = buildAttentionItems(research.opportunities, [], true); await write(root, "research.json", research);
    expect((await projectEvents()).some(e => e.event_type === "HUMAN_INTERVENTION_REQUIRED")).toBe(true);
  });
  it("rejects fabricated research attention and escalated capability fields", async () => {
    const research = await researchFixture(root, true); research.operator_attention[0].message = "Fake"; await write(root, "research.json", research); await expect(projectEvents()).rejects.toThrow();
    const good = await researchFixture(root, true); (good.tool_requests[0] as any).capability_granted = true; await write(root, "research.json", good); await expect(projectEvents()).rejects.toThrow();
  });
  it("prefers V12 out-of-budget projection, with one stable alert on repeated polling", async () => {
    await allocationFixture(root); const first = await projectEvents(); expect(first.filter(e => e.event_type === "OUT_OF_BUDGET_OPPORTUNITY")).toHaveLength(1);
    expect(first[0].authority).toBe("authenticated_state"); expect(await projectEvents()).toEqual(first);
    const s = await locked(root, () => readControlSnapshot(root)); expect(s.approvals).toEqual([]); expect(s.summary.reserved_cents).toBe(0); expect(s.summary.confirmed_spent_cents).toBe(0);
  });
  it("marks allocation stale after canonical approval decision and never modifies proposal", async () => {
    await approvalFixture(root); await allocationFixture(root); const raw = await read(root, "capital-allocation.json");
    await inMode("approval", () => runApprovalScout({ root, command: { kind: "new-request" } }));
    expect((await locked(root, () => readControlSnapshot(root))).allocation?.stale).toBe(true); expect(await read(root, "capital-allocation.json")).toBe(raw);
  });
  it("rejects orphan public allocation rather than trusting presentation JSON", async () => {
    await allocationFixture(root); await fs.rm(allocationStoreRoot(root), { recursive: true }); await expect(projectEvents()).rejects.toThrow();
  });
  it("detects authenticated source rollback without changing journal", async () => {
    await approvalFixture(root); await projectEvents(); const old = await fs.readFile(path.join(approvalStoreRoot(root), "state.json")), names = ["approval-request.json", "approval-report.txt"];
    const oldViews = await Promise.all(names.map(n => read(root, n)));
    await inMode("approval", () => runApprovalScout({ root, command: { kind: "new-request" } })); await projectEvents(); const before = await eventRaw();
    await fs.writeFile(path.join(approvalStoreRoot(root), "state.json"), old);
    for (const [i, n] of names.entries()) await fs.writeFile(path.join(root, n), oldViews[i]);
    await expect(projectEvents()).rejects.toThrow("rollback"); expect(await eventRaw()).toBe(before);
  });
  it("rejects event HMAC tampering without repair", async () => {
    await projectEvents(); const raw = JSON.parse(await eventRaw()); raw.workspace = "/evil"; await fs.writeFile(path.join(controlEventStoreRoot(root), "state.json"), JSON.stringify(raw));
    await expect(projectEvents()).rejects.toThrow("authentication"); expect(JSON.parse(await eventRaw()).workspace).toBe("/evil");
  });
  it.each(["integrity-key", "state.json"])("does not regenerate missing %s", async name => {
    await projectEvents(); await fs.unlink(path.join(controlEventStoreRoot(root), name)); await expect(projectEvents()).rejects.toThrow("Incomplete");
    await expect(fs.stat(path.join(controlEventStoreRoot(root), name))).rejects.toThrow();
  });
  it.each(["integrity-key", "state.json"])("rejects hardlink %s", async name => {
    await projectEvents(); await fs.link(path.join(controlEventStoreRoot(root), name), path.join(temp, "link")); await expect(projectEvents()).rejects.toThrow("unsafe");
  });
  it.each(["integrity-key", "state.json"])("rejects symlink %s", async name => {
    await projectEvents(); const file = path.join(controlEventStoreRoot(root), name), saved = path.join(temp, "saved"); await fs.rename(file, saved); await fs.symlink(saved, file); await expect(projectEvents()).rejects.toThrow("unsafe");
  });
  it("rejects workspace and store directory symlinks", async () => {
    const other = path.join(temp, "other"); await fs.rename(root, other); await fs.symlink(other, root); await expect(projectEvents()).rejects.toThrow("unsafe");
    await fs.unlink(root); await fs.rename(other, root); await projectEvents(); const store = controlEventStoreRoot(root); await fs.rename(store, other); await fs.symlink(other, store); await expect(projectEvents()).rejects.toThrow("unsafe");
  });
  it.each(["integrity-key", "state.json", "."])("rejects permissive event permissions %s", async name => {
    await projectEvents(); await fs.chmod(path.join(controlEventStoreRoot(root), name), name === "." ? 0o755 : 0o644); await expect(projectEvents()).rejects.toThrow("private");
  });
  it("enforces journal bound with no eviction or sequence reuse", async () => {
    // Exercise real signing/writes/parse with 1024 bounded projections, not 1024 costly fixtures.
    const snapshot = await locked(root, () => readControlSnapshot(root));
    snapshot.projections = Array.from({ length: CONTROL_LIMITS.events }, (_, i) => ({ attention_id: `fixture-${i}`, event_type: "HUMAN_INTERVENTION_REQUIRED" as const,
      subject_type: "research" as const, subject_id: "research-provider", source_ref: `fixture-${i}`, authority: "informational_research" as const, requires_human_action: true, created_at: null }));
    const first = await locked(root, () => syncControlEvents(root, snapshot)); expect(first.at(-1)?.sequence).toBe(CONTROL_LIMITS.events); const before = await eventRaw();
    snapshot.projections.push({ ...snapshot.projections[0], source_ref: "overflow" });
    await expect(locked(root, () => syncControlEvents(root, snapshot))).rejects.toThrow("full"); expect(await eventRaw()).toBe(before);
  });
  it("interrupted initial atomic write fails closed with no regenerated key", async () => {
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("simulated interruption"));
    await expect(projectEvents()).rejects.toThrow("interruption");
    const key = await fs.readFile(path.join(controlEventStoreRoot(root), "integrity-key"));
    await expect(projectEvents()).rejects.toThrow("Incomplete event anchor");
    expect(await fs.readFile(path.join(controlEventStoreRoot(root), "integrity-key"))).toEqual(key);
  });
  it("rejects semantically invalid signed sequence (schema defense)", async () => {
    await projectFixture(root); await projectEvents(); const d = JSON.parse(await eventRaw()); d.events[0].sequence = 99;
    const { mac, ...state } = d, key = Buffer.from((await fs.readFile(path.join(controlEventStoreRoot(root), "integrity-key"), "utf8")).trim(), "hex");
    d.mac = createHmac("sha256", key).update(JSON.stringify(state)).digest("hex"); await fs.writeFile(path.join(controlEventStoreRoot(root), "state.json"), JSON.stringify(d));
    await expect(projectEvents()).rejects.toThrow("event contract");
  });
});
