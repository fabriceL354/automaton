import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, symlink, link, rm } from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import path from "node:path";
import { createLocalWorkspaceTools } from "../agent/local-tools.js";
import * as localTools from "../agent/local-tools.js";
import { localOllamaUrl, runLocalScout, loadLocalScoutConfig, DEFAULT_SCOUT_MODEL, loadLocalScoutSettings, parseScoutAction } from "../agent/local-runner.js";

let temp: string;
let root: string;
let tools: ReturnType<typeof createLocalWorkspaceTools>;
const call = (name: string, args: Record<string, unknown> = {}) =>
  (tools.find(t => t.name === name)!.execute as (args: Record<string, unknown>) => Promise<string>)(args);
const reply = (action: unknown) => new Response(JSON.stringify({ message: { content: JSON.stringify(action) } }), { status: 200 });

beforeEach(async () => {
  for (const name of ["SCOUT_NUM_CTX", "SCOUT_NUM_PREDICT", "SCOUT_TIMEOUT_MS", "SCOUT_PUBLIC_QUERIES", "SCOUT_PUBLIC_URLS", "SCOUT_DEBUG_ACTIONS", "SCOUT_SEARCH_PROVIDER", "SCOUT_SEARXNG_URL"]) vi.stubEnv(name, undefined);
  temp = await mkdtemp(path.join(os.tmpdir(), "scout-test-"));
  root = path.join(temp, "workspace");
  await mkdir(root);
  tools = createLocalWorkspaceTools(root);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(temp, { recursive: true, force: true }); });

describe("Scout local workspace security", () => {
  it("exposes only file tools and writes/reads a report", async () => {
    expect(tools.map(t => t.name)).toEqual(["list_files", "read_file", "write_file"]);
    expect(await call("write_file", { path: "rapport.txt", content: "Scout opérationnel" })).toContain("File written:");
    expect(await call("read_file", { path: "rapport.txt" })).toBe("Scout opérationnel");
    expect(await call("list_files")).toContain("rapport.txt");
  });
  it("blocks traversal, absolute paths, symlinks and hard links", async () => {
    const outside = path.join(temp, "outside.txt");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(root, "linked.txt"));
    await symlink(temp, path.join(root, "escape"));
    await link(outside, path.join(root, "hard.txt"));
    for (const file of ["../outside.txt", outside, "linked.txt", "escape/outside.txt", "hard.txt", ""]) {
      expect(await call("read_file", { path: file })).toMatch(/^ERROR:/);
      expect(await call("write_file", { path: file, content: "corrupt" })).toMatch(/^ERROR:/);
    }
    expect(await readFile(outside, "utf8")).toBe("secret");
  });
  it("blocks a symlinked workspace and preserves the mission", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "mission");
    expect(await call("write_file", { path: "sub/../MISSION.txt", content: "changed" })).toMatch(/^ERROR:/);
    expect(await readFile(path.join(root, "MISSION.txt"), "utf8")).toBe("mission");
    await symlink(root, path.join(temp, "alias"));
    tools = createLocalWorkspaceTools(path.join(temp, "alias"));
    expect(await call("read_file", { path: "MISSION.txt" })).toMatch(/^ERROR:/);
    expect(await call("write_file", { path: "rapport.txt", content: "bad" })).toMatch(/^ERROR:/);
  });
  it("validates arguments and limits file size", async () => {
    expect(await call("write_file", { path: "a" })).toMatch(/^ERROR:/);
    expect(await call("read_file")).toMatch(/^ERROR:/);
    expect(await call("write_file", { path: "a", content: "a".repeat(128 * 1024 + 1) })).toMatch(/^ERROR:/);
    await writeFile(path.join(root, "large"), "a".repeat(128 * 1024 + 1));
    expect(await call("read_file", { path: "large" })).toMatch(/^ERROR:/);
  });
});

