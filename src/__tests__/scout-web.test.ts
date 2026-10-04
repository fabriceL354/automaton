import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SafeWebClient, publicAddress, publicHttpsUrl, WEB_LIMITS, nativeWebTransport, type WebTransport, type HttpReply } from "../scout-web/network.js";
import { DuckDuckGoHtmlProvider, DuckDuckGoLiteProvider, SearxngProvider, configuredSearchProvider, UnavailableSearchProvider, textFromHtml } from "../scout-web/search.js";
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
beforeEach(() => { vi.stubEnv("SCOUT_SEARCH_PROVIDER", "duckduckgo-html"); vi.stubEnv("SCOUT_SEARXNG_URL", undefined); });
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
    expect(search.results[0].index).toBe(0);
    expect(JSON.parse(await session.readIndex("read_search_result", search.results[0].index)).text).toBe("actual article");
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
    vi.stubEnv("SCOUT_SEARCH_PROVIDER", "duckduckgo-lite");
    const transport = fake(reply(htmlResult.replace("result__a", "result-link").replace("result__snippet", "result-snippet"), { "content-type": "text/html" }), reply("public article"));
    const original = sessionModule.WebResearchSession;
    vi.spyOn(sessionModule, "WebResearchSession").mockImplementation(inputs => new original(inputs, new SafeWebClient(transport)));
    const actions = [
      { tool: "write_file", content: "Premature report" },
      { tool: "read_file", path: "secret.txt" },
      { tool: "web_search", index: 99 },
      { tool: "read_search_result", index: 0 },
      { tool: "web_search", index: 0 },
      { tool: "read_search_result", index: 0 },
      { tool: "write_file", path: "MISSION.txt", content: "Wrong destination" },
      { tool: "write_file", content: "actual, complete answer to MISSION.txt" },
      { tool: "write_file", content: "Résumé public.\n\nSources\nhttps://fake.example/" },
    ];
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ message: { content: JSON.stringify(actions.shift()) } })));
    vi.stubGlobal("fetch", fetchMock);
    await runLocalScout({ model: DEFAULT_SCOUT_MODEL, baseUrl: "http://127.0.0.1:11434", root });
    expect(fetchMock).toHaveBeenCalledTimes(9);
    for (const [url] of fetchMock.mock.calls) expect(url).toBe("http://127.0.0.1:11434/api/chat");
    expect(transport.get).toHaveBeenCalledTimes(2);
    for (const [url] of transport.get.mock.calls) expect(url.href).not.toMatch(/WORKSPACE_SECRET|DO_NOT_SEND/);
    const report = await readFile(path.join(root, "rapport.txt"), "utf8");
    expect(await readFile(path.join(root, "MISSION.txt"), "utf8")).toContain("DO_NOT_SEND");
    expect(report).toContain("Résumé public."); expect(report).toContain("https://example.com/article"); expect(report).not.toContain("fake.example");
  });
});

