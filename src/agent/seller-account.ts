/** Trusted local human CLI only. Never a model tool or HTTP endpoint. */
import { randomUUID } from "node:crypto";
import { locked, readConfined } from "./ledger-runner.js";
import { scoutWorkspaceRoot } from "./local-tools.js";
import { canonicalHash, exact, hex, same, time, uuid } from "./project-model.js";
import { readPreparationSnapshot, assertPreparationCapacity } from "./pilot-preparation.js";
import { addPreparationEvent } from "./pilot-preparation-store.js";
import { createPreparedProject, parsePreparationInput, reference } from "./pilot-preparation-model.js";
import { calculateAllocation } from "./capital-allocator.js";
import { assertPilotNotStopped, normalizedPilotRoot, pilotStopped } from "./pilot-stop.js";
import { accountBinding, accountPlatform, appendAccountEvent, replayAccounts, sourcePlatform, type AccountRecord, type AccountScope } from "./seller-account-model.js";
import { assertAccountWitness, commitAccountPreparation, loadAccountWitness, recoverAccountWitness } from "./seller-account-store.js";
export type AccountCommand = { kind: "initialize" | "inspect" | "recover" } |
  { kind: "declare" | "new-declaration"; operator_id: string; opportunity_id: string; dossier_hash: string; platform: string } |
  { kind: "validate" | "deny" | "revoke" | "admit"; operator_id: string; account_id: string; request_id: string; fingerprint: string };