describe("Scout CPU settings", () => {
  it("defaults to 2048 context tokens, 256 output tokens and 300 seconds", () => {
    expect(loadLocalScoutSettings({})).toEqual({ numCtx: 2048, numPredict: 256, timeoutMs: 300_000 });
  });
  it.each([
    ["SCOUT_NUM_CTX", "numCtx", 512, 8192],
    ["SCOUT_NUM_PREDICT", "numPredict", 64, 2048],
    ["SCOUT_TIMEOUT_MS", "timeoutMs", 1000, 1_800_000],
  ] as const)("accepts both inclusive bounds for %s", (name, key, min, max) => {
    expect(loadLocalScoutSettings({ [name]: String(min) })[key]).toBe(min);
    expect(loadLocalScoutSettings({ [name]: String(max) })[key]).toBe(max);
    expect(() => loadLocalScoutSettings({ [name]: String(min - 1) })).toThrow(name);
    expect(() => loadLocalScoutSettings({ [name]: String(max + 1) })).toThrow(name);
  });
  it.each(["", " ", " 2048", "2048 ", "2048\n", "2048\r\n", "\t2048", "１２３４", "0", "-1", "+2048", "2048.0", "2e3", "0x800", "02048", "2048junk", "NaN", "Infinity", "9007199254740992"])("rejects noncanonical or unsafe value %j for every setting", (raw) => {
    for (const name of ["SCOUT_NUM_CTX", "SCOUT_NUM_PREDICT", "SCOUT_TIMEOUT_MS"]) {
      expect(() => loadLocalScoutSettings({ [name]: raw })).toThrow(name);
    }
  });
  it("passes defaults and the matching abort signal to Ollama", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Write a report");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn().mockResolvedValueOnce(reply({ tool: "write_file", content: "report" }));
    vi.stubGlobal("fetch", fetchMock);
    await runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root });
    const request = fetchMock.mock.calls[0][1];
    expect(JSON.parse(request.body).options).toEqual({ temperature: 0, num_ctx: 2048, num_predict: 256 });
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(300_000);
    expect(request.signal).toBe(timeout.mock.results[0].value);
  });
  it("passes env overrides and the fast local model unchanged, then stops after the report", async () => {
    vi.stubEnv("SCOUT_NUM_CTX", "1024"); vi.stubEnv("SCOUT_NUM_PREDICT", "128"); vi.stubEnv("SCOUT_TIMEOUT_MS", "600000");
    vi.stubEnv("SCOUT_MODEL", "qwen2.5:0.5b-instruct"); vi.stubEnv("OLLAMA_BASE_URL", "");
    vi.spyOn(os, "homedir").mockReturnValue(temp);
    await writeFile(path.join(root, "MISSION.txt"), "Write a report");
    const config = await loadLocalScoutConfig();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn().mockResolvedValueOnce(reply({ tool: "write_file", content: "report" }));
    vi.stubGlobal("fetch", fetchMock);
    await runLocalScout({ ...config, root });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(body.model).toBe("qwen2.5:0.5b-instruct");
    expect(body.options).toEqual({ temperature: 0, num_ctx: 1024, num_predict: 128 });
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(600_000);
    expect(request.signal).toBe(timeout.mock.results[0].value);
    expect(await readFile(path.join(root, "rapport.txt"), "utf8")).toBe("report\n\nSources\nAucune source Web consultée avec succès.\n");
  });
  it.each(["SCOUT_NUM_CTX", "SCOUT_NUM_PREDICT", "SCOUT_TIMEOUT_MS"])("fails before inference on invalid %s", async (name) => {
    vi.stubEnv(name, "invalid");
    await writeFile(path.join(root, "MISSION.txt"), "Write a report");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root })).rejects.toThrow(name);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("propagates a timeout without any remote or model fallback", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Write a report");
    const fetchMock = vi.fn().mockRejectedValueOnce(new DOMException("request timed out", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root })).rejects.toThrow("timed out");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/chat");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(DEFAULT_SCOUT_MODEL);
  });
});