describe("indexed Web state machine", () => {
  it.each([-1, 0.5, "0", null, {}, [], Number.MAX_SAFE_INTEGER + 1])("rejects invalid index %j", index => {
    for (const tool of ["web_search", "read_search_result", "read_public_url"]) {
      expect(() => parseScoutAction(JSON.stringify({ tool, index }))).toThrow();
    }
  });
  it("requires a useful page after search, preserves stable results and bounds", async () => {
    const transport = fake(reply(htmlResult, { "content-type": "text/html" }), reply("actual source"));
    const session = new WebResearchSession({ queries: ["public"], urls: [] }, new SafeWebClient(transport));
    expect(session.canWriteReport()).toBe(false);
    expect(session.nextStep()).toContain('"web_search"');
    for (const tool of ["web_search", "read_search_result", "read_public_url"] as const) {
      expect(() => session.indexedValue(tool, 99)).toThrow();
    }
    expect(() => session.indexedValue("read_search_result", 0)).toThrow();
    const results = JSON.parse(await session.searchIndex(0)).results;
    expect(results).toEqual([{ index: 0, title: "Example & title", snippet: "Public snippet" }]);
    expect(session.canWriteReport()).toBe(false);
    expect(session.nextStep()).toContain('"read_search_result"');
    expect(() => session.indexedValue("read_search_result", 1)).toThrow();
    expect(await session.readIndex("read_search_result", 0)).toContain("actual source");
    expect(session.canWriteReport()).toBe(true);
    expect(session.nextStep()).toContain("write_file with content only; runtime writes rapport.txt");
    expect(session.report("Summary")).toContain("https://example.com/article");
    expect(transport.get).toHaveBeenCalledTimes(2);
  });
  it("allows local reports, but refuses Web reports after failed or empty reads", async () => {
    expect(new WebResearchSession({ queries: [], urls: [] }).canWriteReport()).toBe(true);
    const transport = fake(reply(""), reply("binary", { "content-type": "application/octet-stream" }));
    const session = new WebResearchSession({ queries: [], urls: ["https://example.com/"] }, new SafeWebClient(transport));
    expect(session.nextStep()).toContain('"read_public_url"');
    expect(await session.readIndex("read_public_url", 0)).toMatch(/^ERROR:/);
    expect(session.canWriteReport()).toBe(false);
    expect(await session.readIndex("read_public_url", 0)).toMatch(/^ERROR:/);
    expect(session.canWriteReport()).toBe(false);
  });
  it("reads an indexed public URL and unlocks reporting", async () => {
    const session = new WebResearchSession({ queries: [], urls: ["https://example.com/"] }, new SafeWebClient(fake(reply("source"))));
    expect(await session.readIndex("read_public_url", 0)).toContain("source");
    expect(session.canWriteReport()).toBe(true);
    expect(session.sources()).toEqual(["https://example.com/"]);
  });
});

