/** HTTPS GET only. Resolve every hop, reject nonpublic answers, pin the socket. */
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { guardQuery, containsKnownPrivate } from "../agent/query-guard.js";

export const WEB_LIMITS = Object.freeze({ searches: 3, pages: 5, bytes: 1024 * 1024,
  responseBytes: 256 * 1024, redirects: 3, timeoutMs: 15_000, textChars: 6000 });
export const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
export interface WebByteLimits { bytes: number; responseBytes: number }
export interface ResolvedAddress { address: string; family: number; }
export interface HttpReply {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}
export interface WebTransport {
  resolve(host: string): Promise<ResolvedAddress[]>;
  get(url: URL, address: ResolvedAddress, signal: AbortSignal): Promise<HttpReply>;
  /** Trusted runtime only; native implementation refuses every other endpoint. */
  getBrave?(url: URL, address: ResolvedAddress, signal: AbortSignal, key: string): Promise<HttpReply>;
}

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const [first, second = "0"] = address.toLowerCase().split(":");
    const a = parseInt(first, 16), b = parseInt(second || "0", 16);
    // Conservative allowlist: global unicast only; exclude special use,
    // documentation, Teredo/6to4 and all IPv4-mapped/compatible forms.
    return a >= 0x2000 && a <= 0x3fff &&
      !(a === 0x2001 && (b <= 0x1ff || b === 0xdb8)) &&
      a !== 0x2002 && a !== 0x3ffe && a !== 0x3fff;
  }
  return false;
}

export function publicHttpsUrl(raw: string): URL {
  if (raw.length > 2048 || raw !== raw.trim() || /[\x00-\x20\\]/.test(raw)) throw new Error("Unsafe URL");
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !host || host.endsWith(".") || host === "localhost" ||
      /(?:^|\.)(?:localhost|local|internal|lan|onion)$/.test(host) ||
      (isIP(host) ? !publicAddress(host) : !host.includes("."))) throw new Error("Unsafe public HTTPS URL");
  url.hash = "";
  return url;
}