export function parseAccountCommand(args: string[]): AccountCommand {
  if (args.length === 1 && ["--initialize", "--inspect", "--recover"].includes(args[0])) return { kind: args[0].slice(2) as "initialize" };
  if (args.length === 5 && ["--declare", "--new-declaration"].includes(args[0])) return { kind: args[0].slice(2) as "declare", operator_id: uuid(args[1], "operator"), opportunity_id: reference(args[2]), dossier_hash: hex(args[3]), platform: accountPlatform(args[4]) };
  if (args.length === 5 && ["--validate", "--deny", "--revoke", "--admit"].includes(args[0])) return { kind: args[0].slice(2) as "validate", operator_id: uuid(args[1], "operator"), account_id: uuid(args[2], "account"), request_id: uuid(args[3], "account-validation"), fingerprint: hex(args[4]) };
  throw new Error("ACCOUNT_COMMAND_FORBIDDEN");
}
function validateCommand(c: AccountCommand) {
  if (["initialize", "inspect", "recover"].includes(c.kind)) {
    exact(c, ["kind"]); parseAccountCommand([`--${c.kind}`]); return;
  }
  if ("opportunity_id" in c) {
    exact(c, ["kind", "operator_id", "opportunity_id", "dossier_hash", "platform"]);
    if (!same(c, parseAccountCommand([`--${c.kind}`, c.operator_id, c.opportunity_id, c.dossier_hash, c.platform]))) throw new Error("ACCOUNT_COMMAND_FORBIDDEN");
  } else if ("account_id" in c) {
    exact(c, ["kind", "operator_id", "account_id", "request_id", "fingerprint"]);
    if (!same(c, parseAccountCommand([`--${c.kind}`, c.operator_id, c.account_id, c.request_id, c.fingerprint]))) throw new Error("ACCOUNT_COMMAND_FORBIDDEN");
  } else throw new Error("ACCOUNT_COMMAND_FORBIDDEN");
}
function uid() { if (!process.getuid) throw new Error("ACCOUNT_OS_OWNER_UNAVAILABLE"); return process.getuid(); }
type Snapshot = Awaited<ReturnType<typeof readPreparationSnapshot>>;
async function candidateScope(root: string, s: Snapshot, opportunityId: string, dossierHash: string, platform: string, now: string) {
  const input = parsePreparationInput(s.raw), dossier = input.dossiers.find(d => d.opportunity_id === opportunityId && canonicalHash(d) === dossierHash);
  const candidate = s.sources.candidates.find(c => c.opportunity_id === opportunityId);
  if (!dossier || !candidate || dossier.candidate_fingerprint !== candidate.fingerprint || dossier.fictional || now >= dossier.review_expires_at || s.state.source_file !== "research.json") throw new Error("ACCOUNT_EXACT_CURRENT_DOSSIER_REQUIRED");
  const raw = await readConfined(root, "research.json", 128 * 1024);
  if (!raw || canonicalHash(raw) !== s.state.source_hash) throw new Error("ACCOUNT_RESEARCH_CHANGED");
  const source = JSON.parse(raw).opportunities.find((o: any) => o.opportunity_id === opportunityId);
  if (!source || source.account_required !== true || sourcePlatform(source.platform) !== platform) throw new Error("ACCOUNT_REQUIRED_PLATFORM_SCOPE_MISMATCH");
  if (s.missing.some(m => m.startsWith(opportunityId + ":"))) throw new Error("ACCOUNT_MISSING_EVIDENCE");
  return { dossier, candidate, source, project: createPreparedProject(dossier, candidate, now) };
}
function view(s: Snapshot, now: string) {
  const h = s.state.seller_accounts;
  return { version: "14.3", mode: "EXISTING_ACCOUNT_PREPARATION_ONLY", initialized: !!h, operator_id: h?.operator_id ?? null,
    accounts: h ? replayAccounts(h).map(r => ({ ...r, state: r.status === "validated" && now >= r.scope.expires_at ? "expired" : r.status === "pending" && now >= r.scope.expires_at ? "expired" : r.status, preparation_validation_current: r.status === "validated" && now < r.scope.expires_at })) : [],
    audit: h?.events ?? [], execution_allowed: false, payment_performed: false, publication_performed: false, account_connection_performed: false,
    ownership_independently_verified: false, bank_verified: false, freshness_guarantee: "STATE_ROLLBACK_DETECTED_ONLY_WHILE_SEPARATE_LOCAL_WITNESS_IS_PRESERVED", full_restore_protected: false };
}
export async function runSellerAccount(options: { root?: string; command: AccountCommand; now?: () => string }) {
  if (process.env.SCOUT_MODE !== "seller-account") throw new Error("Explicit SCOUT_MODE=seller-account required");
  validateCommand(options.command);
  const root = normalizedPilotRoot(options.root ?? scoutWorkspaceRoot()), c = options.command;
  return locked(root, async () => {
    const clock = () => time((options.now ?? (() => new Date().toISOString()))());
    const now = clock(), witness = await loadAccountWitness(root);
    if (c.kind === "recover") await recoverAccountWitness(root);
    else if (c.kind === "inspect" && witness.witness && !witness.witness.installed) return { version: "14.3", status: "COMMITTED_RECOVERY_REQUIRED", execution_allowed: false, account_use_allowed: false };
    await assertAccountWitness(root);
    const snapshot = await readPreparationSnapshot(root, now, await pilotStopped(root)), next = structuredClone(snapshot.state);
    if (c.kind === "inspect" || c.kind === "recover") return view(snapshot, now);
    if (c.kind !== "revoke") await assertPilotNotStopped(root);
    if (c.kind === "initialize") {
      if (next.seller_accounts) {
        if (next.seller_accounts.owner_uid !== uid()) throw new Error("ACCOUNT_OPERATOR_MISMATCH"); return view(snapshot, now);
      }
      next.seller_accounts = { version: "14.3", operator_id: `operator-${randomUUID()}`, owner_uid: uid(), initialized_at: now, events: [] };
    } else {
      if (!("operator_id" in c)) throw new Error("ACCOUNT_COMMAND_FORBIDDEN");
      const h = next.seller_accounts;
      if (!h || h.owner_uid !== uid() || h.operator_id !== c.operator_id) throw new Error("ACCOUNT_OPERATOR_MISMATCH");
      if (now < h.initialized_at || now < (h.events.at(-1)?.at ?? h.initialized_at)) throw new Error("ACCOUNT_CLOCK_ROLLBACK");
      const records = replayAccounts(h);
      if (c.kind === "declare" || c.kind === "new-declaration") {
        const { dossier, candidate, source, project } = await candidateScope(root, snapshot, c.opportunity_id, c.dossier_hash, c.platform, now);
        const old = records.filter(r => r.scope.project_id === project.project_id).at(-1);
        if (old) {
          if (old.scope.dossier_hash !== c.dossier_hash || old.scope.platform !== c.platform) throw new Error("ACCOUNT_SCOPE_MISMATCH");
          if (c.kind === "declare") return view(snapshot, now); // receipt only; no renewal or new validation
          if (old.admitted || old.status === "pending" && now < old.scope.expires_at || old.status === "validated" && now < old.scope.expires_at) throw new Error("ACCOUNT_NEW_DECLARATION_FORBIDDEN");
        } else if (c.kind === "new-declaration") throw new Error("ACCOUNT_PREVIOUS_DECLARATION_REQUIRED");
        const scope: AccountScope = { operator_id: h.operator_id, account_id: `account-${randomUUID()}`, platform: accountPlatform(c.platform), source_platform: source.platform,
          opportunity_id: c.opportunity_id, candidate_fingerprint: candidate.fingerprint, project_id: project.project_id, dossier_hash: c.dossier_hash,
          input_hash: snapshot.state.input_hash, source_hash: snapshot.state.source_hash, request_id: `account-validation-${randomUUID()}`, created_at: now, expires_at: dossier.review_expires_at,
          purpose: "EXISTING_ACCOUNT_PREPARATION_ONLY", ownership_proof: "UNVERIFIED_LOCAL_HUMAN_ATTESTATION" };
        appendAccountEvent(h, "declare", scope, now);
      } else if ("account_id" in c) {
        const r: AccountRecord | undefined = records.find(r => r.scope.account_id === c.account_id && r.scope.request_id === c.request_id && r.fingerprint === c.fingerprint);
        if (!r || r.scope.operator_id !== c.operator_id) throw new Error("ACCOUNT_SCOPE_MISMATCH");
        if (c.kind !== "revoke") {
          await candidateScope(root, snapshot, r.scope.opportunity_id, r.scope.dossier_hash, r.scope.platform, now);
          if (r.scope.input_hash !== snapshot.state.input_hash || r.scope.source_hash !== snapshot.state.source_hash) throw new Error("ACCOUNT_SOURCES_CHANGED");
        }
        if (c.kind === "admit") {
          if (r.status !== "validated" || now >= r.scope.expires_at) throw new Error("ACCOUNT_VALIDATION_REQUIRED");
          if (r.admitted) return view(snapshot, now);
          if (next.supervision || next.planning) throw new Error("ACCOUNT_ADMISSION_AFTER_SUPERVISION_FORBIDDEN");
          const { dossier, candidate, project } = await candidateScope(root, snapshot, r.scope.opportunity_id, r.scope.dossier_hash, r.scope.platform, now);
          const allocation = calculateAllocation(snapshot.sources, now);
          if (candidate.estimated_cost_cents === null || candidate.estimated_cost_cents > dossier.budget_cents || !allocation.selected_projects.some(p => p.opportunity_id === candidate.opportunity_id && p.project_id === null) || next.projects.some(p => p.project_id === project.project_id)) throw new Error("ACCOUNT_ADMISSION_CAPACITY_OR_CANDIDATE_BLOCKED");
          project.account_validation = accountBinding(r); next.projects.push(project); assertPreparationCapacity(snapshot.sources, next.projects);
          addPreparationEvent(next, "OPPORTUNITY_READY_FOR_REVIEW", project.project_id, now);
          for (const request of project.requests) addPreparationEvent(next, "APPROVAL_REQUIRED", request.request_id, now);
        }
        appendAccountEvent(h, c.kind, r.scope, now);
      }
    }
    const at = clock(); if (at < now) throw new Error("ACCOUNT_CLOCK_ROLLBACK");
    if (c.kind !== "initialize" && c.kind !== "revoke") {
      const h = next.seller_accounts!, scope = h.events.at(-1)!.scope;
      if (at >= scope.expires_at) throw new Error("ACCOUNT_VALIDATION_EXPIRED_BEFORE_COMMIT");
    }
    if (c.kind === "initialize") next.seller_accounts!.initialized_at = at;
    next.updated_at = at;
    const current = await readPreparationSnapshot(root, at, await pilotStopped(root));
    if (!same(current.state, snapshot.state) || !same(current.sources, snapshot.sources) || !same(current.missing, snapshot.missing)) throw new Error("ACCOUNT_SOURCES_CHANGED_BEFORE_COMMIT");
    if (c.kind !== "revoke") await assertPilotNotStopped(root);
    await commitAccountPreparation(root, next, snapshot.key, c.kind === "revoke");
    if (c.kind !== "revoke") await assertPilotNotStopped(root);
    return view(await readPreparationSnapshot(root, clock(), await pilotStopped(root)), clock());
  }, ["inspect", "recover", "revoke"].includes(c.kind) ? "account-read" : "account");
}
export async function runSellerAccountCli(args: string[]) {
  try { console.log(JSON.stringify(await runSellerAccount({ command: parseAccountCommand(args) }), null, 2)); }
  catch { console.error(JSON.stringify({ version: "14.3", status: "BLOCKED_LOCAL_INSPECTION_REQUIRED", execution_allowed: false, account_use_allowed: false, money_moved: false })); process.exitCode = 1; }
}
