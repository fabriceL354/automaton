import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, symlink, link, rm } from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import path from "node:path";
import { createLocalWorkspaceTools } from "../agent/local-tools.js";
import * as localTools from "../agent/local-tools.js";
import { localOllamaUrl, runLocalScout, loadLocalScoutConfig, DEFAULT_SCOUT_MODEL } from "../agent/local-runner.js";

let temp: string;
let root: string;
let tools: ReturnType<typeof createLocalWorkspaceTools>;
const call = (name: string, args: Record<string, unknown> = {}) =>
  (tools.find(t => t.name === name)!.execute as (args: Record<string, unknown>) => Promise<string>)(args);
const reply = (action: unknown) => new Response(JSON.stringify({ message: { content: JSON.stringify(action) } }), { status: 200 });

beforeEach(async () => {
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
      .mockResolvedValueOnce(reply({ tool: "read_file", path: "MISSION.txt", content: "" }))
      .mockResolvedValueOnce(reply({ tool: "write_file", path: "rapport.txt", content: "Scout local opérationnel" }));
    vi.stubGlobal("fetch", fetchMock);
    await runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root });
    expect(await readFile(path.join(root, "rapport.txt"), "utf8")).toBe("Scout local opérationnel");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, request] of fetchMock.mock.calls) {
      expect(url).toBe("http://127.0.0.1:11434/api/chat");
      expect(request.redirect).toBe("error");
      const body = JSON.parse(request.body);
      expect(body.model).toBe(DEFAULT_SCOUT_MODEL);
      expect(body.messages[1].content).toContain(mission);
      expect(body.messages[0].content).not.toMatch(/credits critically low/i);
      expect(body.messages[0].content).toContain("actual, complete answer to MISSION.txt");
      expect(body.messages[0].content).toContain("Do not write a status-only message");
      expect(body.format.properties.tool.enum).toEqual(["list_files", "read_file", "write_file"]);
    }
  });
  it("succeeds on the last allowed turn and preserves the first report without another inference", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Combien font 2 + 2 ?");
    const events = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ tool: "write_file", path: "./rapport.txt", content: "2 + 2 = 4." }))
      .mockResolvedValueOnce(reply({ tool: "write_file", path: "rapport.txt", content: "rapport prêt" }));
    vi.stubGlobal("fetch", fetchMock);
    await runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root, maxTurns: 1, onEvent: events });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(root, "rapport.txt"), "utf8")).toBe("2 + 2 = 4.");
    expect(events).toHaveBeenCalledWith("Scout completed: rapport.txt verified.");
  });
  it("retries a whitespace-only report instead of announcing success", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "Combien font 2 + 2 ?");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ tool: "write_file", path: "rapport.txt", content: " \n\t" }))
      .mockResolvedValueOnce(reply({ tool: "write_file", path: "rapport.txt", content: "2 + 2 = 4." }));
    vi.stubGlobal("fetch", fetchMock);
    await runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root, maxTurns: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages.at(-1).content).toContain("actual answer to MISSION.txt");
  });
  it("rereads the report and rejects an unreadable file even when write_file claims success", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "report");
    const original = localTools.createLocalWorkspaceTools;
    vi.spyOn(localTools, "createLocalWorkspaceTools").mockImplementation((workspace) =>
      original(workspace).map(tool => tool.name === "write_file"
        ? { ...tool, execute: async () => "File written: rapport.txt" } : tool));
    const events = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply({ tool: "write_file", path: "rapport.txt", content: "report" })));
    await expect(runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: localOllamaUrl(), root, maxTurns: 1, onEvent: events })).rejects.toThrow("limit");
    expect(events).not.toHaveBeenCalledWith("Scout completed: rapport.txt verified.");
  });
  it("does not finish for another file or a blocked write, even with an old report", async () => {
    await writeFile(path.join(root, "MISSION.txt"), "report");
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
    await writeFile(path.join(root, "MISSION.txt"), "report");
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
    await writeFile(path.join(root, "MISSION.txt"), "report");
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
      { tool: "read_file", path: "MISSION.txt", content: "" },
      { tool: "write_file", path: "rapport.txt", content: "Rapport du test CLI" },
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
      expect(await readFile(path.join(workspace, "rapport.txt"), "utf8")).toBe("Rapport du test CLI");
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
