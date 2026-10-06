/** Authenticated V9 history, exact public projections and V5 atomic storage. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { safePath } from "./local-tools.js";
import { readConfined, atomicWrite } from "./ledger-runner.js";
import { PROJECT_LIMITS } from "./asset-lifecycle.js";
import { digest, exact, hex, structured, projectMetrics, type ProjectEvent, type ProjectModel } from "./project-model.js";
import { parseEconomicLedger, buildEconomicReport, LEDGER_LIMITS, type EconomicLedger } from "./economic-ledger.js";
export interface ProjectState { version: 9; workspace: string; phase: "prepared" | "complete"; events: ProjectEvent[] }
export const PROJECT_FILES = ["project-batch.json", "projects.json", "assets.json", "project-report.txt"];
export function projectStoreRoot(root: string): string { return path.join(path.dirname(path.resolve(root)), `.scout-projects-${digest(path.resolve(root)).slice(0, 32)}`); }
const sign = (state: ProjectState, key: Buffer) => createHmac("sha256", key).update(JSON.stringify(state)).digest("hex");
function decode(raw: string, root: string, key: Buffer): ProjectState {
  const d = exact(JSON.parse(raw), ["version", "workspace", "phase", "events", "mac"]);
  const state = { version: d.version, workspace: d.workspace, phase: d.phase, events: d.events } as ProjectState;
  if (!timingSafeEqual(Buffer.from(hex(d.mac), "hex"), Buffer.from(sign(state, key), "hex"))) throw new Error("Project history authentication failed");
  if (state.version !== 9 || state.workspace !== root || !["prepared", "complete"].includes(state.phase) || !Array.isArray(state.events) || !state.events.length || state.events.length > PROJECT_LIMITS.MAX_EVENTS) throw new Error("Invalid project history");
  return state;
}
export async function loadProjectState(root: string): Promise<{ state?: ProjectState; key?: Buffer }> {
  const store = projectStoreRoot(root);
  try { await fs.lstat(store); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
  await safePath(store, "state.json");
  if (((await fs.stat(store)).mode & 0o077) !== 0) throw new Error("Project store must be private (0700)");
  const keyRaw = await readConfined(store, "integrity-key", 65), raw = await readConfined(store, "state.json", PROJECT_LIMITS.MAX_BYTES);
  if (!keyRaw || raw === undefined || !/^[a-f0-9]{64}\n$/.test(keyRaw)) throw new Error("Incomplete project anchor; human inspection required");
  for (const name of ["integrity-key", "state.json"]) if (((await fs.stat(await safePath(store, name))).mode & 0o077) !== 0) throw new Error("Project files must be private (0600)");
  const key = Buffer.from(keyRaw.trim(), "hex"), state = decode(raw, root, key);
  if (state.phase !== "complete") throw new Error("Incomplete project transaction; human inspection required; no automatic replay");
  return { state, key };
}
export function projectViews(model: ProjectModel): (string | undefined)[] {
  if (!model.batch) return PROJECT_FILES.map(() => undefined);
  const projects = model.projects.map(p => ({ ...p, metrics: projectMetrics(p) }));
  return [structured(model.batch), structured({ version: 9, projects }),
    structured({ version: 9, assets: projects.filter(p => p.asset).map(p => ({ project_id: p.plan.project_id, experiment_id: p.experiment_id, ...p.asset!, metrics: p.metrics })) }),
    ["Scout V9 — Multi-Project Real Experiment Manager", "NO REAL MONEY IS SPENT BY V9", "2 projets maximum, 1000 cents/projet, 2000 cents/batch, 7 jours/expérience.",
      `Batch : ${model.batch.batch_id}`, ...projects.map(p => `${p.plan.project_id} | ${p.experiment_id} | ${p.plan.name} | ${p.status} | asset=${p.asset?.status ?? "none"} | lifetime_net_cents=${p.metrics.lifetime_net_result_cents}`),
      "Réservation et comptabilité locales uniquement. Le rapport ne constitue pas une approbation.", ""].join("\n")];
}
export async function checkProjectViews(root: string, model: ProjectModel): Promise<void> {
  const expected = projectViews(model);
  for (const [i, name] of PROJECT_FILES.entries()) if (await readConfined(root, name, PROJECT_LIMITS.MAX_BYTES) !== expected[i]) throw new Error(`Modified, missing or orphan ${name}`);
}
async function persistState(root: string, state: ProjectState, key: Buffer): Promise<void> {
  const raw = structured({ ...state, mac: sign(state, key) });
  if (Buffer.byteLength(raw) > PROJECT_LIMITS.MAX_BYTES) throw new Error("Project history size limit");
  await atomicWrite(projectStoreRoot(root), "state.json", raw, v => decode(v, root, key));
  if (await readConfined(projectStoreRoot(root), "state.json", PROJECT_LIMITS.MAX_BYTES) !== raw) throw new Error("Project history reread mismatch");
}
/** Caller holds the V5–V9 shared lock and has replayed all records first.
 * Durable intent -> ledger -> views -> complete. Partial commits stay blocked. */
export async function commitProjectState(root: string, state: ProjectState, previous: ProjectModel, next: ProjectModel,
  oldLedgerRaw: string, ledger: EconomicLedger, storedKey: Buffer | undefined): Promise<void> {
  const views = projectViews(next), nextRaw = JSON.stringify(parseEconomicLedger(oldLedgerRaw)) === JSON.stringify(ledger) ? oldLedgerRaw : structured(ledger);
  if (Buffer.byteLength(structured({ ...state, mac: "0".repeat(64) })) > PROJECT_LIMITS.MAX_BYTES || views.some(v => v && Buffer.byteLength(v) > PROJECT_LIMITS.MAX_BYTES)) throw new Error("Project history/view size limit");
  for (const name of [...PROJECT_FILES, "economic-ledger.json", "economic-report.txt"]) await safePath(root, name);
  await checkProjectViews(root, previous);
  if (await readConfined(root, "economic-ledger.json", LEDGER_LIMITS.maxBytes) !== oldLedgerRaw) throw new Error("Ledger changed before V9 commit");
  let key = storedKey;
  if (!key) {
    const store = projectStoreRoot(root); await safePath(store, "integrity-key", true); key = randomBytes(32);
    const file = await fs.open(await safePath(store, "integrity-key"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(key.toString("hex") + "\n"); await file.sync(); } finally { await file.close(); }
  }
  await persistState(root, { ...state, phase: "prepared" }, key);
  if (await readConfined(root, "economic-ledger.json", LEDGER_LIMITS.maxBytes) !== oldLedgerRaw) throw new Error("Ledger changed during V9 commit");
  await checkProjectViews(root, previous);
  if (nextRaw !== oldLedgerRaw) await atomicWrite(root, "economic-ledger.json", nextRaw, parseEconomicLedger);
  for (const [i, name] of PROJECT_FILES.entries()) {
    const content = views[i]!;
    await atomicWrite(root, name, content, raw => { if (raw !== content) throw new Error("Project view write mismatch"); });
  }
  if (nextRaw !== oldLedgerRaw) {
    const report = buildEconomicReport(ledger);
    await atomicWrite(root, "economic-report.txt", report, raw => { if (raw !== report) throw new Error("Economic report mismatch"); });
  }
  if (await readConfined(root, "economic-ledger.json", LEDGER_LIMITS.maxBytes) !== nextRaw) throw new Error("V9 ledger reread mismatch");
  await checkProjectViews(root, next);
  await persistState(root, { ...state, phase: "complete" }, key);
}