describe("explicit public search providers without Internet", () => {
  const jsonReply = (data: unknown) => reply(JSON.stringify(data), { "content-type": "application/json" });
  const result = { title: "Public <b>title</b>", url: "https://example.com/article", content: "Useful snippet" };
  it("uses one GET endpoint, validates results and records actual consultation", async () => {
    const transport = fake(jsonReply({ results: [result, { ...result, url: "https://127.0.0.1/" }] }));
    const client = new SafeWebClient(transport);
    const found = await new SearxngProvider("https://search.example/").search("public topic", client);
    expect(found.results).toEqual([{ title: "Public title", url: result.url, snippet: result.content }]);
    expect(transport.get.mock.calls[0][0].href).toBe("https://search.example/search?q=public+topic&format=json");
    expect(client.wasRead(found.consultedUrl)).toBe(true);
    expect(transport.get).toHaveBeenCalledTimes(1);
  });
  it.each([202, 403, 429, 500])("refuses HTTP %s without retries/fallback", async status => {
    const transport = fake(reply('{"results":[]}', { "content-type": "application/json" }, status));
    await expect(new SearxngProvider("https://search.example").search("public", new SafeWebClient(transport))).rejects.toThrow(`HTTP ${status}`);
    expect(transport.get).toHaveBeenCalledTimes(1);
  });
  it("keeps DuckDuckGo 202 blocked even with result-looking HTML", async () => {
    const transport = fake(reply(htmlResult, { "content-type": "text/html" }, 202));
    await expect(new DuckDuckGoHtmlProvider().search("public", new SafeWebClient(transport))).rejects.toThrow("HTTP 202");
    expect(transport.get).toHaveBeenCalledTimes(1);
  });
  it.each([null, [], {}, { error: "blocked", results: [result] }, { results: [] }, { results: [null] }, { results: [{ ...result, title: 42 }] }, { results: [{ ...result, content: {} }] }, { results: [{ ...result, url: "http://example.com/" }] }])("fails closed on malformed/empty results %j", async data => {
    await expect(new SearxngProvider("https://search.example").search("public", new SafeWebClient(fake(jsonReply(data))))).rejects.toThrow();
  });
  it.each(["text/html", "text/plain", "application/octet-stream"])("rejects %s for search JSON", async mime => {
    await expect(new SearxngProvider("https://search.example").search("public", new SafeWebClient(fake(reply('<form>captcha</form>', { "content-type": mime }))))).rejects.toThrow("MIME");
  });
  it("rejects JSON on normal page reads and oversized search JSON", async () => {
    await expect(new SafeWebClient(fake(jsonReply({ results: [result] }))).read("https://example.com")).rejects.toThrow("MIME");
    await expect(new SearxngProvider("https://search.example").search("public", new SafeWebClient(fake(reply("x".repeat(WEB_LIMITS.responseBytes + 1), { "content-type": "application/json" }))))).rejects.toThrow("limit");
  });
  it("applies private DNS and redirect checks to search endpoints", async () => {
    const privateDns = fake(jsonReply({ results: [result] })); privateDns.resolve.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(new SearxngProvider("https://search.example").search("public", new SafeWebClient(privateDns))).rejects.toThrow("DNS");
    expect(privateDns.get).not.toHaveBeenCalled();
    await expect(new SearxngProvider("https://search.example").search("public", new SafeWebClient(fake(reply("", { location: "https://127.0.0.1/" }, 302))))).rejects.toThrow();
  });
  it("disables search by default and validates operator configuration", async () => {
    const provider = configuredSearchProvider({});
    expect(provider).toBeInstanceOf(UnavailableSearchProvider);
    const transport = fake();
    await expect(provider.search("public", new SafeWebClient(transport))).rejects.toThrow("No public search provider");
    expect(transport.get).not.toHaveBeenCalled();
    expect(configuredSearchProvider({ SCOUT_SEARCH_PROVIDER: "searxng", SCOUT_SEARXNG_URL: "https://search.example" })).toBeInstanceOf(SearxngProvider);
    for (const config of [{ SCOUT_SEARCH_PROVIDER: "other" }, { SCOUT_SEARCH_PROVIDER: "searxng" }, { SCOUT_SEARCH_PROVIDER: "searxng", SCOUT_SEARXNG_URL: "https://localhost" }]) expect(() => configuredSearchProvider(config)).toThrow();
    for (const url of ["http://search.example", "https://u:p@search.example", "https://search.example/path", "https://search.example/?key=secret"]) expect(() => new SearxngProvider(url)).toThrow();
  });
  it("preserves indexed search → source → report with SearXNG", async () => {
    const transport = fake(jsonReply({ results: [result] }), reply("Source text"));
    const session = new WebResearchSession({ queries: ["public"], urls: [] }, new SafeWebClient(transport), new SearxngProvider("https://search.example"));
    expect(JSON.parse(await session.searchIndex(0)).results[0].index).toBe(0);
    expect(session.canWriteReport()).toBe(false);
    await session.readIndex("read_search_result", 0);
    expect(session.canWriteReport()).toBe(true);
    expect(session.report("Original analysis")).toContain(result.url);
  });
});