describe("Scout JSON action validation", () => {
  it.each([
    { tool: "list_files" },
    { tool: "read_file", path: "MISSION.txt" },
    { tool: "write_file", content: "2 + 2 = 4." },
  ])("accepts the exact contract for $tool", (action) => {
    expect(parseScoutAction(JSON.stringify(action))).toEqual(action);
  });
  const validWrite = { tool: "write_file", content: "overwrite" };
  const invalid = [
    "", "not JSON", '{"tool":"write_file"',
    '```json\n{"tool":"write_file","path":"rapport.txt","content":"bad"}\n```',
    JSON.stringify(null), JSON.stringify([]), JSON.stringify([validWrite]),
    JSON.stringify("write_file"), JSON.stringify(42), JSON.stringify(true),
    JSON.stringify({}), JSON.stringify({ tool: "write_file", path: "rapport.txt" }),
    JSON.stringify({ path: "rapport.txt", content: "bad" }),
    JSON.stringify({ tool: "exec", path: "", content: "curl remote" }),
    JSON.stringify({ ...validWrite, tool: "fetch" }),
    JSON.stringify({ ...validWrite, tool: "topup_credits" }),
    JSON.stringify({ ...validWrite, tool: "finish" }),
    JSON.stringify({ ...validWrite, tool: "constructor" }),
    JSON.stringify({ ...validWrite, tool: 1 }),
    JSON.stringify({ ...validWrite, tool: null }),
    JSON.stringify({ ...validWrite, tool: ["write_file"] }),
    JSON.stringify({ ...validWrite, path: 1 }),
    JSON.stringify({ ...validWrite, path: null }),
    JSON.stringify({ ...validWrite, path: ["rapport.txt"] }),
    JSON.stringify({ ...validWrite, content: 42 }),
    JSON.stringify({ ...validWrite, content: null }),
    JSON.stringify({ ...validWrite, content: { text: "bad" } }),
    JSON.stringify({ ...validWrite, content: ["bad"] }),
    JSON.stringify({ ...validWrite, extra: "unexpected" }),
    JSON.stringify({ ...validWrite, arguments: { path: "rapport.txt", content: "bad" } }),
    '{"tool":"write_file","path":"rapport.txt","content":"bad","__proto__":{}}',
    JSON.stringify({ tool: "list_files", path: "rapport.txt", content: "" }),
    JSON.stringify({ tool: "list_files", path: "", content: "bad" }),
    JSON.stringify({ tool: "read_file", path: "MISSION.txt", content: "bad" }),
    ...["", " ", ".", "..", "../rapport.txt", "dir/../../rapport.txt", "/tmp/rapport.txt", "rapport\0.txt"].map(file => JSON.stringify({ ...validWrite, path: file })),
  ];
  it.each(invalid)("rejects action %j before any model-directed tool execution", async (raw) => {
    await writeFile(path.join(root, "MISSION.txt"), "Write a report");
    await writeFile(path.join(root, "rapport.txt"), "old report");
    const original = localTools.createLocalWorkspaceTools;
    const executed: string[] = [];
    vi.spyOn(localTools, "createLocalWorkspaceTools").mockImplementation(workspace =>
      original(workspace).map(tool => ({ ...tool, execute: async (args, context) => {
        executed.push(tool.name);
        return tool.execute(args, context);
      } })));
    const events = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: raw } }))));
    await expect(runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root, maxTurns: 1, onEvent: events })).rejects.toThrow("limit");
    expect(executed).toEqual(["list_files", "read_file"]); // Startup only.
    expect(events).toHaveBeenCalledWith("ERROR: invalid Scout action rejected before tool execution");
    expect(await readFile(path.join(root, "rapport.txt"), "utf8")).toBe("old report");
  });
  it("can correct a rejected action and finish after one validated report write", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Combien font 2 + 2 ?");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ tool: "write_file", content: "bad", extra: true }))
      .mockResolvedValueOnce(reply({ tool: "write_file", content: "2 + 2 = 4." }));
    vi.stubGlobal("fetch", fetchMock);
    await runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root, maxTurns: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages.at(-1).content).toContain("action rejected");
    expect(await readFile(path.join(root, "rapport.txt"), "utf8")).toBe("2 + 2 = 4.\n\nSources\nAucune source Web consultée avec succès.\n");
  });
});

