/** HTTPS GET only. Resolve every hop, reject nonpublic answers, pin the socket. */
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

export const WEB_LIMITS = Object.freeze({ searches: 3, pages: 5, bytes: 1024 * 1024,
  responseBytes: 256 * 1024, redirects: 3, timeoutMs: 15_000, textChars: 6000 });
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

export const nativeWebTransport: WebTransport = {
  resolve: host => lookup(host, { all: true, verbatim: true }),
  get: (url, pinned, signal) => new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET", agent: false, family: pinned.family, signal, maxHeaderSize: 16 * 1024,
      headers: { Accept: "text/html, text/plain;q=0.9", "Accept-Encoding": "identity", "User-Agent": "Scout/2.0 (public read-only research)" },
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
    req.on("error", reject);
    req.end();
  }),
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
  private readonly completedReads = new Set<string>();
  wasRead(url: string): boolean { return this.completedReads.has(url); }
  constructor(private readonly transport: WebTransport = nativeWebTransport) {}

  async read(raw: string): Promise<{ url: string; mime: string; text: string }> {
    if (this.downloadedBytes >= WEB_LIMITS.bytes) throw new Error("Web byte budget exhausted");
    let url = publicHttpsUrl(raw);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEB_LIMITS.timeoutMs);
    try {
      for (let hop = 0; hop <= WEB_LIMITS.redirects; hop++) {
        controller.signal.throwIfAborted();
        const host = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] :
          await abortable(this.transport.resolve(host), controller.signal);
        if (!addresses.length || addresses.some(a => !publicAddress(a.address) || isIP(a.address) !== a.family)) throw new Error("DNS resolved to a forbidden address");
        controller.signal.throwIfAborted();
        const response = await abortable(this.transport.get(url, addresses[0], controller.signal), controller.signal);
        try {
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (hop === WEB_LIMITS.redirects || !response.headers.location) throw new Error("Redirect limit or missing location");
            url = publicHttpsUrl(new URL(response.headers.location, url).href);
            continue;
          }
          if (response.status !== 200) throw new Error(`Web HTTP ${response.status}`);
          const mime = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
          if (mime !== "text/html" && mime !== "text/plain") throw new Error("Unsupported Web MIME type");
          const encoding = response.headers["content-encoding"];
          if (encoding && encoding !== "identity") throw new Error("Compressed Web response refused");
          if (/charset\s*=\s*["']?(?!utf-8\b|us-ascii\b)[\w-]+/i.test(response.headers["content-type"] ?? "")) throw new Error("Unsupported charset");
          const length = response.headers["content-length"];
          if (length && (!/^\d+$/.test(length) || Number(length) > WEB_LIMITS.responseBytes || Number(length) > WEB_LIMITS.bytes - this.downloadedBytes)) throw new Error("Web response too large");
          const chunks: Buffer[] = [];
          let size = 0;
          const iterator = response.body[Symbol.asyncIterator]();
          while (true) {
            const next = await abortable(iterator.next(), controller.signal);
            if (next.done) break;
            const chunk = Buffer.from(next.value);
            size += chunk.length;
            this.downloadedBytes += chunk.length;
            if (size > WEB_LIMITS.responseBytes || this.downloadedBytes > WEB_LIMITS.bytes) throw new Error("Web byte limit exceeded");
            chunks.push(chunk);
          }
          const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          this.completedReads.add(url.href);
          return { url: url.href, mime, text };
        } finally { response.close(); }
      }
      throw new Error("Redirect limit exceeded");
    } finally { clearTimeout(timer); }
  }
}