describe("DuckDuckGo Lite simulated public search", () => {
  const lite = `<table><tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle&amp;rut=public" class="result-link">Example &amp; title</a></td></tr><tr><td class="result-snippet">Public <b>snippet</b></td></tr></table>`;
  const html = (text: string, status = 200) => reply(text, { "content-type": "text/html" }, status);
  it("selects only explicitly and uses the fixed endpoint with q only", async () => {
    expect(configuredSearchProvider({ SCOUT_SEARCH_PROVIDER: "duckduckgo-lite" })).toBeInstanceOf(DuckDuckGoLiteProvider);
    expect(configuredSearchProvider({})).toBeInstanceOf(UnavailableSearchProvider);
    const transport = fake(html(lite));
    const client = new SafeWebClient(transport);
    const found = await new DuckDuckGoLiteProvider().search("exact public & topic", client);
    expect(found.results).toEqual([{ title: "Example & title", url: "https://example.com/article", snippet: "Public snippet" }]);
    const request = transport.get.mock.calls[0][0];
    expect(request.origin + request.pathname).toBe("https://lite.duckduckgo.com/lite/");
    expect([...request.searchParams]).toEqual([["q", "exact public & topic"]]);
    expect(client.wasRead(found.consultedUrl)).toBe(true);
    expect(transport.get).toHaveBeenCalledTimes(1);
  });
  it("deduplicates decoded links and bounds results/title/snippet", async () => {
    const extra = Array.from({ length: 8 }, (_, i) => `<a class='other result-link' href='https://example.com/${i}'>${"T".repeat(300)}</a><td class='result-snippet'>${"S".repeat(500)}</td>`).join("");
    const found = await new DuckDuckGoLiteProvider().search("public", new SafeWebClient(fake(html(lite + lite + extra))));
    expect(found.results).toHaveLength(5);
    expect(found.results.filter(row => row.url === "https://example.com/article")).toHaveLength(1);
    expect(found.results.every(row => row.title.length <= 200 && row.snippet.length <= 400)).toBe(true);
  });
  it.each(["http://example.com/", "https://127.0.0.1/", "https://10.0.0.1/", "https://u:p@example.com/", "file:///etc/passwd", "javascript:alert(1)"])("never offers dangerous direct or wrapped URLs %s", async url => {
    for (const href of [url, `https://duckduckgo.com/l/?uddg=${encodeURIComponent(url)}`]) {
      await expect(new DuckDuckGoLiteProvider().search("public", new SafeWebClient(fake(html(`<a class='result-link' href='${href}'>Unsafe</a>`))))).rejects.toThrow("no usable results");
    }
  });
  it.each(["", "<html>Unusual page</html>", "<a href='https://example.com/'>No class</a>", "<a class='result-linkish' href='https://example.com/'>Wrong class</a>", "<a data-class='result-link' href='https://example.com/'>Not a class</a>", "<a class='result-link' href='https://duckduckgo.com/about'>Navigation</a>", "<a class='result-link' href='https://example.com/'> </a>"])("refuses empty/unsupported HTML %j", async text => {
    await expect(new DuckDuckGoLiteProvider().search("public", new SafeWebClient(fake(html(text))))).rejects.toThrow();
  });
  it.each(["CAPTCHA", "challenge-form", "anomaly.js", "Verify you are human"])("refuses %s even alongside result links", async marker => {
    const transport = fake(html(lite + `<form>${marker}</form>`));
    await expect(new DuckDuckGoLiteProvider().search("public", new SafeWebClient(transport))).rejects.toThrow("blocked");
    expect(transport.get).toHaveBeenCalledTimes(1);
  });
  it.each([202, 403, 429])("never accepts HTTP %s as search results", async status => {
    await expect(new DuckDuckGoLiteProvider().search("public", new SafeWebClient(fake(html(lite, status))))).rejects.toThrow(`HTTP ${status}`);
  });
  it("rejects non-HTML, oversized responses, private DNS and redirects", async () => {
    await expect(new DuckDuckGoLiteProvider().search("public", new SafeWebClient(fake(reply(lite))))).rejects.toThrow("unexpected");
    await expect(new DuckDuckGoLiteProvider().search("public", new SafeWebClient(fake(html("x".repeat(WEB_LIMITS.responseBytes + 1)))))).rejects.toThrow("limit");
    const transport = fake(html(lite)); transport.resolve.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(new DuckDuckGoLiteProvider().search("public", new SafeWebClient(transport))).rejects.toThrow("DNS");
    expect(transport.get).not.toHaveBeenCalled();
    await expect(new DuckDuckGoLiteProvider().search("public", new SafeWebClient(fake(reply("", { location: "https://127.0.0.1/" }, 302))))).rejects.toThrow();
  });
  it("preserves indexed search/read/report and consults destinations only when requested", async () => {
    const transport = fake(html(lite), reply("Useful public source"));
    const session = new WebResearchSession({ queries: ["public"], urls: [] }, new SafeWebClient(transport), new DuckDuckGoLiteProvider());
    expect(await session.search("unapproved secret")).toMatch(/^ERROR:/);
    expect(transport.get).not.toHaveBeenCalled();
    expect(JSON.parse(await session.searchIndex(0)).results[0].index).toBe(0);
    expect(transport.get).toHaveBeenCalledTimes(1);
    expect(session.canWriteReport()).toBe(false);
    expect(() => session.indexedValue("read_search_result", 1)).toThrow();
    await session.readIndex("read_search_result", 0);
    expect(session.canWriteReport()).toBe(true);
    expect(session.report("Original answer")).toContain("https://example.com/article");
    expect(transport.get).toHaveBeenCalledTimes(2);
  });
});
