import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SafeWebClient, publicAddress, publicHttpsUrl, WEB_LIMITS, nativeWebTransport, type WebTransport, type HttpReply } from "../scout-web/network.js";
import { DuckDuckGoHtmlProvider, textFromHtml } from "../scout-web/search.js";
import { WebResearchSession, publicWebInputs } from "../scout-web/session.js";
import * as sessionModule from "../scout-web/session.js";
import { parseScoutAction, runLocalScout, DEFAULT_SCOUT_MODEL } from "../agent/local-runner.js";
import * as https from "node:https";
import { EventEmitter } from "node:events";
vi.mock("node:https", async importOriginal => ({ ...await importOriginal<typeof import("node:https")>(), request: vi.fn() }));

const publicIp = { address: "93.184.216.34", family: 4 };
const htmlResult = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle">Example &amp; title</a><div class="result__snippet">Public snippet</div>`;
function reply(text = "public page", headers: Record<string, string | undefined> = { "content-type": "text/plain" }, status = 200): HttpReply {
  return { status, headers, body: (async function* () { yield Buffer.from(text); })(), close: vi.fn() };
}
function fake(...responses: HttpReply[]): WebTransport & { get: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn> } {
  return { resolve: vi.fn().mockResolvedValue([publicIp]), get: vi.fn().mockImplementation(async () => {
    if (!responses.length) throw new Error("No mock response");
    return responses.shift()!;
  }) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("Scout V2 public address/URL security", () => {
  it.each(["0.0.0.0", "0.1.2.3", "10.1.2.3", "127.0.0.1", "100.64.0.1", "100.127.255.255", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.9", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "::", "::1", "::ffff:8.8.8.8", "::ffff:127.0.0.1", "64:ff9b::808:808", "fe80::1", "fec0::1", "fc00::1", "fd00::1", "ff02::1", "2001::1", "2001:20::1", "2001:db8::1", "2002:808:808::1", "3ffe::1", "3fff::1", "3fff:ffff::1", "not-an-ip"])("rejects reserved/private address %s", address => {
    expect(publicAddress(address)).toBe(false);
  });
  it.each(["8.8.8.8", "93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])("allows public address %s", address => {
    expect(publicAddress(address)).toBe(true);
  });
  it.each(["http://example.com", "file:///etc/passwd", "data:text/plain,secret", "ftp://example.com", "javascript:alert(1)", "https://localhost", "https://localhost.example.local", "https://internal", "https://service.internal", "https://example.com:8443", "https://user:pass@example.com", "https://%75ser@example.com", "https://127.1", "https://2130706433", "https://0x7f000001", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://169.254.169.254", "https://224.0.0.1", "https://example.com.", " https://example.com", "https://example.com\\bad", "https://example.com\nsecret", "https://example.com/" + "x".repeat(2048)])("refuses unsafe URL %s", raw => {
    expect(() => publicHttpsUrl(raw)).toThrow();
  });
  it("normalizes safe URLs without fragments", () => {
    expect(publicHttpsUrl("https://example.com:443/a#fragment").href).toBe("https://example.com/a");
  });
});

describe("Scout V2 safe HTTP transport", () => {
  it("resolves and pins the exact public address before GET", async () => {
    const transport = fake(reply());
    expect(await new SafeWebClient(transport).read("https://example.com")).toEqual({ url: "https://example.com/", mime: "text/plain", text: "public page" });
    expect(transport.resolve).toHaveBeenCalledWith("example.com");
    expect(transport.get.mock.calls[0][1]).toEqual(publicIp);
    expect(transport.get.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
  });
  it.each([[], [{ address: "10.0.0.1", family: 4 }], [publicIp, { address: "127.0.0.1", family: 4 }], [{ address: "::ffff:93.184.216.34", family: 6 }], [{ address: "8.8.8.8", family: 6 }]].map(answers => ({ answers })))("fails closed on unsafe/mixed DNS answers $answers", async ({ answers }) => {
    const transport = fake(reply()); transport.resolve.mockResolvedValue(answers);
    await expect(new SafeWebClient(transport).read("https://example.com")).rejects.toThrow("DNS");
    expect(transport.get).not.toHaveBeenCalled();
  });
  it("fails closed on DNS failure", async () => {
    const transport = fake(reply()); transport.resolve.mockRejectedValue(new Error("DNS failed"));
    await expect(new SafeWebClient(transport).read("https://example.com")).rejects.toThrow();
    expect(transport.get).not.toHaveBeenCalled();
  });
  it.each(["http://example.com", "https://127.0.0.1", "https://user:pass@example.com", "file:///secret", "https://169.254.169.254"])("validates redirect target %s before connecting", async location => {
    const transport = fake(reply("", { location }, 302), reply());
    await expect(new SafeWebClient(transport).read("https://example.com")).rejects.toThrow();
    expect(transport.get).toHaveBeenCalledTimes(1);
  });
  it("rechecks DNS on redirects, blocking DNS rebinding", async () => {
    const transport = fake(reply("", { location: "/next" }, 307), reply());
    transport.resolve.mockResolvedValueOnce([publicIp]).mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    await expect(new SafeWebClient(transport).read("https://example.com")).rejects.toThrow("DNS");
    expect(transport.get).toHaveBeenCalledTimes(1);
  });
  it("allows relative HTTPS redirects and reports the final URL", async () => {
    const transport = fake(reply("", { location: "/final" }, 303), reply());
    expect((await new SafeWebClient(transport).read("https://example.com/start")).url).toBe("https://example.com/final");
    expect(transport.resolve).toHaveBeenCalledTimes(2);
  });
  it("limits redirect loops and closes responses", async () => {
    const responses = Array.from({ length: 4 }, () => reply("", { location: "/again" }, 302));
    const transport = fake(...responses);
    await expect(new SafeWebClient(transport).read("https://example.com")).rejects.toThrow("Redirect");
    expect(transport.get).toHaveBeenCalledTimes(4);
    for (const response of responses) expect(response.close).toHaveBeenCalled();
  });
  it.each(["application/octet-stream", "application/pdf", "application/javascript", "image/svg+xml", "application/json", "text/css", undefined])("rejects unsupported MIME %s", async mime => {
    const response = reply("binary", { "content-type": mime });
    await expect(new SafeWebClient(fake(response)).read("https://example.com")).rejects.toThrow("MIME");
    expect(response.close).toHaveBeenCalled();
  });
  it("rejects compressed bodies and unsupported charsets", async () => {
    await expect(new SafeWebClient(fake(reply("zip", { "content-type": "text/html", "content-encoding": "gzip" }))).read("https://example.com")).rejects.toThrow("Compressed");
    await expect(new SafeWebClient(fake(reply("text", { "content-type": "text/plain; charset=iso-8859-1" }))).read("https://example.com")).rejects.toThrow("charset");
  });
  it("enforces announced and streamed response sizes", async () => {
    await expect(new SafeWebClient(fake(reply("x", { "content-type": "text/plain", "content-length": String(WEB_LIMITS.responseBytes + 1) }))).read("https://example.com")).rejects.toThrow("large");
    await expect(new SafeWebClient(fake(reply("x".repeat(WEB_LIMITS.responseBytes + 1)))).read("https://example.com")).rejects.toThrow("byte limit");
  });
  it("enforces the cumulative byte limit across requests", async () => {
    const transport = fake(...Array.from({ length: 5 }, () => reply("x".repeat(WEB_LIMITS.responseBytes))));
    const client = new SafeWebClient(transport);
    for (let i = 0; i < 4; i++) await client.read("https://example.com");
    await expect(client.read("https://example.com")).rejects.toThrow("budget");
    expect(transport.get).toHaveBeenCalledTimes(4);
  });
  it("times out DNS, connection and body read using one strict deadline", async () => {
    vi.useFakeTimers();
    for (const stage of ["dns", "get", "body"]) {
      const transport = fake(reply());
      if (stage === "dns") transport.resolve.mockImplementation(() => new Promise(() => {}));
      if (stage === "get") transport.get.mockImplementation(() => new Promise(() => {}));
      if (stage === "body") transport.get.mockResolvedValue({ ...reply(), body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) } });
      const task = new SafeWebClient(transport).read("https://example.com");
      const assertion = expect(task).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(WEB_LIMITS.timeoutMs + 1);
      await assertion;
    }
  });
  it("native adapter uses GET with DNS pinning and no cookies/auth/referrer/body", async () => {
    const req = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
    req.end = vi.fn();
    const res = Object.assign(new EventEmitter(), reply(), { headers: { "content-type": "text/plain" }, statusCode: 200, destroy: vi.fn() });
    const spy = vi.mocked(https.request).mockImplementation(((_url: unknown, _opts: unknown, callback: Function) => { queueMicrotask(() => callback(res)); return req; }) as any);
    await nativeWebTransport.get(new URL("https://example.com"), publicIp, new AbortController().signal);
    const options = spy.mock.calls[0][1] as any;
    expect(options.method).toBe("GET"); expect(options.agent).toBe(false); expect(options.family).toBe(4);
    expect(Object.keys(options.headers).sort()).toEqual(["Accept", "Accept-Encoding", "User-Agent"].sort());
    const cb = vi.fn(); options.lookup("example.com", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, publicIp.address, 4);
    expect(req.end).toHaveBeenCalledWith();
  });
});

describe("Scout V2 search, extraction and capabilities", () => {
  it("extracts text without scripts, styles or HTML execution", () => {
    expect(textFromHtml('<script>secret()</script><style>hide</style><p>Hello &amp; &#233; &#x41;</p>')).toBe("Hello & é A");
  });
  it("searches by GET and returns titles, decoded HTTPS URLs and snippets", async () => {
    const transport = fake(reply(htmlResult, { "content-type": "text/html" }));
    const found = await new DuckDuckGoHtmlProvider().search("public query", new SafeWebClient(transport));
    expect(found.results).toEqual([{ title: "Example & title", url: "https://example.com/article", snippet: "Public snippet" }]);
    expect(transport.get.mock.calls[0][0].href).toBe("https://html.duckduckgo.com/html/?q=public+query");
  });
  it.each(["<form id='challenge-form'>captcha</form>", "<p>no results</p>"])("fails closed on blocked/unrecognized search HTML", async html => {
    await expect(new DuckDuckGoHtmlProvider().search("public query", new SafeWebClient(fake(reply(html, { "content-type": "text/html" }))))).rejects.toThrow();
  });
  it("filters unsafe search-result URLs", async () => {
    const html = htmlResult + '<a class="result__a" href="http://evil.com">HTTP</a><a class="result__a" href="https://127.0.0.1/">SSRF</a>';
    const found = await new DuckDuckGoHtmlProvider().search("public", new SafeWebClient(fake(reply(html, { "content-type": "text/html" }))));
    expect(found.results).toHaveLength(1);
  });
  it("loads only explicitly public environment inputs, validating shape and URLs", () => {
    expect(publicWebInputs({})).toEqual({ queries: [], urls: [] });
    expect(publicWebInputs({ SCOUT_PUBLIC_QUERIES: '["public query"]', SCOUT_PUBLIC_URLS: '["https://example.com"]' })).toEqual({ queries: ["public query"], urls: ["https://example.com/"] });
    for (const value of ["bad", "{}", "[null]", '["secret\\ntext"]', '["a","b","c","d"]']) expect(() => publicWebInputs({ SCOUT_PUBLIC_QUERIES: value })).toThrow();
    expect(() => publicWebInputs({ SCOUT_PUBLIC_URLS: '["https://127.0.0.1"]' })).toThrow();
  });
  it("blocks arbitrary/model-generated queries and URLs without any network access", async () => {
    const transport = fake(reply());
    const session = new WebResearchSession({ queries: ["public"], urls: ["https://example.com/"] }, new SafeWebClient(transport));
    expect(await session.search("workspace secret")).toMatch(/^ERROR:/);
    expect(await session.readPage("https://example.com/?secret=workspace")).toMatch(/^ERROR:/);
    expect(await session.readPage("https://example.com/encoded-secret")).toMatch(/^ERROR:/);
    expect(transport.get).not.toHaveBeenCalled();
  });
  it("refuses a provider's invented consultation without registering URLs", async () => {
    const transport = fake(reply());
    const provider = { search: vi.fn().mockResolvedValue({ results: [{ title: "fake", url: "https://fake.example/", snippet: "" }], consultedUrl: "https://invented.example/" }) };
    const session = new WebResearchSession({ queries: ["public"], urls: [] }, new SafeWebClient(transport), provider);
    expect(await session.search("public")).toMatch(/^ERROR:/);
    expect(session.sources()).toEqual([]);
    expect(await session.readPage("https://fake.example/")).toMatch(/^ERROR:/);
    expect(transport.get).not.toHaveBeenCalled();
  });
  it("omits empty, binary-looking and invalid UTF-8 pages from sources", async () => {
    const transport = fake(reply(" "), reply("bad\0text"), { ...reply(), body: (async function* () { yield Buffer.from([0xff]); })() });
    const session = new WebResearchSession({ queries: [], urls: ["https://example.com/"] }, new SafeWebClient(transport));
    for (let i = 0; i < 3; i++) expect(await session.readPage("https://example.com/")).toMatch(/^ERROR:/);
    expect(session.sources()).toEqual([]);
  });
  it("search → page → report includes only actually consulted sources", async () => {
    const transport = fake(reply(htmlResult, { "content-type": "text/html" }), reply("actual article"));
    const session = new WebResearchSession({ queries: ["public"], urls: [] }, new SafeWebClient(transport));
    const search = JSON.parse(await session.search("public"));
    expect(search.results[0].url).toBe("https://example.com/article");
    expect(JSON.parse(await session.readPage(search.results[0].url)).text).toBe("actual article");
    const report = session.report("Résumé https://invented.example/fake\n\nSources\n- https://invented.example/fake");
    expect(report).not.toContain("invented.example");
    expect(report).toContain("Sources\n- https://html.duckduckgo.com/html/?q=public\n- https://example.com/article");
    expect(session.report(" \n\t")).toBe("");
  });
  it("records final redirected URLs and refuses to cite failed or unvisited pages", async () => {
    const transport = fake(reply("", { location: "https://other.example/final" }, 302), reply("real text"), reply("not found", {}, 404));
    const session = new WebResearchSession({ queries: [], urls: ["https://example.com/", "https://failed.example/"] }, new SafeWebClient(transport));
    await session.readPage("https://example.com/"); await session.readPage("https://failed.example/");
    expect(session.sources()).toEqual(["https://other.example/final"]);
  });
  it("bounds pages, searches, extracts and failed attempts", async () => {
    const transport = fake(...Array.from({ length: 5 }, () => reply("x".repeat(7000))));
    const provider = { search: vi.fn().mockRejectedValue(new Error("blocked")) };
    const session = new WebResearchSession({ queries: ["public"], urls: ["https://example.com/"] }, new SafeWebClient(transport), provider);
    for (let i = 0; i < 3; i++) await session.search("public");
    expect(await session.search("public")).toContain("limit"); expect(provider.search).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 5; i++) expect(JSON.parse(await session.readPage("https://example.com/")).text.length).toBe(WEB_LIMITS.textChars);
    expect(await session.readPage("https://example.com/")).toContain("limit"); expect(transport.get).toHaveBeenCalledTimes(5);
  });
  it("counts failed reads toward the five-page limit", async () => {
    const transport = fake(...Array.from({ length: 5 }, () => reply("fail", {}, 500)));
    const session = new WebResearchSession({ queries: [], urls: ["https://example.com/"] }, new SafeWebClient(transport));
    for (let i = 0; i < 5; i++) expect(await session.readPage("https://example.com/")).toMatch(/^ERROR:/);
    expect(await session.readPage("https://example.com/")).toContain("limit");
    expect(transport.get).toHaveBeenCalledTimes(5);
    expect(session.sources()).toEqual([]);
  });
  it.each([
    { tool: "web_search", query: "public", content: "secret" },
    { tool: "read_web_page", url: "http://example.com" },
    { tool: "read_web_page", url: "https://127.0.0.1" },
    { tool: "web_search", query: "public", method: "POST" },
    { tool: "web_search", query: "public", headers: { Authorization: "secret" } },
    { tool: "read_web_page", url: "https://example.com", cookie: "secret" },
  ])("rejects malformed Web action $tool", action => {
    expect(() => parseScoutAction(JSON.stringify(action))).toThrow();
  });
});

