import { pilotContext } from "./pilot-context.js";
/** V12.5 loopback-only HTTP boundary. No model, shell, ledger writer or executor. */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { scoutWorkspaceRoot } from "./local-tools.js";
import { scoutMode } from "./opportunity-scout.js";
import { locked } from "./ledger-runner.js";
import { readControlSnapshot } from "./control-snapshot.js";
import { syncControlEvents } from "./control-events.js";
import { decideExistingApproval } from "./approval-gate.js";
import { decideExistingProjectApproval } from "./project-manager.js";
import { decideExistingExternalApproval } from "./external-gateway.js";
import { CONTROL_LIMITS, ControlError, controlId, decimal } from "./control-model.js";

export function controlConfig(env: Record<string, string | undefined> = process.env) {
  const host = env.SCOUT_CONTROL_API_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("Control API requires literal 127.0.0.1");
  const port = decimal(env.SCOUT_CONTROL_API_PORT ?? "4317", 65535);
  const token = env.SCOUT_CONTROL_API_TOKEN;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("Control API requires an explicit 32..256 character random token (letters, digits, underscore, hyphen)");
  return { host, port, token };
}
const hash = (s: string) => createHash("sha256").update(s).digest();
function respond(res: ServerResponse, status: number, value: unknown) {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > CONTROL_LIMITS.responseBytes) throw new Error("Response byte limit");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Connection": "close" });
  res.end(raw);
}
function failure(res: ServerResponse, e: unknown) {
  const error = e instanceof ControlError ? e : new ControlError(503, "STATE_UNAVAILABLE", "Scout state is unavailable; local operator inspection is required.");
  if (!res.headersSent && !res.destroyed) respond(res, error.status, { error: { code: error.code, message: error.message } });
}
function requestTarget(req: IncomingMessage, port: number) {
  if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== undefined || req.headers["sec-fetch-site"] === "cross-site") {
    throw new ControlError(403, "LOCAL_ONLY", "Only direct local requests without an Origin header are supported.");
  }
  const seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    if (seen.has(name)) throw new ControlError(400, "DUPLICATE_HEADER", "Duplicate headers are not supported.");
    seen.add(name);
  }
  const target = req.url ?? "";
  if (target.length > CONTROL_LIMITS.urlBytes || !/^\/v1\/[A-Za-z0-9_/?=&-]+$/.test(target) || target.includes("//")) throw new ControlError(400, "INVALID_TARGET", "Invalid request target.");
  const [pathname, query, extra] = target.split("?");
  if (extra !== undefined || query === "") throw new ControlError(400, "INVALID_QUERY", "Invalid query parameters.");
  const params = new URLSearchParams(query);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) throw new ControlError(400, "INVALID_QUERY", "Duplicate query parameters are not supported.");
  return { pathname, params };
}
async function emptyObjectBody(req: IncomingMessage) {
  if (req.headers["content-type"] !== "application/json" || req.headers["content-encoding"] !== undefined) throw new ControlError(415, "CONTENT_TYPE", "Use application/json without content encoding.");
  if (req.headers["content-length"] !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(req.headers["content-length"]) || Number(req.headers["content-length"]) > CONTROL_LIMITS.bodyBytes)) throw new ControlError(413, "BODY_TOO_LARGE", "Request body exceeds the limit.");
  // A deliberately tiny schema has a single canonical spelling. This also
  // rejects duplicate keys, financial fields, prototype keys and invalid UTF-8.
  await new Promise<void>((resolve, reject) => {
    let size = 0; const parts: Buffer[] = [];
    const timer = setTimeout(() => finish(new ControlError(408, "REQUEST_TIMEOUT", "Request body timed out.")), CONTROL_LIMITS.requestMs);
    const finish = (error?: Error) => { clearTimeout(timer); req.off("data", data); req.off("end", end); req.off("aborted", aborted); req.off("error", aborted); if (error) { req.pause(); reject(error); } else resolve(); };
    const data = (chunk: Buffer) => { size += chunk.length; if (size > CONTROL_LIMITS.bodyBytes) finish(new ControlError(413, "BODY_TOO_LARGE", "Request body exceeds the limit.")); else parts.push(chunk); };
    const end = () => { const text = Buffer.concat(parts).toString("utf8"); finish(/^[\x20\t\r\n]*\{[\x20\t\r\n]*\}[\x20\t\r\n]*$/.test(text) ? undefined : new ControlError(400, "INVALID_BODY", "The decision body must be an empty JSON object.")); };
    const aborted = () => finish(new ControlError(400, "INCOMPLETE_BODY", "Incomplete request body."));
    req.on("data", data); req.once("end", end); req.once("aborted", aborted); req.once("error", aborted);
  });
}
/** Startup does not create a ledger, approval or event anchor. health works on
 * an empty workspace; state endpoints fail closed until explicit initialization. */
