/** Separate LOCAL freshness witness, not an independent authority. Restoring both
 * this directory and preparation together is explicitly outside the guarantee.
 * One signed durable intent is committed BEFORE preparation installation. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { atomicWrite, readConfined } from "./ledger-runner.js";
import { assertPilotNotStopped } from "./pilot-stop.js";
import { safePath } from "./local-tools.js";
import { canonicalHash, exact, hex, same, structured, time } from "./project-model.js";
import { decodePreparation, encodePreparation, preparationStoreRoot, type PreparationState } from "./pilot-preparation-store.js";
export const ACCOUNT_WITNESS_BYTES = 2 * 1024 * 1024;
export const accountWitnessRoot = (root: string) => path.join(path.dirname(root), `.scout-account-witness-${canonicalHash(root).slice(0, 32)}`);
export function accountStatePin(s: PreparationState) {
  return canonicalHash([s.seller_accounts ?? null, s.projects.filter(p => p.account_validation)]);
}
export interface AccountWitness {
  version: "14.3"; workspace: string; sequence: number; committed_at: string;
  before: string; after: string; account_pin: string; installed: boolean;
}
function signature(w: AccountWitness, key: Buffer) { return createHmac("sha256", key).update(JSON.stringify(w)).digest(); }
export function decodeAccountWitness(raw: string, root: string, key: Buffer): AccountWitness {
  if (Buffer.byteLength(raw) > ACCOUNT_WITNESS_BYTES) throw new Error("ACCOUNT_WITNESS_SIZE_LIMIT");
  const d = exact(JSON.parse(raw), ["witness", "mac"]), w = d.witness as AccountWitness;
  if (!timingSafeEqual(signature(w, key), Buffer.from(hex(d.mac), "hex"))) throw new Error("ACCOUNT_WITNESS_AUTHENTICATION_FAILED");
  exact(w, ["version", "workspace", "sequence", "committed_at", "before", "after", "account_pin", "installed"]);
  time(w.committed_at); hex(w.account_pin);
  if (w.version !== "14.3" || w.workspace !== root || !Number.isSafeInteger(w.sequence) || w.sequence < 1 || typeof w.installed !== "boolean" || typeof w.before !== "string" || typeof w.after !== "string") throw new Error("ACCOUNT_WITNESS_INVALID");
  const before = decodePreparation(w.before, root, key), after = decodePreparation(w.after, root, key);
  if (!after.seller_accounts || after.updated_at !== w.committed_at || before.updated_at > w.committed_at || accountStatePin(after) !== w.account_pin || accountStatePin(before) === w.account_pin) throw new Error("ACCOUNT_WITNESS_BINDING_INVALID");
  // Never rewrite an existing account history, including revocations.
  if (before.seller_accounts) {
    const a = before.seller_accounts, b = after.seller_accounts;
    if (a.operator_id !== b.operator_id || a.owner_uid !== b.owner_uid || a.initialized_at !== b.initialized_at || b.events.length < a.events.length || b.events.length > a.events.length + 1 || !same(b.events.slice(0, a.events.length), a.events)) throw new Error("ACCOUNT_HISTORY_REWRITE");
  } else if (after.seller_accounts.events.length || after.seller_accounts.initialized_at !== w.committed_at) throw new Error("ACCOUNT_INITIALIZATION_INVALID");
  return w;
}
async function keyFor(root: string) {
  const store = preparationStoreRoot(root), raw = await readConfined(store, "integrity-key", 65);
  if (!raw || !/^[a-f0-9]{64}\n$/.test(raw) || (await fs.stat(store)).mode & 0o077 || (await fs.stat(await safePath(store, "integrity-key"))).mode & 0o077) throw new Error("ACCOUNT_PRIVATE_ANCHOR_REQUIRED");
  return Buffer.from(raw.trim(), "hex");
}
export async function loadAccountWitness(root: string): Promise<{ witness?: AccountWitness; key?: Buffer }> {
  const store = accountWitnessRoot(root);
  try { await fs.lstat(store); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
  await safePath(store, "receipt.json");
  if ((await fs.stat(store)).mode & 0o077) throw new Error("ACCOUNT_PRIVATE_WITNESS_REQUIRED");
  const raw = await readConfined(store, "receipt.json", ACCOUNT_WITNESS_BYTES);
  if (!raw) throw new Error("ACCOUNT_WITNESS_INCOMPLETE; human inspection required");
  if ((await fs.stat(await safePath(store, "receipt.json"))).mode & 0o077) throw new Error("ACCOUNT_PRIVATE_WITNESS_REQUIRED");
  const key = await keyFor(root); return { witness: decodeAccountWitness(raw, root, key), key };
}
async function preparationRaw(root: string) {
  return readConfined(preparationStoreRoot(root), "state.json", ACCOUNT_WITNESS_BYTES).catch(e => { if (e.code === "ENOENT") return undefined; throw e; });
}
export async function assertAccountWitness(root: string) {
  const { witness, key } = await loadAccountWitness(root), raw = await preparationRaw(root);
  if (!witness) {
    if (raw) {
      const d = JSON.parse(raw);
      if (Object.hasOwn(d.state ?? {}, "seller_accounts") || d.state?.projects?.some((p: any) => Object.hasOwn(p, "account_validation"))) throw new Error("ACCOUNT_WITNESS_MISSING");
    }
    return;
  }
  if (!witness.installed) throw new Error("ACCOUNT_RECOVERY_REQUIRED");
  if (!raw || accountStatePin(decodePreparation(raw, root, key!)) !== witness.account_pin) throw new Error("ACCOUNT_STATE_ROLLBACK_OR_CONFLICT");
}
async function writeWitness(root: string, w: AccountWitness, key: Buffer) {
  const raw = structured({ witness: w, mac: signature(w, key).toString("hex") });
  await atomicWrite(accountWitnessRoot(root), "receipt.json", raw, v => decodeAccountWitness(v, root, key));
  if (await readConfined(accountWitnessRoot(root), "receipt.json", ACCOUNT_WITNESS_BYTES) !== raw) throw new Error("ACCOUNT_WITNESS_REREAD_FAILED");
}
export async function recoverAccountWitness(root: string) {
  const { witness: w, key } = await loadAccountWitness(root);
  if (!w || !key) { await assertAccountWitness(root); return; }
  if (w.installed) { await assertAccountWitness(root); return; }
  const raw = await preparationRaw(root);
  if (raw !== w.before && raw !== w.after) throw new Error("ACCOUNT_RECOVERY_CONFLICT; human inspection required");
  if (raw !== w.after) await atomicWrite(preparationStoreRoot(root), "state.json", w.after, v => decodePreparation(v, root, key));
  if (await preparationRaw(root) !== w.after) throw new Error("ACCOUNT_INSTALL_REREAD_FAILED");
  const fd = await fs.open(preparationStoreRoot(root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
  w.installed = true; await writeWitness(root, w, key); await assertAccountWitness(root);
}
/** Caller MUST hold V5 shared lock and validate source, scope and stop. Existing
 * savePreparation also delegates here when account-project approvals change. */