describe("Scout V2 runner integration without Internet", () => {
  let temp: string;
  beforeEach(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "scout-v2-"));
    await mkdir(path.join(temp, "workspace"));
    for (const name of ["SCOUT_NUM_CTX", "SCOUT_NUM_PREDICT", "SCOUT_TIMEOUT_MS", "SCOUT_PUBLIC_QUERIES", "SCOUT_PUBLIC_URLS", "SCOUT_DEBUG_ACTIONS"]) vi.stubEnv(name, undefined);
  });
  afterEach(async () => { await rm(temp, { recursive: true, force: true }); });
  it("uses the two Web tools, synthesizes, appends verified Sources and stops immediately", async () => {
    const root = path.join(temp, "workspace");
    await writeFile(path.join(root, "MISSION.txt"), "Recherche sur un thème public. Local secret: DO_NOT_SEND");
    await writeFile(path.join(root, "secret.txt"), "WORKSPACE_SECRET");
    vi.stubEnv("SCOUT_PUBLIC_QUERIES", '["public topic"]');
    const transport = fake(reply(htmlResult, { "content-type": "text/html" }), reply("public article"));
    const original = sessionModule.WebResearchSession;
    vi.spyOn(sessionModule, "WebResearchSession").mockImplementation(inputs => new original(inputs, new SafeWebClient(transport)));
    const actions = [
      { tool: "read_file", path: "secret.txt" },
      { tool: "web_search", query: "WORKSPACE_SECRET" },
      { tool: "read_web_page", url: "https://unapproved.example/" },
      { tool: "web_search", query: "public topic" },
      { tool: "read_web_page", url: "https://example.com/article" },
      { tool: "write_file", path: "rapport.txt", content: "Résumé public.\n\nSources\nhttps://fake.example/" },
    ];
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ message: { content: JSON.stringify(actions.shift()) } })));
    vi.stubGlobal("fetch", fetchMock);
    await runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: "http://127.0.0.1:11434", root });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const [url] of fetchMock.mock.calls) expect(url).toBe("http://127.0.0.1:11434/api/chat");
    expect(transport.get).toHaveBeenCalledTimes(2);
    for (const [url] of transport.get.mock.calls) expect(url.href).not.toMatch(/WORKSPACE_SECRET|DO_NOT_SEND/);
    const report = await readFile(path.join(root, "rapport.txt"), "utf8");
    expect(report).toContain("Résumé public."); expect(report).toContain("https://example.com/article"); expect(report).not.toContain("fake.example");
  });
});
