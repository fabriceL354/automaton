import { pilotContext } from "./pilot-context.js";
/** Local storage boundary for V5. No Ollama or Web calls, even at startup. */
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { safePath, scoutWorkspaceRoot } from "./local-tools.js";
import { scoutMode } from "./opportunity-scout.js";
import {
  LEDGER_LIMITS, initialCapitalCents, initializeLedger, parseEconomicLedger, parseLedgerExperiment,
  reserveExperiment, recordAuthorizedEvent, buildEconomicReport,
  type AuthorizedLedgerEvent, type EconomicLedger,
} from "./economic-ledger.js";

const LEDGER = "economic-ledger.json";
const REPORT = "economic-report.txt";
const LOCK = ".economic-ledger.lock";

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

export async function readConfined(root: string, name: string, maxBytes: number): Promise<string | undefined> {
  const target = await safePath(root, name);
  let file;
  try { file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (missing(error)) return undefined; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error(`Unsafe or oversized ${name}`);
    const value = await file.readFile("utf8");
    if (Buffer.byteLength(value) > maxBytes) throw new Error(`Oversized ${name}`);
    return value;
  } finally { await file.close(); }
}

/** Same-directory exclusive temporary file + fsync + atomic rename. */
export async function atomicWrite(root: string, name: string, content: string, validate: (raw: string) => unknown): Promise<void> {
  if (Buffer.byteLength(content) > LEDGER_LIMITS.maxBytes) throw new Error("Economic artifact exceeds size limit");
  validate(content);
  const target = await safePath(root, name);
  const temporary = await safePath(root, `.economic-ledger-${randomUUID()}.tmp`);
  const file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    try { await file.writeFile(content, "utf8"); await file.sync(); }
    finally { await file.close(); }
    const reread = await readConfined(root, path.basename(temporary), LEDGER_LIMITS.maxBytes);
    if (reread !== content) throw new Error("Economic temporary file verification failed");
    validate(reread);
    await safePath(root, name); // Recheck destination immediately before replacement.
    await fs.rename(temporary, target);
    renamed = true;
    const directory = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (!renamed) await fs.unlink(temporary);
  }
}

/** Exclusive across Scout processes; never steal or auto-expire a stale lock. */
export async function locked<T>(root: string, operation: () => Promise<T>, preparationScope?: "preparation" | "control-read"): Promise<T> {
  if (preparationScope && (pilotContext()?.mode ?? process.env.SCOUT_MODE) !== (preparationScope === "preparation" ? "pilot-preparation" : "control-api")) throw new Error("Explicit preparation lock scope required");
  // V12.7 earmarks share this lock but do not alter V5. Once the preparation
  // anchor exists, legacy writers cannot commit parallel budgets or actions.
  // The check belongs INSIDE the acquired lock below to close startup races.
  const pilot = pilotContext();
  if (pilot) {
    if (root !== pilot.root) throw new Error("Pilot workspace escape");
    if (pilot.lockHeld) return operation();
  }
  if (!pilot) {
    try { if (await readConfined(root, "pilot-dry-run.json", 256 * 1024) !== undefined) throw new Error("Pilot workspace requires the dry-run host"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  await safePath(root, LOCK, true);
  const lockPath = path.join(root, LOCK);
  let lock;
  try { lock = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Ledger locked: another run or stale lock; human inspection required");
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }) + "\n");
    await lock.sync();
    if (!preparationScope) {
      const store = path.join(path.dirname(root), `.scout-preparation-${createHash("sha256").update(JSON.stringify(root)).digest("hex").slice(0, 32)}`);
      try { await fs.lstat(store); await safePath(store, "state.json"); throw new Error("Preparation workspace is sealed against legacy writers; human inspection required"); }
      catch (e) { if (!missing(e)) throw e; }
    }
    return await operation();
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

async function save(root: string, currentRaw: string | undefined, ledger: EconomicLedger, report: string): Promise<void> {
  // Detect pre-existing unsafe destinations before committing either artifact.
  await safePath(root, LEDGER);
  await safePath(root, REPORT);
  const structured = JSON.stringify(ledger, null, 2) + "\n";
  if (currentRaw === undefined || JSON.stringify(parseEconomicLedger(currentRaw)) !== JSON.stringify(ledger)) {
    await atomicWrite(root, LEDGER, structured, parseEconomicLedger);
  }
  const verified = await readConfined(root, LEDGER, LEDGER_LIMITS.maxBytes);
  if (verified === undefined || JSON.stringify(parseEconomicLedger(verified)) !== JSON.stringify(ledger)) throw new Error("Ledger reread verification failed");
  // The ledger is authoritative. If report writing fails, next ledger run
  // regenerates it without duplicating a reservation or economic event.
  await atomicWrite(root, REPORT, report, raw => { if (raw !== report || !raw.trim()) throw new Error("Economic report validation failed"); });
  if (await readConfined(root, REPORT, LEDGER_LIMITS.maxBytes) !== report) throw new Error("Economic report reread verification failed");
}

export async function runLedgerScout(options: { root?: string; onEvent?: (message: string) => void } = {}): Promise<void> {
  if (scoutMode() !== "ledger") throw new Error("Ledger requires SCOUT_MODE=ledger");
  const root = path.resolve(options.root ?? scoutWorkspaceRoot());
  await locked(root, async () => {
    const raw = await readConfined(root, LEDGER, LEDGER_LIMITS.maxBytes);
    // Existing data is always validated first. New env values cannot replace
    // stored capital (even a now-invalid env value is ignored on reload).
    let ledger = raw === undefined ? initializeLedger(initialCapitalCents(process.env.SCOUT_INITIAL_CAPITAL_EUR)) : parseEconomicLedger(raw);
    const experimentRaw = await readConfined(root, "experiment.json", 128 * 1024);
    const plan = experimentRaw === undefined ? undefined : parseLedgerExperiment(experimentRaw);
    if (plan) ledger = reserveExperiment(ledger, plan);
    await save(root, raw, ledger, buildEconomicReport(ledger, plan));
    options.onEvent?.("Scout completed: economic-ledger.json and economic-report.txt verified. Accounting only; no external action.");
  });
}

/** For future trusted human-facing host code only; never registered as a tool. */
export async function recordLedgerEvent(event: AuthorizedLedgerEvent, root = scoutWorkspaceRoot()): Promise<void> {
  root = path.resolve(root);
  await locked(root, async () => {
    const raw = await readConfined(root, LEDGER, LEDGER_LIMITS.maxBytes);
    if (raw === undefined) throw new Error("Initialize the ledger explicitly before recording events");
    const ledger = recordAuthorizedEvent(parseEconomicLedger(raw), event);
    await save(root, raw, ledger, buildEconomicReport(ledger));
  });
}