describe("Scout local runtime", () => {
  it("rejects remote endpoints, credentials, paths and redirects", () => {
    expect(localOllamaUrl()).toBe("http://127.0.0.1:11434");
    expect(localOllamaUrl("http://[::1]:11434")).toBe("http://[::1]:11434");
    for (const url of ["https://example.com", "http://192.168.1.1", "http://localhost", "http://user:pass@127.0.0.1", "http://127.0.0.1/api", "http://127.0.0.1?url=remote"]) {
      expect(() => localOllamaUrl(url)).toThrow();
    }
  });
  it("loads mission automatically, executes read_file/write_file and verifies report", async () => {
    const mission = "Lire MISSION.txt et rédiger un rapport local.";
    await writeFile(path.join(root, "MISSION.txt"), mission);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ tool: "read_file", path: "MISSION.txt" }))
      .mockResolvedValueOnce(reply({ tool: "write_file", content: "Scout local opérationnel" }));
    vi.stubGlobal("fetch", fetchMock);
    await runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root });
    expect(await readFile(path.join(root, "rapport.txt"), "utf8")).toBe("Scout local opérationnel\n\nSources\nAucune source Web consultée avec succès.\n");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, request] of fetchMock.mock.calls) {
      expect(url).toBe("http://127.0.0.1:11434/api/chat");
      expect(request.redirect).toBe("error");
      const body = JSON.parse(request.body);
      expect(body.model).toBe(DEFAULT_SCOUT_MODEL);
      expect(body.messages[1].content).toContain(mission);
      expect(body.messages[0].content).not.toMatch(/credits critically low/i);
      expect(body.messages[0].content).not.toContain("actual, complete answer to MISSION.txt");
      expect(body.messages[0].content).not.toMatch(/"content"\s*:/);
      expect(body.messages[0].content).toContain("Do not write a status-only message");
      expect(body.format).toBe("json");
    }
  });
  it("succeeds on the last allowed turn and preserves the first report without another inference", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Combien font 2 + 2 ?");
    const events = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ tool: "write_file", content: "2 + 2 = 4." }))
      .mockResolvedValueOnce(reply({ tool: "write_file", content: "rapport prêt" }));
    vi.stubGlobal("fetch", fetchMock);
    await runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root, maxTurns: 1, onEvent: events });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(root, "rapport.txt"), "utf8")).toBe("2 + 2 = 4.\n\nSources\nAucune source Web consultée avec succès.\n");
    expect(events).toHaveBeenCalledWith("Scout completed: rapport.txt verified.");
  });
  it("retries a whitespace-only report instead of announcing success", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Combien font 2 + 2 ?");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ tool: "write_file", content: " \n\t" }))
      .mockResolvedValueOnce(reply({ tool: "write_file", content: "2 + 2 = 4." }));
    vi.stubGlobal("fetch", fetchMock);
    await runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root, maxTurns: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages.at(-1).content).toContain("original substantive answer to MISSION.txt");
  });
  it("rereads the report and rejects an unreadable file even when write_file claims success", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Write a report");
    const original = localTools.createLocalWorkspaceTools;
    vi.spyOn(localTools, "createLocalWorkspaceTools").mockImplementation((workspace) =>
      original(workspace).map(tool => tool.name === "write_file"
        ? { ...tool, execute: async () => "File written: rapport.txt" } : tool));
    const events = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply({ tool: "write_file", content: "report" })));
    await expect(runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root, maxTurns: 1, onEvent: events })).rejects.toThrow("limit");
    expect(events).not.toHaveBeenCalledWith("Scout completed: rapport.txt verified.");
  });
  it("does not finish for another file or a blocked write, even with an old report", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Write a report");
    await writeFile(path.join(root, "rapport.txt"), "old report");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ tool: "write_file", path: "notes.txt", content: "notes" }))
      .mockResolvedValueOnce(reply({ tool: "write_file", path: "../rapport.txt", content: "escape" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root, maxTurns: 2 })).rejects.toThrow("limit");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(root, "rapport.txt"), "utf8")).toBe("old report");
  });
  it("does not call Ollama without a mission", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root })).rejects.toThrow("MISSION.txt");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects false success, unavailable tools and invalid JSON with a finite limit", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Write a report");
    await writeFile(path.join(root, "rapport.txt"), "old report");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ tool: "exec", path: "", content: "curl remote" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: "not JSON" } })))
      .mockImplementation(async () => reply({ tool: "finish" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root, maxTurns: 4 })).rejects.toThrow("limit");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(await readFile(path.join(root, "rapport.txt"), "utf8")).toBe("old report");
  });
  it("fails closed on an unavailable Ollama model", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Write a report");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('model not found', { status: 404 })));
    await expect(runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root })).rejects.toThrow("404");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("uses Qwen by default, normalizes localhost and rejects remote config", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(temp);
    vi.stubEnv("SCOUT_MODEL", ""); vi.stubEnv("OLLAMA_BASE_URL", "");
    await mkdir(path.join(temp, ".automaton"));
    await writeFile(path.join(temp, ".automaton", "automaton.json"), JSON.stringify({ inferenceModel: "gemma3:1b", ollamaBaseUrl: "http://localhost:11434" }));
    expect(await loadLocalScoutConfig()).toEqual({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl() });
    vi.stubEnv("OLLAMA_BASE_URL", "https://example.com");
    await expect(loadLocalScoutConfig()).rejects.toThrow("loopback");
  });
});


