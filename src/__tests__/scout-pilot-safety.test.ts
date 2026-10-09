import { beforeAll, beforeEach, afterAll, afterEach, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import dns from "node:dns/promises";
import https from "node:https";
import childProcess from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { runPilotDryRun } from "../agent/pilot-dry-run.js";
import { pilotStoreRoot } from "../agent/pilot-store.js";
import { inPilotContext } from "../agent/pilot-context.js";
import { scoutWorkspaceRoot, createLocalWorkspaceTools } from "../agent/local-tools.js";
import { workspaceFingerprint } from "../agent/pilot-workspace-proof.js";
import { readProjectContext, runProjectScout, parseProjectCommand } from "../agent/project-manager.js";
import { runExternalScout, readVerifiedExternalRecords } from "../agent/external-gateway.js";
import { projectStoreRoot } from "../agent/project-store.js";
import { DryRunExternalTransport } from "../agent/pilot-transport.js";
import { inMode, researchFixture } from "./scout-control-fixtures.js";
import { initializeLedger } from "../agent/economic-ledger.js";
import { runAllocationScout } from "../agent/allocation-runner.js";
let temp: string, root: string, paused: any, previous: string | undefined;
beforeAll(() => { previous = process.env.SCOUT_MODE; process.env.SCOUT_MODE = "pilot-dry-run"; });
afterAll(() => { if (previous === undefined) delete process.env.SCOUT_MODE; else process.env.SCOUT_MODE = previous; });
beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), "pilot-safety-")); root = path.join(temp, "workspace"); await fs.mkdir(root); paused = await runPilotDryRun({ root, command: "run" }); });
afterEach(async () => { await fs.rm(temp, { recursive: true, force: true }); });
const resume = () => runPilotDryRun({ root, command: "resume" });
const decision = (a: any, kind: "approve" | "deny" = "approve") => runPilotDryRun({ root, command: "resume", decision: { requestId: a.request_id, subjectId: a.subject_id, decision: kind } });
async function signedMutation(change: (m: any) => void) {
  const file = path.join(root, "pilot-dry-run.json"), envelope = JSON.parse(await fs.readFile(file, "utf8")); change(envelope.manifest);
  const key = Buffer.from((await fs.readFile(path.join(pilotStoreRoot(root), "integrity-key"), "utf8")).trim(), "hex");
  envelope.mac = createHmac("sha256", key).update(JSON.stringify(envelope.manifest)).digest("hex"); await fs.writeFile(file, JSON.stringify(envelope));
}
it("missing approval produces attention and no V8 action", async () => {
  expect(paused.approvals).toHaveLength(2); expect(paused.attention.filter((a: any) => a.event_type === "APPROVAL_REQUIRED")).toHaveLength(2);
  expect(await readVerifiedExternalRecords(root)).toEqual([]); expect((await readProjectContext(root)).ledger.total_recorded_expenses_cents).toBe(0);
});
it("B missing decision pauses cleanly after A approval", async () => {
  await decision(paused.approvals[0]); const again = await resume(); expect(again.approvals).toHaveLength(1);
  expect(await readVerifiedExternalRecords(root)).toEqual([]); expect(again.manifest.status).toBe("WAITING_FOR_HUMAN");
});
it("resumes after the explicit simulated human decision", async () => {
  for (const a of paused.approvals) await decision(a);
  const again = await resume(); expect(again.manifest.current_stage).toBe("ACTIONS_PREPARED"); expect(again.approvals[0].scope).toBe("external");
});
it("V8 remains unexecuted until its own V6 approval", async () => {
  for (const a of paused.approvals) await decision(a); await resume();
  const records = await readVerifiedExternalRecords(root); expect(records).toHaveLength(1); expect(records[0].execution).toBeNull();
});
it("same approval double click is idempotent", async () => {
  await decision(paused.approvals[0]); const before = await fs.readFile(path.join(root, "projects.json"), "utf8"); await decision(paused.approvals[0]);
  expect(await fs.readFile(path.join(root, "projects.json"), "utf8")).toBe(before);
});
it("wrong project approval is rejected", async () => {
  await expect(decision({ ...paused.approvals[0], subject_id: paused.approvals[1].subject_id })).rejects.toThrow(/binding/);
});
it("unknown approval ID is rejected", async () => {
  await expect(decision({ ...paused.approvals[0], request_id: `request-${randomUUID()}` })).rejects.toThrow(/binding/);
});
it("conflicting approval retry is rejected", async () => { await decision(paused.approvals[0]); await expect(decision(paused.approvals[0], "deny")).rejects.toThrow(); });
it("denial cancels B, releases its reservation and allows approved A to finish", async () => {
  const context = await readProjectContext(root), b = context.model.projects.find(p => p.plan.name === "B")!;
  for (const a of paused.approvals) await decision(a, a.subject_id === b.plan.project_id ? "deny" : "approve");
  let result: any;
  for (let i = 0; i < 4; i++) { result = await resume(); if (result.manifest.current_stage === "COMPLETED") break; for (const a of result.approvals) await decision(a); }
  const final = await readProjectContext(root), denied = final.model.projects.find(p => p.plan.name === "B")!;
  expect(denied.status).toBe("cancelled"); expect(denied.external_actions).toEqual([]); expect(denied.result).toBeNull();
  expect(final.ledger.total_recorded_expenses_cents).toBe(700); expect(final.ledger.reserved_balance_cents).toBe(0);
  expect(result.report.technical_readiness).toBe("NOT_READY_FOR_SUPERVISED_REAL_PILOT");
});
it("denied external approval produces no V8 attempt or expense for its project", async () => {
  for (const a of paused.approvals) await decision(a); const externalWait = await resume(); await decision(externalWait.approvals[0], "deny");
  await resume(); const records = await readVerifiedExternalRecords(root); expect(records[0].execution).toBeNull();
  const p = (await readProjectContext(root)).model.projects.find(p => p.external_actions.some(a => a.action_id === records[0].action.action_id))!;
  expect(p.result?.experiment_expense_cents).toBe(0); expect(p.result?.classification).toBe("cancelled");
});
it("refuses stale source state rather than silently reallocating", async () => {
  const file = path.join(root, "research.json"), research = JSON.parse(await fs.readFile(file, "utf8")); research.metrics.changed = true; await fs.writeFile(file, JSON.stringify(research));
  await expect(resume()).rejects.toThrow(/fingerprint/);
});
it("refuses allocation staleness between allocation and project creation", async () => {
  const fresh = path.join(temp, "fresh"); await fs.mkdir(fresh);
  await expect(runPilotDryRun({ root: fresh, command: "run", fault: point => { if (point === "after:allocation") throw new Error("interrupt"); } })).rejects.toThrow("interrupt");
  const file = path.join(fresh, "research.json"), r = JSON.parse(await fs.readFile(file, "utf8")); r.metrics.changed = true; await fs.writeFile(file, JSON.stringify(r));
  await expect(runPilotDryRun({ root: fresh, command: "resume" })).rejects.toThrow(/fingerprint/);
  expect((await readProjectContext(fresh)).model.projects).toHaveLength(0);
});
it("manifest JSON corruption fails closed", async () => { await fs.writeFile(path.join(root, "pilot-dry-run.json"), "{"); await expect(resume()).rejects.toThrow(); });
it("manifest authentication corruption fails closed", async () => {
  const file = path.join(root, "pilot-dry-run.json"), m = JSON.parse(await fs.readFile(file, "utf8")); m.mac = "0".repeat(64); await fs.writeFile(file, JSON.stringify(m)); await expect(resume()).rejects.toThrow(/authentication/);
});
it("unknown canonical ID fails even in a signed manifest", async () => { await signedMutation(m => { m.project_ids[0] = `project-${randomUUID()}`; }); await expect(resume()).rejects.toThrow(/reference/); });
it("incorrect allocation fingerprint fails closed", async () => { await signedMutation(m => { m.source_state_fingerprint = "0".repeat(64); }); await expect(resume()).rejects.toThrow(/reference/); });
it("impossible skipped approval state fails closed", async () => { await signedMutation(m => { m.current_stage = "ACTIONS_SIMULATED"; }); await expect(resume()).rejects.toThrow(/Impossible/); });
it("authenticated canonical project store corruption is refused", async () => {
  await fs.writeFile(path.join(projectStoreRoot(root), "state.json"), "{}"); await expect(resume()).rejects.toThrow();
});
it.each(["pilot-dry-run.json", "economic-ledger.json"])("rejects a symlink at %s", async name => {
  const target = path.join(temp, "target"); await fs.rename(path.join(root, name), target); await fs.symlink(target, path.join(root, name)); await expect(resume()).rejects.toThrow(/unsafe/i);
});
it.each(["pilot-dry-run.json", "economic-ledger.json"])("rejects a hardlink at %s", async name => { await fs.link(path.join(root, name), path.join(temp, "alias")); await expect(resume()).rejects.toThrow(/unsafe/i); });
it("rejects a symlink workspace", async () => { const alias = path.join(temp, "alias"); await fs.symlink(root, alias); await expect(runPilotDryRun({ root: alias, command: "resume" })).rejects.toThrow(/unsafe/); });
it("rejects traversal", async () => { await expect(runPilotDryRun({ root: root + "/../workspace", command: "resume" })).rejects.toThrow(/traversal/); });
it("refuses the normal economic workspace and its descendants", async () => {
  const before = await workspaceFingerprint(scoutWorkspaceRoot());
  for (const target of [scoutWorkspaceRoot(), path.join(scoutWorkspaceRoot(), "pilot")]) await expect(runPilotDryRun({ root: target, command: "run" })).rejects.toThrow(/Normal/);
  expect(await workspaceFingerprint(scoutWorkspaceRoot())).toBe(before);
});
it("requires an explicitly selected dedicated root", async () => {
  const saved = process.env.SCOUT_PILOT_WORKSPACE; delete process.env.SCOUT_PILOT_WORKSPACE;
  try { await expect(runPilotDryRun({ command: "run" })).rejects.toThrow(/Explicit/); } finally { if (saved !== undefined) process.env.SCOUT_PILOT_WORKSPACE = saved; }
});
it("blocks normal V9 and native V8 writers on a pilot workspace", async () => {
  await expect(inMode("projects", () => runProjectScout({ root, command: parseProjectCommand(["--create-batch"]) }))).rejects.toThrow(/Pilot workspace/);
  const old = process.env.SCOUT_V8_WEBHOOK_URL; process.env.SCOUT_V8_WEBHOOK_URL = "https://example.com/ping";
  try { await expect(inMode("external", () => runExternalScout({ root, command: { kind: "prepare" } }))).rejects.toThrow(/Pilot V8/); } finally { if (old === undefined) delete process.env.SCOUT_V8_WEBHOOK_URL; else process.env.SCOUT_V8_WEBHOOK_URL = old; }
});
it("concurrent runners cannot duplicate projects or approvals", async () => {
  const fresh = path.join(temp, "concurrent"); await fs.mkdir(fresh);
  const results = await Promise.allSettled([runPilotDryRun({ root: fresh, command: "run" }), runPilotDryRun({ root: fresh, command: "run" })]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  expect((await readProjectContext(fresh)).model.projects).toHaveLength(2);
});
it("does not steal a live lock", async () => {
  await fs.writeFile(path.join(root, ".economic-ledger.lock"), JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })); await expect(resume()).rejects.toThrow(/live/);
});
it("runtime-owned manifest cannot be overwritten by a model tool", async () => {
  const tool = createLocalWorkspaceTools(root).find(t => t.name === "write_file")!;
  expect(await tool.execute({ path: "pilot-dry-run.json", content: "{}" }, {} as any)).toMatch(/runtime-controlled/);
});
it.each(["public_https", "public_socket", "ollama", "dns", "shell", "payment", "publication", "external_account"])("network guard rejects %s before any operation", async kind => {
  const guard = { attempts: 0, port: null };
  await inPilotContext({ root, mode: "pilot-dry-run", now: new Date().toISOString(), lockHeld: false, guard }, async () => {
    const attempt = () => kind === "public_https" ? https.get("https://example.com") : kind === "public_socket" ? new net.Socket().connect(443, "example.com") :
      kind === "ollama" ? new net.Socket().connect(11434, "127.0.0.1") : kind === "dns" ? dns.lookup("example.com") : kind === "shell" ? childProcess.execFileSync("/bin/true") : fetch(`https://example.com/${kind}`, { method: "POST" });
    await expect(Promise.resolve().then(attempt)).rejects.toThrow(/DRY_RUN_ONLY/);
  }); expect(guard.attempts).toBe(1);
});
it("dry-run transport refuses use outside an explicit pilot context", async () => { await expect(new DryRunExternalTransport().resolve("scout-pilot.invalid")).rejects.toThrow(/Dry-run/); });
it("insufficient confirmed capital remains bounded by the real V12 allocator", async () => {
  const small = path.join(temp, "small"); await fs.mkdir(small); await fs.writeFile(path.join(small, "economic-ledger.json"), JSON.stringify(initializeLedger(900))); await researchFixture(small);
  const allocation = await inMode("allocation", () => runAllocationScout({ root: small, command: { kind: "calculate", input: "research.json" } }));
  expect(allocation.proposal.selected_projects).toHaveLength(0); expect(allocation.proposal.total_proposed_cents).toBe(0);
});
it.each(["--real", "--pay", "--spend", "--publish", "--live-money"])("CLI refuses %s", async flag => {
  const { runPilotCli } = await import("../agent/pilot-dry-run.js"); await expect(runPilotCli([flag])).rejects.toThrow(/accepts/);
});
it("a blocked dependency attempt remains a durable readiness blocker", async () => {
  const fresh = path.join(temp, "guard-failure"); await fs.mkdir(fresh);
  await expect(runPilotDryRun({ root: fresh, command: "run", fault: point => { if (point === "after:allocation") https.get("https://example.com"); } })).rejects.toThrow(/DRY_RUN_ONLY/);
  const { loadPilot } = await import("../agent/pilot-store.js"); expect((await loadPilot(fresh))!.manifest.safety_violations).toBe(1);
  expect((await runPilotDryRun({ root: fresh, command: "resume" })).manifest.safety_violations).toBe(1);
});
it("estimated revenue in research never becomes usable allocation capital", async () => {
  const small = path.join(temp, "expected"); await fs.mkdir(small); await fs.writeFile(path.join(small, "economic-ledger.json"), JSON.stringify(initializeLedger(900)));
  const research = await researchFixture(small); research.opportunities[0].summary = "Hypothèse non confirmée : revenu attendu 100000 EUR"; await fs.writeFile(path.join(small, "research.json"), JSON.stringify(research));
  const allocation = await inMode("allocation", () => runAllocationScout({ root: small, command: { kind: "calculate", input: "research.json" } }));
  expect(allocation.proposal.confirmed_available_cents).toBe(900); expect(allocation.proposal.selected_projects).toHaveLength(0);
});
it("restarts after project creation without duplicating its canonical event", async () => {
  const fresh = path.join(temp, "project-restart"); await fs.mkdir(fresh);
  await expect(runPilotDryRun({ root: fresh, command: "run", fault: point => { if (point.startsWith("after-effect:project-research")) throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
  const result = await runPilotDryRun({ root: fresh, command: "resume" }); expect(result.manifest.project_ids).toHaveLength(2);
  expect((await readProjectContext(fresh)).state!.events.filter(e => e.command.operation === "create-project")).toHaveLength(2);
});
it("restarts after a monitoring checkpoint without a second observation", async () => {
  for (const a of paused.approvals) await decision(a);
  let fired = false;
  for (let i = 0; i < 4; i++) {
    try {
      const result = await runPilotDryRun({ root, command: "resume", fault: point => { if (point.startsWith("after-effect:monitor-day_3")) { fired = true; throw new Error("interrupted"); } } });
      for (const a of result.approvals) await decision(a);
    } catch (e) { if ((e as Error).message !== "interrupted") throw e; break; }
  }
  expect(fired).toBe(true); const completed: any = await resume(); expect(completed.manifest.monitoring_ids).toHaveLength(14);
  expect(new Set(completed.manifest.monitoring_ids).size).toBe(14);
}, 60_000);
it("two distinct processes cannot create two contradictory pilot runs", async () => {
  const fresh = path.join(temp, "processes"); await fs.mkdir(fresh);
  const code = 'import {runPilotDryRun} from "./dist/agent/pilot-dry-run.js"; try { await runPilotDryRun({root:process.argv[1],command:"run"}); } catch { process.exitCode=1; }';
  const child = () => new Promise<number | null>((resolve, reject) => {
    const p = childProcess.spawn(process.execPath, ["--input-type=module", "-e", code, fresh], { env: { ...process.env, NODE_OPTIONS: "" }, stdio: "ignore" }); p.on("error", reject); p.on("exit", resolve);
  });
  const codes = await Promise.all([child(), child()]); expect(codes).toContain(0); expect(codes.every(v => v === 0 || v === 1)).toBe(true);
  const result = await runPilotDryRun({ root: fresh, command: "resume" }); expect(result.manifest.project_ids).toHaveLength(2); expect(result.manifest.approval_ids).toHaveLength(2);
});
it("wrong V8 approval/project association is rejected before simulation", async () => {
  for (const a of paused.approvals) await decision(a); const externalWait = await resume(); await decision(externalWait.approvals[0]);
  const record = (await readVerifiedExternalRecords(root))[0], project = (await readProjectContext(root)).model.projects.find(p => !p.external_actions.length)!;
  await expect(inPilotContext({ root, mode: "external", now: externalWait.manifest.started_at, lockHeld: false, guard: { attempts: 0, port: null } }, () => runExternalScout({ root,
    command: { kind: "execute", actionId: record.action.action_id, requestId: record.approval.request.request_id, projectId: project.plan.project_id, experimentId: project.experiment_id, preview: false } }))).rejects.toThrow(/binding/);
  expect((await readVerifiedExternalRecords(root))[0].execution).toBeNull();
});
it("external approval retry is idempotent and cannot implicitly execute", async () => {
  for (const a of paused.approvals) await decision(a); const externalWait = await resume(); await decision(externalWait.approvals[0]); await decision(externalWait.approvals[0]);
  expect((await readVerifiedExternalRecords(root))[0].execution).toBeNull();
});
it("rejects a symlink mutex before recovering any lock", async () => {
  const file = path.join(pilotStoreRoot(root), "mutex.sqlite"), target = path.join(temp, "mutex-target"); await fs.rename(file, target); await fs.symlink(target, file); await expect(resume()).rejects.toThrow(/unsafe/);
});
it("rejects a hardlink integrity key", async () => {
  await fs.link(path.join(pilotStoreRoot(root), "integrity-key"), path.join(temp, "key-alias")); await expect(resume()).rejects.toThrow(/unsafe/);
});
it("refuses a new reservation appearing after allocation", async () => {
  const fresh = path.join(temp, "ledger-stale"); await fs.mkdir(fresh);
  await expect(runPilotDryRun({ root: fresh, command: "run", fault: point => { if (point === "after:allocation") throw new Error("interrupt"); } })).rejects.toThrow("interrupt");
  const { reserveExperiment, parseEconomicLedger } = await import("../agent/economic-ledger.js"), { plan } = await import("./scout-control-fixtures.js");
  const file = path.join(fresh, "economic-ledger.json"), ledger = parseEconomicLedger(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify(reserveExperiment(ledger, { ...plan, experiment_budget_eur: 1, requires_real_spending: true })));
  await expect(runPilotDryRun({ root: fresh, command: "resume" })).rejects.toThrow(/fingerprint/);
  expect((await readProjectContext(fresh)).model.projects).toHaveLength(0);
});
