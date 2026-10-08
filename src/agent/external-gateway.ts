import { pilotContext, PILOT_ENDPOINT, domainNow } from "./pilot-context.js";
import { DryRunExternalTransport } from "./pilot-transport.js";
/** One-shot V8 gateway. Preparation/V6 approval/preview are entirely offline. */
import { createHash, createHmac, randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { safePath, scoutWorkspaceRoot } from "./local-tools.js";
import { locked, atomicWrite, readConfined } from "./ledger-runner.js";
import { scoutMode } from "./opportunity-scout.js";
import { createWebhookApproval, parseWebhookApproval, parseWebhookAction, decideWebhookApproval,
  type WebhookAction, type WebhookApprovalRecord } from "./approval-gate.js";
import { webhookEndpoint, fixedWebhookPayload, sendWebhookPing, WEBHOOK_ERRORS, WEBHOOK_LIMITS, type WebhookTransport, type PingOutcome } from "./webhook-ping.js";

const MAX_BYTES = 512 * 1024, MAX_ACTIONS = 100;
const ACTION = "external-action.json", REQUEST = "external-approval-request.json", APPROVAL = "external-approval.json";
const EXECUTION = "external-execution.json", REPORT = "external-action-report.txt";
const PUBLIC_FILES = [ACTION, REQUEST, APPROVAL, EXECUTION, REPORT];
export interface ExternalExecution extends Omit<PingOutcome, "status"> {
  status: PingOutcome["status"] | "simulated";
  version: 8; execution_id: string; action_id: string; request_id: string; approval_id: string;
  capability: "webhook_ping"; attempted_at: string; endpoint_fingerprint: string; payload_fingerprint: string;
}
interface ActionRecord { action: WebhookAction; approval: WebhookApprovalRecord; execution: ExternalExecution | null }
interface ExternalState { version: 8; workspace: string; records: ActionRecord[] }
export type ExternalCommand = { kind: "prepare" | "inspect" } | { kind: "preview"; actionId: string } |
  { kind: "execute"; actionId: string; requestId: string; preview: boolean; projectId?: string; experimentId?: string };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const structured = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("External object required");
  const d = value as Record<string, unknown>;
  if (Object.keys(d).length !== keys.length || Object.keys(d).some(k => !keys.includes(k))) throw new Error("Unexpected/missing external fields");
  return d;
}
function id(value: unknown, prefix: string): string {
  if (typeof value !== "string" || !new RegExp(`^${prefix}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`).test(value)) throw new Error("Exact runtime action/request id required");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid external fingerprint");
  return value;
}
function time(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Invalid external timestamp");
  return value;
}
function configuredEndpoint(): { raw: string; fingerprint: string } {
  const raw = pilotContext() ? PILOT_ENDPOINT : process.env.SCOUT_V8_WEBHOOK_URL;
  webhookEndpoint(raw); // Pure syntax/IP-literal checks; no DNS during prepare/preview/approval.
  return { raw: raw!, fingerprint: sha(raw!) }; // Bind EXACT operator configuration, including equivalent spellings.
}
export function externalStoreRoot(root: string): string {
  return path.join(path.dirname(path.resolve(root)), `.scout-external-${sha(path.resolve(root)).slice(0, 32)}`);
}
function parseExecution(value: unknown, action: WebhookAction, approval: WebhookApprovalRecord): ExternalExecution | null {
  if (value === null) return null;
  const d = exact(value, ["version", "execution_id", "action_id", "request_id", "approval_id", "capability", "attempted_at", "endpoint_fingerprint", "payload_fingerprint",
    "status", "http_status", "response_size", "response_sha256", "network_error_class"]);
  if (approval.request.status !== "approved" || approval.decision?.status !== "approved" || d.version !== 8 || d.action_id !== action.action_id ||
    d.request_id !== approval.request.request_id || d.approval_id !== approval.decision.approval_id || d.capability !== "webhook_ping" ||
    d.endpoint_fingerprint !== action.endpoint_fingerprint || d.payload_fingerprint !== action.payload_fingerprint) throw new Error("External execution approval binding mismatch");
  if (d.status === "simulated" && action.endpoint_fingerprint !== sha(PILOT_ENDPOINT)) throw new Error("Simulation endpoint mismatch");
  const attempted = time(d.attempted_at);
  if (attempted < approval.decision.decided_at) throw new Error("External attempt predates approval");
  if (d.status !== "executed" && d.status !== "failed" && d.status !== "failed-after-send" && d.status !== "uncertain" && d.status !== "simulated") throw new Error("Invalid external execution status");
  if (d.http_status !== null && (typeof d.http_status !== "number" || !Number.isInteger(d.http_status) || d.http_status < 200 || d.http_status > 599)) throw new Error("Invalid HTTP status");
  if (d.response_size !== null && (typeof d.response_size !== "number" || !Number.isSafeInteger(d.response_size) || Object.is(d.response_size, -0) || d.response_size < 0 || d.response_size > WEBHOOK_LIMITS.responseBytes)) throw new Error("Invalid response size");
  if ((d.response_size === null) !== (d.response_sha256 === null)) throw new Error("Incomplete response metadata");
  if (d.response_sha256 !== null) hash(d.response_sha256);
  if (d.network_error_class !== null && (typeof d.network_error_class !== "string" || !WEBHOOK_ERRORS.includes(d.network_error_class as any))) throw new Error("Invalid network error class");
  if ((d.status === "executed" || d.status === "simulated") && (d.http_status === null || (d.http_status as number) >= 300 || d.response_size === null || d.network_error_class !== null)) throw new Error("Invalid successful execution");
  if (d.status !== "executed" && d.status !== "simulated" && d.network_error_class === null) throw new Error("Missing external failure class");
  if (d.status === "failed" && (d.http_status !== null || d.response_size !== null)) throw new Error("Invalid pre-send failure");
  if (d.status === "failed-after-send" && (d.http_status === null || (d.http_status as number) < 300)) throw new Error("Invalid HTTP failure");
  return { version: 8, execution_id: id(d.execution_id, "execution"), action_id: action.action_id, request_id: approval.request.request_id, approval_id: approval.decision.approval_id!,
    capability: "webhook_ping", attempted_at: attempted, endpoint_fingerprint: action.endpoint_fingerprint, payload_fingerprint: action.payload_fingerprint,
    status: d.status, http_status: d.http_status as number | null, response_size: d.response_size as number | null, response_sha256: d.response_sha256 as string | null,
    network_error_class: d.network_error_class as PingOutcome["network_error_class"] };
}
function validateState(value: unknown, root: string): ExternalState {
  const d = exact(value, ["version", "workspace", "records"]);
  if (d.version !== 8 || d.workspace !== root || !Array.isArray(d.records) || !d.records.length || d.records.length > MAX_ACTIONS) throw new Error("Invalid external history");
  const ids = new Set<string>();
  const records = d.records.map(value => {
    const entry = exact(value, ["action", "approval", "execution"]), action = parseWebhookAction(entry.action);
    if (action.payload_fingerprint !== sha(fixedWebhookPayload(action.action_id))) throw new Error("Fixed payload fingerprint mismatch");
    const approval = parseWebhookApproval(entry.approval, action), execution = parseExecution(entry.execution, action, approval);
    for (const identifier of [action.action_id, approval.request.request_id, ...(execution ? [execution.execution_id] : [])]) {
      if (ids.has(identifier)) throw new Error("Replayed external history id"); ids.add(identifier);
    }
    return { action, approval, execution };
  });
  const state: ExternalState = { version: 8, workspace: root, records };
  if (!same(state, d)) throw new Error("Noncanonical external state");
  return state;
}
const mac = (state: ExternalState, key: Buffer) => createHmac("sha256", key).update(JSON.stringify(state)).digest("hex");
function decodeState(raw: string, root: string, key: Buffer): ExternalState {
  const d = exact(JSON.parse(raw), ["version", "workspace", "records", "mac"]);
  const payload = { version: d.version, workspace: d.workspace, records: d.records } as ExternalState;
  if (!timingSafeEqual(Buffer.from(hash(d.mac), "hex"), Buffer.from(mac(payload, key), "hex"))) throw new Error("External history authentication failed");
  return validateState(payload, root);
}
async function load(root: string): Promise<{ state?: ExternalState; key?: Buffer }> {
  const store = externalStoreRoot(root);
  try { await fs.lstat(store); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
  await safePath(store, "state.json");
  if (((await fs.stat(store)).mode & 0o077) !== 0) throw new Error("External store must be private (0700)");
  const keyRaw = await readConfined(store, "integrity-key", 65), raw = await readConfined(store, "state.json", MAX_BYTES);
  if (!keyRaw || raw === undefined || !/^[a-f0-9]{64}\n$/.test(keyRaw)) throw new Error("Incomplete external anchor; human inspection required");
  if (((await fs.stat(await safePath(store, "integrity-key"))).mode & 0o077) !== 0) throw new Error("External key must be private (0600)");
  const key = Buffer.from(keyRaw.trim(), "hex");
  return { state: decodeState(raw, root, key), key };
}
function report(entry: ActionRecord): string {
  const { action, approval, execution } = entry;
  const status = execution ? execution.status === "simulated" ? "ACTION_SIMULATED — DRY_RUN_ONLY" : execution.status === "executed" ? "EXÉCUTÉE" : execution.status === "uncertain" ? "INCERTAINE" : "ÉCHEC" :
    approval.request.status === "approved" ? "APPROUVÉE MAIS NON EXÉCUTÉE" : approval.request.status === "denied" ? "REFUSÉE" : "PRÉPARÉE";
  return ["Scout V8 — action externe préparée", "Action : webhook_ping", `Action ID : ${action.action_id}`, `État : ${status}`,
    `Destination (SHA-256 de la configuration) : ${action.endpoint_fingerprint}`, `Payload SHA-256 : ${action.payload_fingerprint}`,
    `Payload fixe : ${fixedWebhookPayload(action.action_id)}`, `Request ID exact : ${approval.request.request_id}`,
    `Approbation humaine : ${approval.request.status === "pending" ? "requise" : approval.request.status === "approved" ? "accordée pour cette action uniquement" : "refusée"}`,
    `Exécution externe : ${execution ? "tentative consommée ; rejeu interdit" : "non effectuée"}`,
    ...(execution ? [`Execution ID : ${execution.execution_id}`, `HTTP status : ${execution.http_status ?? "inconnu"}`, `Classe réseau : ${execution.network_error_class ?? "aucune"}`,
      "Une erreur peut survenir après réception du POST par le serveur. Ne pas réessayer."] : [
      `Approbation : SCOUT_MODE=approval node dist/index.js --approve-external ${approval.request.request_id}`]),
    "Le rapport seul ne constitue jamais une autorisation.", "Aucun paiement ni transaction financière n'a été effectué.", ""].join("\n");
}
function publicViews(entry?: ActionRecord): (string | undefined)[] {
  return entry ? [structured(entry.action), structured(entry.approval.request), entry.approval.decision?.status === "approved" ? structured(entry.approval.decision) : undefined,
    entry.execution ? structured(entry.execution) : undefined, report(entry)] : PUBLIC_FILES.map(() => undefined);
}
async function checkViews(root: string, entry?: ActionRecord): Promise<void> {
  const values = publicViews(entry);
  for (const [i, name] of PUBLIC_FILES.entries()) if (await readConfined(root, name, MAX_BYTES) !== values[i]) throw new Error(`Modified, missing or orphan ${name}; human inspection required`);
}
async function persist(root: string, state: ExternalState, existingKey?: Buffer): Promise<Buffer> {
  validateState(state, root);
  if (Buffer.byteLength(structured({ ...state, mac: "0".repeat(64) })) > MAX_BYTES) throw new Error("External history size limit");
  for (const name of PUBLIC_FILES) await safePath(root, name);
  let key = existingKey; const store = externalStoreRoot(root);
  if (!key) {
    await safePath(store, "integrity-key", true); key = randomBytes(32);
    const file = await fs.open(await safePath(store, "integrity-key"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(key.toString("hex") + "\n"); await file.sync(); } finally { await file.close(); }
  }
  const raw = structured({ ...state, mac: mac(state, key) });
  await atomicWrite(store, "state.json", raw, s => decodeState(s, root, key!));
  if (await readConfined(store, "state.json", MAX_BYTES) !== raw) throw new Error("External state reread mismatch");
  const views = publicViews(state.records.at(-1));
  for (const [i, name] of PUBLIC_FILES.entries()) {
    const content = views[i];
    if (content === undefined) {
      if (await readConfined(root, name, MAX_BYTES) !== undefined) await fs.unlink(await safePath(root, name));
    } else await atomicWrite(root, name, content, s => { if (s !== content) throw new Error("External view write mismatch"); });
  }
  const dir = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
  await checkViews(root, state.records.at(-1));
  return key;
}
export function parseExternalCommand(args: string[]): ExternalCommand {
  if (args.length === 1 && args[0] === "--prepare-webhook-ping") return { kind: "prepare" };
  if (args.length === 1 && args[0] === "--inspect") return { kind: "inspect" };
  if (args.length === 2 && args[0] === "--preview") return { kind: "preview", actionId: id(args[1], "action") };
  const preview = args.at(-1) === "--preview", base = preview ? args.slice(0, -1) : args;
  if ((base.length === 4 || base.length === 8) && base[0] === "--execute" && base[2] === "--approval-request-id") {
    const command: Extract<ExternalCommand, { kind: "execute" }> = { kind: "execute", actionId: id(base[1], "action"), requestId: id(base[3], "request"), preview };
    if (base.length === 8) {
      if (base[4] !== "--project-id" || base[6] !== "--experiment-id") throw new Error("Exact V9 scope flags required");
      command.projectId = id(base[5], "project"); command.experimentId = hash(base[7]);
    }
    return command;
  }
  throw new Error("Use --prepare-webhook-ping, --preview <action_id>, --inspect or --execute <action_id> --approval-request-id <request_id> [--preview]");
}
function validateCommand(command: ExternalCommand): ExternalCommand {
  exact(command, command.kind === "execute" ? ["kind", "actionId", "requestId", "preview", ...(Object.hasOwn(command, "projectId") || Object.hasOwn(command, "experimentId") ? ["projectId", "experimentId"] : [])] : command.kind === "preview" ? ["kind", "actionId"] : ["kind"]);
  if (command.kind === "execute") {
    if (typeof command.preview !== "boolean") throw new Error("Strict preview boolean required");
    if (Object.hasOwn(command, "projectId") || Object.hasOwn(command, "experimentId")) { id(command.projectId, "project"); hash(command.experimentId); }
    return parseExternalCommand(["--execute", command.actionId, "--approval-request-id", command.requestId, ...(command.projectId !== undefined ? ["--project-id", command.projectId, "--experiment-id", command.experimentId!] : []), ...(command.preview ? ["--preview"] : [])]);
  }
  if (command.kind === "preview") return parseExternalCommand(["--preview", command.actionId]);
  if (command.kind === "prepare" || command.kind === "inspect") return command;
  throw new Error("Only webhook_ping commands are allowed");
}
function endpointMatches(record: ActionRecord, fingerprint: string): void {
  if (record.action.endpoint_fingerprint !== fingerprint) throw new Error("Operator endpoint changed; exact approved endpoint required");
}
function replaceLast(state: ExternalState, entry: ActionRecord): ExternalState { return { ...state, records: [...state.records.slice(0, -1), entry] }; }

/** This entry point never approves anything. The separate V6 CLI records the decision. */
export async function runExternalScout(options: { root?: string; command: ExternalCommand; transport?: WebhookTransport; onEvent?: (message: string) => void }): Promise<string> {
  if (scoutMode() !== "external") throw new Error("External gateway requires SCOUT_MODE=external");
  const command = validateCommand(options.command), endpoint = configuredEndpoint(), root = path.resolve(options.root ?? scoutWorkspaceRoot());
  if (pilotContext() ? root !== pilotContext()!.root || options.transport !== undefined : await readConfined(root, "pilot-dry-run.json", MAX_BYTES).catch(e => { if (e.code === "ENOENT") return undefined; throw e; }) !== undefined) throw new Error("Pilot V8 requires its isolated host and fixed dry-run transport");
  return locked(root, async () => {
    const loaded = await load(root); let state = loaded.state, key = loaded.key; let entry = state?.records.at(-1);
    await checkViews(root, entry);
    if (command.kind === "prepare") {
      if (entry?.execution?.status === "uncertain") throw new Error("Uncertain previous action: human investigation required; no new automatic attempt");
      if (!entry || entry.execution || entry.approval.request.status === "denied" || entry.action.endpoint_fingerprint !== endpoint.fingerprint) {
        if ((state?.records.length ?? 0) >= MAX_ACTIONS) throw new Error("External history limit reached");
        const actionId = `action-${randomUUID()}`;
        const action: WebhookAction = { version: 8, action_id: actionId, type: "webhook_ping", status: "prepared", created_at: domainNow(),
          endpoint_fingerprint: endpoint.fingerprint, payload_fingerprint: sha(fixedWebhookPayload(actionId)), capabilities: ["webhook_ping"] };
        entry = { action, approval: createWebhookApproval(action), execution: null };
        state = { version: 8, workspace: root, records: [...(state?.records ?? []), entry] };
        key = await persist(root, state, key);
      }
    } else {
      if (!entry || !state) throw new Error("Prepare one webhook_ping first");
      endpointMatches(entry, endpoint.fingerprint);
      if ((command.kind === "preview" || command.kind === "execute") && command.actionId !== entry.action.action_id) throw new Error("Exact current action_id required");
      if (command.kind === "execute") {
        if (command.requestId !== entry.approval.request.request_id || entry.approval.request.status !== "approved" || entry.approval.decision?.status !== "approved") throw new Error("Exact approved V6 webhook request_id required");
        if (entry.execution !== null) throw new Error("Action already attempted; replay prohibited, including after timeout/failure");
        const verifyScope = async () => {
          const { verifyExternalProjectScope } = await import("./project-manager.js");
          await verifyExternalProjectScope(root, entry!.action.action_id, entry!.approval.request.request_id,
            sha(JSON.stringify(entry!.action)), entry!.approval.request.request_fingerprint,
            command.projectId ? { projectId: command.projectId, experimentId: command.experimentId! } : undefined);
        };
        await verifyScope();
        if (!command.preview) {
          endpointMatches(entry, configuredEndpoint().fingerprint);
          // Durable at-most-once intent BEFORE DNS or a socket. Crash from here
          // on means uncertain; there is no transition back to unattempted.
          const intent: ExternalExecution = { version: 8, execution_id: `execution-${randomUUID()}`, action_id: entry.action.action_id,
            request_id: entry.approval.request.request_id, approval_id: entry.approval.decision.approval_id!, capability: "webhook_ping", attempted_at: domainNow(),
            endpoint_fingerprint: entry.action.endpoint_fingerprint, payload_fingerprint: entry.action.payload_fingerprint,
            status: "uncertain", http_status: null, response_size: null, response_sha256: null, network_error_class: "interrupted" };
          entry = { ...entry, execution: intent }; state = replaceLast(state, entry);
          key = await persist(root, state, key);
          // Re-read authenticated state and views after intent, before any network.
          const reread = await load(root);
          if (!same(reread.state, state)) throw new Error("External intent changed before connection");
          await checkViews(root, entry); endpointMatches(entry, configuredEndpoint().fingerprint);
          await verifyScope();
          const outcome = await sendWebhookPing(endpoint.raw, entry.action.action_id, pilotContext() ? new DryRunExternalTransport() : options.transport);
          if (!same((await load(root)).state, state)) throw new Error("External intent changed after network attempt");
          await checkViews(root, entry);
          entry = { ...entry, execution: { ...intent, ...outcome, status: pilotContext() && outcome.status === "executed" ? "simulated" : outcome.status } }; state = replaceLast(state, entry);
          // If this fails the durable intent still forbids replay. Never retry POST.
          await persist(root, state, key);
        }
      }
    }
    const message = (command.kind === "preview" || (command.kind === "execute" && command.preview) ? "APERÇU — aucune connexion réseau, aucune tentative enregistrée.\n" : "") + report(entry!);
    options.onEvent?.(message); return message;
  });
}

/** V6 CLI path only. Does not connect or interpret an economic approval. */
export async function runExternalApprovalScout(options: { root?: string; args: string[]; onEvent?: (message: string) => void }): Promise<string> {
  if (scoutMode() !== "approval") throw new Error("External approval belongs to SCOUT_MODE=approval");
  const args = options.args;
  if (args.length !== 2 || (args[0] !== "--approve-external" && args[0] !== "--deny-external")) throw new Error("Use --approve-external <exact_request_id> or --deny-external <exact_request_id>");
  const requestId = id(args[1], "request"), endpoint = configuredEndpoint(), root = path.resolve(options.root ?? scoutWorkspaceRoot());
  return locked(root, async () => {
    const { state, key } = await load(root), entry = state?.records.at(-1);
    await checkViews(root, entry);
    if (!entry || !state || !key) throw new Error("Prepare one webhook_ping first");
    endpointMatches(entry, endpoint.fingerprint);
    if (entry.execution) throw new Error("Already attempted; approval replay prohibited");
    const approval = decideWebhookApproval(entry.action, entry.approval, requestId, args[0] === "--approve-external" ? "approve" : "deny");
    const next = { ...entry, approval };
    await persist(root, replaceLast(state, next), key);
    const message = report(next); options.onEvent?.(message); return message;
  });
}

/** Decision-only adapter under the shared V5 lock; never calls transport. */
export async function decideExistingExternalApproval(root: string, requestId: string, kind: "approve" | "deny"): Promise<void> {
  if (scoutMode() !== "control-api" || !["approve", "deny"].includes(kind)) throw new Error("Control decision required");
  id(requestId, "request");
  const { state, key } = await load(root), entry = state?.records.at(-1);
  await checkViews(root, entry);
  if (!entry || !state || !key || entry.approval.request.request_id !== requestId) throw new Error("Exact current external approval required");
  endpointMatches(entry, configuredEndpoint().fingerprint);
  if (entry.execution) throw new Error("Consumed external approval");
  const wanted = kind === "approve" ? "approved" : "denied";
  if (entry.approval.request.status === wanted) return;
  const approval = decideWebhookApproval(entry.action, entry.approval, requestId, kind);
  await persist(root, replaceLast(state, { ...entry, approval }), key);
}

/** Read-only V9 linkage adapter. Caller must hold the shared V5 lock. */
export async function readExternalBinding(root: string): Promise<ActionRecord | undefined> {
  const { state } = await load(root), entry = state?.records.at(-1);
  await checkViews(root, entry);
  if (entry) endpointMatches(entry, configuredEndpoint().fingerprint);
  return entry;
}

/** Read-only authenticated historical V8 records for V10. No endpoint config,
 * resolution, transport or execution. Caller holds the shared V5 lock. */
export async function readVerifiedExternalRecords(root: string): Promise<ActionRecord[]> {
  const { state } = await load(root);
  await checkViews(root, state?.records.at(-1));
  return state?.records ?? [];
}