describe("Scout CLI integration", () => {
  it("runs the real CLI against loopback Ollama and exits after its report", async () => {
    const workspace = path.join(temp, ".automaton", "scout-workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "MISSION.txt"), "Mission intégration CLI");
    const requests: Array<{ url: string; body: any }> = [];
    const actions = [
      { tool: "read_file", path: "MISSION.txt" },
      { tool: "write_file", content: "Rapport du test CLI" },
    ];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests.push({ url: req.url!, body: JSON.parse(raw) });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ message: { content: JSON.stringify(actions[requests.length - 1]) } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/index.ts", "--run"], {
        env: { ...process.env, HOME: temp, SCOUT_MODEL: "", OLLAMA_BASE_URL: `http://127.0.0.1:${port}` }, timeout: 10_000,
      });
      expect(stdout).toContain("rapport.txt verified");
      expect(stdout).not.toMatch(/credits|Conway|wallet/i);
      expect(requests.map(r => r.url)).toEqual(["/api/chat", "/api/chat"]);
      expect(requests[0].body.messages[1].content).toContain("Mission intégration CLI");
      expect(requests[0].body.model).toBe(DEFAULT_SCOUT_MODEL);
      expect(requests[0].body.format).toBe("json");
      expect(requests[0].body.options).toEqual({ temperature: 0, num_ctx: 2048, num_predict: 256 });
      expect(await readFile(path.join(workspace, "rapport.txt"), "utf8")).toBe("Rapport du test CLI\n\nSources\nAucune source Web consultée avec succès.\n");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it("blocks provisioning instead of launching external setup", async () => {
    await expect(promisify(execFile)(process.execPath, ["--import", "tsx", "src/index.ts", "--provision"], {
      env: { ...process.env, HOME: temp }, timeout: 10_000,
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("disabled") });
  });
});

describe("compact tool contracts and local diagnostics", () => {
  const actions = [
    { tool: "list_files" },
    { tool: "read_file", path: "MISSION.txt" },
    { tool: "write_file", content: "answer" },
    { tool: "web_search", index: 0 },
    { tool: "read_search_result", index: 0 },
    { tool: "read_public_url", index: 0 },
  ];
  it.each(actions)("accepts only the exact fields for $tool", action => {
    expect(parseScoutAction(JSON.stringify(action))).toEqual(action);
    expect(() => parseScoutAction(JSON.stringify({ ...action, extra: "ignored?" }))).toThrow();
    for (const key of Object.keys(action)) {
      expect(() => parseScoutAction(JSON.stringify({ ...action, [key]: null }))).toThrow();
      const missing = { ...action } as Record<string, unknown>;
      delete missing[key];
      expect(() => parseScoutAction(JSON.stringify(missing))).toThrow();
    }
  });
  it.each(["", " ", "public\nsecret", "x".repeat(501)])("rejects malformed queries", query => {
    expect(() => parseScoutAction(JSON.stringify({ tool: "web_search", query }))).toThrow();
  });
  it.each([undefined, "0", "1"])("prints only rejected raw actions when debug is %s", async debug => {
    vi.stubEnv("SCOUT_DEBUG_ACTIONS", debug);
    await writeFile(path.join(root, "MISSION.txt"), "Answer this mission");
    const raw = '{"tool":"list_files","content":"unexpected"}';
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const events = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: raw } })))
      .mockResolvedValueOnce(reply({ tool: "write_file", content: "Answer" }));
    vi.stubGlobal("fetch", fetchMock);
    await runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: "http://127.0.0.1:11434", root, maxTurns: 2, onEvent: events });
    if (debug === "1") expect(diagnostic.mock.calls).toEqual([[raw]]);
    else expect(diagnostic).not.toHaveBeenCalled();
    expect(events.mock.calls.flat()).not.toContain(raw);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content.length).toBeLessThan(1000);
  });
  it.each(["", "true", "2", " 1"])("rejects invalid debug setting %s before inference", async debug => {
    vi.stubEnv("SCOUT_DEBUG_ACTIONS", debug);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: "http://127.0.0.1:11434", root })).rejects.toThrow("SCOUT_DEBUG_ACTIONS");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("report content quality gate", () => {
  it.each([
    "", " \n\t", "actual, complete answer to MISSION.txt", "Actual, complete answer to MISSION.txt.",
    "your actual answer to MISSION.txt", "rapport final", "rapport prêt", "Le rapport est prêt.",
    "The report is ready.", "Mission completed!", "Research this topic", "Research   this topic\n",
    "Sources\nhttps://example.com/", "actual, complete answer to MISSION.txt\n\nSources\nhttps://example.com/",
  ])("refuses %j before writing, then accepts an original answer", async bad => {
    await writeFile(path.join(root, "MISSION.txt"), "Research this topic");
    await writeFile(path.join(root, "rapport.txt"), "Existing report");
    const originalFactory = localTools.createLocalWorkspaceTools;
    const written: string[] = [];
    vi.spyOn(localTools, "createLocalWorkspaceTools").mockImplementation(workspace => originalFactory(workspace).map(tool => ({
      ...tool, execute: async (args: Record<string, unknown>) => {
        if (tool.name === "write_file") {
          expect(await readFile(path.join(root, "rapport.txt"), "utf8")).toBe("Existing report");
          written.push(args.content as string);
        }
        return (tool.execute as (args: Record<string, unknown>) => Promise<string>)(args);
      },
    })));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ tool: "write_file", content: bad }))
      .mockResolvedValueOnce(reply({ tool: "write_file", content: "The source documents a two-year support period." }));
    vi.stubGlobal("fetch", fetchMock);
    const events = vi.fn();
    await runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: "http://127.0.0.1:11434", root, maxTurns: 2, onEvent: events });
    expect(events).toHaveBeenCalledWith("ERROR: report content rejected before writing");
    expect(written).toHaveLength(1);
    expect(await readFile(path.join(root, "rapport.txt"), "utf8")).toContain("two-year support period");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages.at(-1).content).toContain("Retry write_file");
  });
  it("does not create a report when every answer is a placeholder", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Research this topic");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply({ tool: "write_file", content: "actual, complete answer to MISSION.txt" })));
    await expect(runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: "http://127.0.0.1:11434", root, maxTurns: 1 })).rejects.toThrow("turn limit");
    await expect(readFile(path.join(root, "rapport.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("report reread content validation", () => {
  it("rejects a placeholder returned on reread despite a valid proposed answer", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Explain the source");
    const original = localTools.createLocalWorkspaceTools;
    vi.spyOn(localTools, "createLocalWorkspaceTools").mockImplementation(workspace => original(workspace).map(tool => tool.name === "read_file"
      ? { ...tool, execute: async (args: Record<string, unknown>) => args.path === "rapport.txt" ? "rapport prêt\n\nSources\nhttps://example.com/" : (tool.execute as (args: Record<string, unknown>) => Promise<string>)(args) }
      : tool));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply({ tool: "write_file", content: "The documentation describes scheduled maintenance." })));
    const events = vi.fn();
    await expect(runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root, maxTurns: 1, onEvent: events })).rejects.toThrow("turn limit");
    expect(events).not.toHaveBeenCalledWith("Scout completed: rapport.txt verified.");
  });
});