export async function commitAccountPreparation(root: string, state: PreparationState, key: Buffer, protectiveRevocation = false) {
  await assertAccountWitness(root);
  const loaded = await loadAccountWitness(root), before = await preparationRaw(root);
  if (!before) throw new Error("ACCOUNT_PREPARATION_REQUIRED");
  const previous = decodePreparation(before, root, key), after = encodePreparation(root, state, key);
  if (accountStatePin(previous) === accountStatePin(state)) throw new Error("ACCOUNT_NO_CHANGE");
  const w: AccountWitness = { version: "14.3", workspace: root, sequence: (loaded.witness?.sequence ?? 0) + 1, committed_at: state.updated_at, before, after, account_pin: accountStatePin(state), installed: false };
  // Validate the entire intended transaction before creating the witness latch.
  decodeAccountWitness(structured({ witness: w, mac: signature(w, key).toString("hex") }), root, key);
  if (!loaded.witness) {
    await fs.mkdir(accountWitnessRoot(root), { mode: 0o700 });
    const fd = await fs.open(path.dirname(accountWitnessRoot(root)), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await fd.sync(); } finally { await fd.close(); }
  }
  if (!protectiveRevocation) await assertPilotNotStopped(root);
  await writeWitness(root, w, key); // durable commit: NO preparation write yet
  await recoverAccountWitness(root); // only installs the exact committed bytes
}
