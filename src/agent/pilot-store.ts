/** V12.6 orchestration references and write intents, not a second business store. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { safePath, scoutWorkspaceRoot } from "./local-tools.js";
import { readConfined, atomicWrite } from "./ledger-runner.js";
import { canonicalHash, hex, time, uuid, exact, structured } from "./project-model.js";
export const STAGES = ["CREATED", "OPPORTUNITIES_READY", "ALLOCATION_READY", "PROJECTS_READY", "APPROVALS_REQUIRED", "APPROVED", "ACTIONS_PREPARED", "ACTIONS_SIMULATED", "MONITORING", "RESULTS_RECORDED", "LEARNING_UPDATED", "COMPLETED"] as const;
export type Stage = typeof STAGES[number];
export interface Pin { count: number; hash: string }
export interface StatePins { histories: Record<string, Pin>; allocation: string; research: string; external: string }
export interface PilotManifest {
  blocking_reasons: string[]; safety_violations: number; schema_version: "12.6"; mode: "DRY_RUN_ONLY"; workspace: string; run_id: string; started_at: string; completed_at: string | null;
  current_stage: Stage; status: "RUNNING" | "WAITING_FOR_HUMAN" | "COMPLETED" | "DENIED" | "BLOCKED" | "FAILED";
  source_state_fingerprint: string | null; checkpoint: StatePins;
  steps: { key: string; receipt: string }[];
  pending: { key: string; operation: PilotOperation; at: string; before: StatePins } | null;
  opportunity_ids: string[]; allocation_id: string | null; project_ids: string[]; approval_ids: string[];
  action_simulation_ids: string[]; monitoring_ids: string[]; result_ids: string[]; learning_ids: string[];
  hypothesis_id: string; passive_receipt_id: string;
  simulated_human_decisions: { request_id: string; subject_id: string; decision: "approve" | "deny"; marker: "SIMULATED_HUMAN_DECISION" }[];
}
export type PilotOperation =
  { kind: "allocation" } | { kind: "project"; args: string[] } |
  { kind: "prepare"; projectId: string } | { kind: "execute"; projectId: string; experimentId: string; actionId: string; requestId: string } |
  { kind: "monitor"; command: import("./monitoring-model.js").MonitoringCommand } |
  { kind: "learn"; command: import("./learning-model.js").LearningCommand } |
  { kind: "decision"; scope: "project" | "external"; subjectId: string; requestId: string; decision: "approve" | "deny" };
export function pilotStoreRoot(root: string) { return path.join(path.dirname(root), `.scout-pilot-${canonicalHash(root).slice(0, 32)}`); }
export async function validatePilotRoot(input: string | undefined) {
  if (!input || !path.isAbsolute(input) || input.split(path.sep).some(p => p === "." || p === "..") || path.normalize(input) !== input) throw new Error("Explicit normalized absolute SCOUT_PILOT_WORKSPACE required; traversal forbidden");
  const normal = scoutWorkspaceRoot();
  if (input === normal || input.startsWith(normal + path.sep) || normal.startsWith(input + path.sep) || input === path.parse(input).root) throw new Error("Normal economic workspace forbidden for pilot");
  await safePath(input, "pilot-dry-run.json"); // Check every existing path component without creating anything.
  return input;
}
function payload(raw: string, root: string, key: Buffer): PilotManifest {
  const envelope = exact(JSON.parse(raw), ["manifest", "mac"]), m = envelope.manifest as PilotManifest;
  const expected = createHmac("sha256", key).update(JSON.stringify(m)).digest();
  if (!timingSafeEqual(expected, Buffer.from(hex(envelope.mac), "hex"))) throw new Error("Pilot manifest authentication failed");
  exact(m, ["blocking_reasons", "safety_violations", "schema_version", "mode", "workspace", "run_id", "started_at", "completed_at", "current_stage", "status", "source_state_fingerprint", "checkpoint", "steps", "pending", "opportunity_ids", "allocation_id", "project_ids", "approval_ids", "action_simulation_ids", "monitoring_ids", "result_ids", "learning_ids", "hypothesis_id", "passive_receipt_id", "simulated_human_decisions"]);
  if (m.schema_version !== "12.6" || m.mode !== "DRY_RUN_ONLY" || m.workspace !== root || !STAGES.includes(m.current_stage) || !["RUNNING", "WAITING_FOR_HUMAN", "COMPLETED", "DENIED", "BLOCKED", "FAILED"].includes(m.status)) throw new Error("Impossible pilot state");
  if (!Array.isArray(m.blocking_reasons) || m.blocking_reasons.length > 10 || m.blocking_reasons.some(s => typeof s !== "string" || s.length > 500)) throw new Error("Invalid pilot blockers");
  if (!Number.isSafeInteger(m.safety_violations) || m.safety_violations < 0) throw new Error("Invalid safety count");
  uuid(m.run_id, "pilot"); uuid(m.hypothesis_id, "hypothesis"); uuid(m.passive_receipt_id, "receipt"); time(m.started_at);
  if (m.completed_at !== null) time(m.completed_at);
  if ((m.current_stage === "COMPLETED") !== (m.completed_at !== null) || m.status === "COMPLETED" && m.current_stage !== "COMPLETED") throw new Error("Impossible completion state");
  if (m.source_state_fingerprint !== null) hex(m.source_state_fingerprint);
  if (!Array.isArray(m.steps) || m.steps.length > 100 || new Set(m.steps.map(s => s.key)).size !== m.steps.length) throw new Error("Pilot step duplication/limit");
  for (const s of m.steps) { exact(s, ["key", "receipt"]); if (!/^[a-zA-Z0-9_-]{1,120}$/.test(s.key) || typeof s.receipt !== "string") throw new Error("Invalid pilot receipt"); }
  for (const field of ["opportunity_ids", "project_ids", "approval_ids", "action_simulation_ids", "monitoring_ids", "result_ids", "learning_ids"] as const) {
    if (!Array.isArray(m[field]) || m[field].length > 100 || new Set(m[field]).size !== m[field].length || m[field].some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(id))) throw new Error("Invalid/duplicate pilot IDs");
  }
  if (m.project_ids.length > 2 || m.approval_ids.length > 4 || m.action_simulation_ids.length > 2 || m.result_ids.length > 2) throw new Error("Pilot limits exceeded");
  return m;
}
export async function loadPilot(root: string) {
  const raw = await readConfined(root, "pilot-dry-run.json", 256 * 1024);
  const store = pilotStoreRoot(root);
  let keyRaw: string | undefined;
  try { keyRaw = await readConfined(store, "integrity-key", 65); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (raw === undefined && keyRaw === undefined) return undefined;
  if (!raw || !keyRaw || !/^[a-f0-9]{64}\n$/.test(keyRaw)) throw new Error("Incomplete pilot anchor; inspection required");
  if (((await fs.stat(store)).mode & 0o077) || ((await fs.stat(await safePath(store, "integrity-key"))).mode & 0o077)) throw new Error("Pilot anchor must be private");
  const key = Buffer.from(keyRaw.trim(), "hex"); return { manifest: payload(raw, root, key), key };
}
export async function createPilotKey(root: string) {
  const store = pilotStoreRoot(root); await safePath(store, "integrity-key", true);
  const key = randomBytes(32), fd = await fs.open(await safePath(store, "integrity-key"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(key.toString("hex") + "\n"); await fd.sync(); } finally { await fd.close(); } return key;
}
export async function savePilot(root: string, manifest: PilotManifest, key: Buffer) {
  const mac = createHmac("sha256", key).update(JSON.stringify(manifest)).digest("hex");
  await atomicWrite(root, "pilot-dry-run.json", structured({ manifest, mac }), raw => payload(raw, root, key));
}