describe("Scout write destination belongs exclusively to runtime", () => {
  it.each(["MISSION.txt", "rapport.txt", "./rapport.txt", "notes.txt", "../rapport.txt", "", null, 42])("rejects path %j before any write tool execution", async filePath => {
    const action = { tool: "write_file", path: filePath, content: "Original answer" };
    expect(() => parseScoutAction(JSON.stringify(action))).toThrow();
    await writeFile(path.join(root, "MISSION.txt"), "Explain the source");
    await writeFile(path.join(root, "rapport.txt"), "Existing report");
    const original = localTools.createLocalWorkspaceTools;
    const write = vi.fn();
    vi.spyOn(localTools, "createLocalWorkspaceTools").mockImplementation(workspace => original(workspace).map(tool => tool.name === "write_file" ? { ...tool, execute: write } : tool));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply(action)));
    await expect(runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root, maxTurns: 1 })).rejects.toThrow("turn limit");
    expect(write).not.toHaveBeenCalled();
    expect(await readFile(path.join(root, "MISSION.txt"), "utf8")).toBe("Explain the source");
    expect(await readFile(path.join(root, "rapport.txt"), "utf8")).toBe("Existing report");
  });
});

describe("Scout V2.1 runtime report language", () => {
  const french = "Les sources sont dans le rapport et elles sont utiles pour les lecteurs avec une synthèse claire.";
  const english = "The sources are in the report and they are useful for readers with a clear summary of their findings.";
  it.each([
    ["Réponds en français", english, french, "français"],
    ["Answer in English", french, english, "English"],
  ])("refuses opposite-language prose then accepts requested language: %s", async (mission, wrong, correct, label) => {
    await writeFile(path.join(root, "MISSION.txt"), mission);
    await writeFile(path.join(root, "rapport.txt"), "Previous report");
    vi.stubEnv("SCOUT_DEBUG_ACTIONS", "1");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const wrongAction = { tool: "write_file", content: wrong };
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(wrongAction)).mockImplementationOnce(async () => {
      expect(await readFile(path.join(root, "rapport.txt"), "utf8")).toBe("Previous report");
      return reply({ tool: "write_file", content: correct });
    });
    vi.stubGlobal("fetch", fetchMock);
    const events = vi.fn();
    await runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root, maxTurns: 2, onEvent: events });
    expect(events).toHaveBeenCalledWith("ERROR: report language rejected before writing");
    expect(diagnostic.mock.calls).toEqual([[JSON.stringify(wrongAction)]]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages.at(-1).content).toContain(label);
    expect(await readFile(path.join(root, "rapport.txt"), "utf8")).toContain(correct);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