function nativeGet(url: URL, pinned: ResolvedAddress, signal: AbortSignal, key?: string): Promise<HttpReply> {
  if (key !== undefined && (url.origin + url.pathname !== BRAVE_ENDPOINT || url.username || url.password || url.hash)) {
    return Promise.reject(new Error("Brave endpoint refused"));
  }
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET", agent: false, family: pinned.family, signal, maxHeaderSize: 16 * 1024,
      headers: { Accept: key === undefined ? "text/html, text/plain;q=0.9" : "application/json", "Accept-Encoding": "identity", "User-Agent": "Scout/2.0 (public read-only research)",
        ...(key === undefined ? {} : { "X-Subscription-Token": key }) },
      // No second DNS lookup, proxy, credentials, cookies, referer or request body.
      // Explicit family also disables Node's automatic multi-address selection.
      lookup: ((_host: string, _options: unknown, callback: Function) =>
        callback(null, pinned.address, pinned.family)) as any,
    }, res => {
      res.on("error", () => {});
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(res.headers)) {
        if (typeof value === "string") headers[name] = value;
      }
      resolve({ status: res.statusCode ?? 0, headers, body: res, close: () => res.destroy() });
    });
    req.on("error", error => reject(key === undefined ? error : new Error("Brave transport unavailable")));
    req.end();
  });
}
export const nativeWebTransport: WebTransport = {
  resolve: host => lookup(host, { all: true, verbatim: true }),
  get: (url, pinned, signal) => nativeGet(url, pinned, signal),
  getBrave: (url, pinned, signal, key) => nativeGet(url, pinned, signal, key),
};

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Web request timed out"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class SafeWebClient {
  downloadedBytes = 0;
  decompressedBytes = 0;
  gzipReads = 0;
  private readonly completedReads = new Set<string>();
  wasRead(url: string): boolean { return this.completedReads.has(url); }
  constructor(private readonly transport: WebTransport = nativeWebTransport, private readonly limits: WebByteLimits = WEB_LIMITS,
    private readonly runSignal?: AbortSignal) {
    if (!Number.isSafeInteger(limits.bytes) || limits.bytes < 1 || limits.bytes > 4 * 1024 * 1024 ||
        !Number.isSafeInteger(limits.responseBytes) || limits.responseBytes < 1 || limits.responseBytes > WEB_LIMITS.responseBytes) throw new Error("Invalid Web byte limits");
    this.limits = Object.freeze({ ...limits });
  }

  /** The only credential-bearing Web request. No redirects or operator headers. */
  async readBraveSearch(query: string, key: string): Promise<{ url: string; mime: string; text: string }> {
    try {
      if (typeof key !== "string" || !/^[a-zA-Z0-9_.-]{8,256}$/.test(key) ||
          guardQuery(query, "MODEL_REFINEMENT", { knownSecrets: [key] }).decision !== "ACCEPT") throw new Error();
      const endpoint = new URL(BRAVE_ENDPOINT);
      endpoint.searchParams.set("q", query);
      endpoint.searchParams.set("count", "5");
      endpoint.searchParams.set("country", "FR");
      endpoint.searchParams.set("search_lang", "fr");
      endpoint.searchParams.set("safesearch", "strict");
      const page = await this.readResponse(endpoint.href, true, key);
      if (containsKnownPrivate(page.text, { knownSecrets: [key] })) throw new Error();
      return page;
    } catch { throw new Error("Brave search unavailable or response refused; no fallback"); }
  }

  async readSearchJson(raw: string): Promise<{ url: string; mime: string; text: string }> {
    return this.readResponse(raw, true);
  }
  async read(raw: string): Promise<{ url: string; mime: string; text: string }> {
    return this.readResponse(raw, false);
  }
  private async readResponse(raw: string, searchJson: boolean, braveKey?: string): Promise<{ url: string; mime: string; text: string }> {
    if (this.downloadedBytes >= this.limits.bytes || this.decompressedBytes >= this.limits.bytes) throw new Error("Web byte budget exhausted");
    let url = publicHttpsUrl(raw);
    const controller = new AbortController();
    this.runSignal?.throwIfAborted();
    const cancel = () => controller.abort();
    this.runSignal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), WEB_LIMITS.timeoutMs);
    try {
      for (let hop = 0; hop <= WEB_LIMITS.redirects; hop++) {
        controller.signal.throwIfAborted();
        const host = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] :
          await abortable(this.transport.resolve(host), controller.signal);
        if (!addresses.length || addresses.some(a => !publicAddress(a.address) || isIP(a.address) !== a.family)) throw new Error("DNS resolved to a forbidden address");
        controller.signal.throwIfAborted();
        const pending = braveKey === undefined ? this.transport.get(url, addresses[0], controller.signal) :
          this.transport.getBrave ? this.transport.getBrave(url, addresses[0], controller.signal, braveKey) : Promise.reject(new Error("Brave transport unavailable"));
        void pending.then(reply => { if (controller.signal.aborted) reply.close(); }, () => {});
        const response = await abortable(pending, controller.signal);
        try {
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (braveKey !== undefined) throw new Error("Brave redirect refused");
            if (hop === WEB_LIMITS.redirects || !response.headers.location) throw new Error("Redirect limit or missing location");
            url = publicHttpsUrl(new URL(response.headers.location, url).href);
            continue;
          }
          if (response.status !== 200) throw new Error(`Web HTTP ${response.status}`);
          const mime = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
          if (!mime || (searchJson ? mime !== "application/json" : mime !== "text/html" && mime !== "text/plain")) throw new Error("Unsupported Web MIME type");
          const encoding = response.headers["content-encoding"];
          if (encoding && encoding !== "identity" && encoding !== "gzip") throw new Error("Compressed Web response refused");
          if (/charset\s*=\s*["']?(?!utf-8\b|us-ascii\b)[\w-]+/i.test(response.headers["content-type"] ?? "")) throw new Error("Unsupported charset");
          const length = response.headers["content-length"];
          if (length && (!/^\d+$/.test(length) || Number(length) > this.limits.responseBytes || Number(length) > this.limits.bytes - this.downloadedBytes)) throw new Error("Web response too large");
          const chunks: Buffer[] = [];
          let size = 0, decodedSize = 0;
          const iterator = response.body[Symbol.asyncIterator]();
          const client = this;
          async function* boundedBody() {
            while (true) {
              const next = await abortable(iterator.next(), controller.signal);
              if (next.done) break;
              size += next.value.byteLength;
              client.downloadedBytes += next.value.byteLength;
              if (size > client.limits.responseBytes || client.downloadedBytes > client.limits.bytes) throw new Error("Web byte limit exceeded");
              yield next.value;
            }
          }
          const collect = (chunk: Uint8Array) => {
            decodedSize += chunk.byteLength;
            this.decompressedBytes += chunk.byteLength;
            if (decodedSize > this.limits.responseBytes || this.decompressedBytes > this.limits.bytes) throw new Error("Web decompressed byte limit exceeded");
            chunks.push(Buffer.from(chunk));
          };
          if (encoding === "gzip") {
            const source = Readable.from(boundedBody(), { objectMode: false, highWaterMark: 16 * 1024 });
            const gunzip = createGunzip({ chunkSize: 16 * 1024 });
            const sink = new Writable({ write(chunk, _encoding, callback) {
              try { collect(chunk); callback(); } catch (error) { callback(error as Error); }
            } });
            try { await abortable(pipeline(source, gunzip, sink, { signal: controller.signal }), controller.signal); }
            catch { throw new Error("Compressed Web response invalid, over limit or timed out"); }
            this.gzipReads++;
          } else {
            for await (const chunk of boundedBody()) collect(chunk);
          }
          const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          this.completedReads.add(url.href);
          return { url: url.href, mime, text };
        } finally { response.close(); }
      }
      throw new Error("Redirect limit exceeded");
    } finally { clearTimeout(timer); this.runSignal?.removeEventListener("abort", cancel); }
  }
}