export async function startControlApi(options: { root?: string; env?: Record<string, string | undefined> } = {}) {
  if (scoutMode() !== "control-api") throw new Error("Control API requires SCOUT_MODE=control-api");
  const config = controlConfig(options.env), expectedToken = hash(config.token), root = path.resolve(options.root ?? scoutWorkspaceRoot());
  let closing = false, pending = 0, tail: Promise<unknown> = Promise.resolve(), port = config.port;
  // Bounded in-process queue + V5 cross-process fail-closed exclusive lock.
  const serialized = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (closing || pending >= CONTROL_LIMITS.queue) throw new ControlError(503, "BUSY", "Control API is busy; retry later.");
    pending++;
    const task = tail.then(() => locked(root, operation, "control-read"));
    tail = task.catch(() => undefined);
    try { return await task; } finally { pending--; }
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname, params } = requestTarget(req, port);
    if (!["GET", "POST"].includes(req.method ?? "")) throw new ControlError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
    const decision = /^\/v1\/approvals\/([^/]+)\/(approve|deny)$/.exec(pathname);
    const project = /^\/v1\/projects\/([^/]+)$/.exec(pathname);
    const lists = ["/v1/projects", "/v1/approvals", "/v1/attention"];
    const knownGet = ["/v1/health", "/v1/summary", "/v1/allocation", "/v1/preparation", "/v1/events", ...lists].includes(pathname) || project !== null;
    if (!knownGet && !decision) throw new ControlError(404, "NOT_FOUND", "Route not found.");
    if ((decision && req.method !== "POST") || (!decision && req.method !== "GET")) throw new ControlError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
    const keys = [...params.keys()], allowed = pathname === "/v1/events" ? ["after", "limit"] : lists.includes(pathname) ? ["offset", "limit"] : [];
    if (keys.some(k => !allowed.includes(k))) throw new ControlError(400, "INVALID_QUERY", "Unknown query parameters.");
    const limit = decimal(params.get("limit") ?? String(CONTROL_LIMITS.defaultPageSize), CONTROL_LIMITS.pageSize);
    if (limit < 1) throw new ControlError(400, "INVALID_QUERY", "Limit must be positive.");
    const after = decimal(params.get("after") ?? "0", Number.MAX_SAFE_INTEGER), offset = decimal(params.get("offset") ?? "0", 1000);
    if (project) controlId(project[1], "project");
    if (decision) controlId(decision[1], "request");
    if (req.method === "GET" && (req.headers["transfer-encoding"] !== undefined || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0"))) throw new ControlError(400, "UNEXPECTED_BODY", "GET requests must not have a body.");
    if (pathname === "/v1/health") { respond(res, 200, { schema_version: 1, status: "ok", mode: pilotContext() ? "DRY_RUN_ONLY" : "local", can_spend: false }); return; }
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string" || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization) || !timingSafeEqual(hash(authorization.slice(7)), expectedToken)) throw new ControlError(401, "UNAUTHORIZED", "Valid local bearer authentication is required.");
    if (decision) await emptyObjectBody(req);
    const output = await serialized(async () => {
      let snapshot = await readControlSnapshot(root);
      let events = await syncControlEvents(root, snapshot);
      if (decision) {
        if (snapshot.preparation) throw new ControlError(409, "PREPARATION_ONLY", "V12.7 decisions require the exact project, action and fingerprint in the local operator CLI.");
        const requestId = decision[1], kind = decision[2] as "approve" | "deny";
        const approval = snapshot.approvals.find(a => a.request_id === requestId);
        if (!approval) throw new ControlError(404, "APPROVAL_NOT_FOUND", "Approval not found.");
        if (!approval.current || approval.consumed) throw new ControlError(409, "APPROVAL_CONFLICT", "Approval is no longer current or has been consumed.");
        try {
          if (approval.scope === "project") await decideExistingProjectApproval(root, approval.subject_id, requestId, kind);
          else if (approval.scope === "external") await decideExistingExternalApproval(root, requestId, kind);
          else await decideExistingApproval(root, requestId, kind);
        } catch { throw new ControlError(409, "APPROVAL_CONFLICT", "Approval cannot accept this decision; verify current state locally."); }
        snapshot = await readControlSnapshot(root); events = await syncControlEvents(root, snapshot);
        return { schema_version: 1, approval: snapshot.approvals.find(a => a.request_id === requestId), action_executed: false, money_spent_cents: 0 };
      }
      if (pathname === "/v1/summary") return snapshot.summary;
      if (pathname === "/v1/allocation") return { schema_version: 1, allocation: snapshot.allocation };
      if (pathname === "/v1/preparation") return { schema_version: 1, preparation: snapshot.preparation };
      if (project) {
        const found = snapshot.projects.find(p => p.project_id === project[1]);
        if (!found) throw new ControlError(404, "PROJECT_NOT_FOUND", "Project not found.");
        return { schema_version: 1, project: found };
      }
      if (pathname === "/v1/events") {
        const latest = events.at(-1)?.sequence ?? 0;
        if (after > latest) throw new ControlError(409, "CURSOR_AHEAD", "Cursor is ahead of this event history.");
        const items = events.filter(e => e.sequence > after).slice(0, limit);
        const next = items.at(-1)?.sequence ?? after;
        return { schema_version: 1, items, next_after: next, latest_sequence: latest, has_more: next < latest };
      }
      const items = pathname === "/v1/projects" ? snapshot.projects : pathname === "/v1/approvals" ? snapshot.approvals : snapshot.attention;
      return { schema_version: 1, items: items.slice(offset, offset + limit), total: items.length, next_offset: offset + limit < items.length ? offset + limit : null };
    });
    respond(res, 200, output);
  };
  const server = http.createServer({ maxHeaderSize: CONTROL_LIMITS.headerBytes, requestTimeout: CONTROL_LIMITS.requestMs,
    headersTimeout: CONTROL_LIMITS.requestMs, connectionsCheckingInterval: 1000 }, (req, res) => { void handle(req, res).catch(e => failure(res, e)); });
  server.maxConnections = CONTROL_LIMITS.connections;
  server.maxHeadersCount = 32; server.maxRequestsPerSocket = 1; server.keepAliveTimeout = 1000;
  server.setTimeout(CONTROL_LIMITS.requestMs, socket => socket.destroy());
  server.on("checkContinue", (_req, res) => failure(res, new ControlError(417, "EXPECTATION_FAILED", "Expect is not supported.")));
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connect", (_req, socket) => socket.destroy());
  server.on("clientError", (_err, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: config.port }, () => { server.off("error", reject); resolve(); }); });
  port = (server.address() as import("node:net").AddressInfo).port;
  let stop: Promise<void> | undefined;
  const close = () => stop ??= (async () => {
    closing = true;
    const ended = new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    // Do not terminate an atomic V6 write. Drain the bounded queue before sockets.
    await tail; server.closeAllConnections(); await ended;
  })();
  return { host: "127.0.0.1", port, url: `http://127.0.0.1:${port}`, close };
}
export async function runControlApi(): Promise<void> {
  const api = await startControlApi();
  await new Promise<void>(resolve => {
    const stop = () => { void api.close().finally(() => { process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(); }); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    console.log(`Scout Control API listening on ${api.url} (local only). No spending or execution is possible via this API.`);
  });
}
