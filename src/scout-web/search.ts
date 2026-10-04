import { publicHttpsUrl, SafeWebClient } from "./network.js";

export interface SearchResult { title: string; url: string; snippet: string; }
export interface SearchProvider {
  search(query: string, client: SafeWebClient): Promise<{ results: SearchResult[]; consultedUrl: string }>;
}

export function textFromHtml(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_all, code: string) => {
      const n = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : " ";
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_all, name: string) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[name.toLowerCase()] ?? " "))
    .replace(/\s+/g, " ").trim();
}

/** Best-effort public HTML GET. Never submit forms or bypass CAPTCHA. */
export class DuckDuckGoHtmlProvider implements SearchProvider {
  async search(query: string, client: SafeWebClient) {
    const endpoint = new URL("https://html.duckduckgo.com/html/");
    endpoint.searchParams.set("q", query);
    const page = await client.read(endpoint.href);
    if (page.mime !== "text/html" || /anomaly\.js|challenge-form|captcha/i.test(page.text)) throw new Error("Public search blocked by provider; no bypass or paid fallback");
    const results: SearchResult[] = [];
    const matches = [...page.text.matchAll(/<a\b([^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)];
    for (let i = 0; i < matches.length && results.length < 5; i++) {
      const href = matches[i][1].match(/\bhref=["']([^"']+)["']/i)?.[1];
      if (!href) continue;
      try {
        const wrapper = new URL(href.replace(/&amp;/gi, "&"), endpoint);
        const raw = wrapper.hostname === "duckduckgo.com" || wrapper.hostname === "html.duckduckgo.com" ? wrapper.searchParams.get("uddg") ?? wrapper.href : wrapper.href;
        const url = publicHttpsUrl(raw).href;
        const end = i + 1 < matches.length ? matches[i + 1].index! : page.text.length;
        const snippet = page.text.slice(matches[i].index! + matches[i][0].length, end)
          .match(/<(?:a|div|span)\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i)?.[1] ?? "";
        results.push({ title: textFromHtml(matches[i][2]).slice(0, 200), url, snippet: textFromHtml(snippet).slice(0, 400) });
      } catch { /* Unsafe results are never offered as capabilities. */ }
    }
    if (!results.length) throw new Error("Public search returned no usable results or an unsupported page; use operator-provided URLs");
    return { results, consultedUrl: page.url };
  }
}

/** Anonymous Lite GET only. A blocked provider is never bypassed or replaced. */
export class DuckDuckGoLiteProvider implements SearchProvider {
  async search(query: string, client: SafeWebClient) {
    const endpoint = new URL("https://lite.duckduckgo.com/lite/");
    endpoint.searchParams.set("q", query);
    const page = await client.read(endpoint.href);
    const finalUrl = new URL(page.url);
    if (page.mime !== "text/html" || finalUrl.origin !== endpoint.origin || finalUrl.pathname !== endpoint.pathname ||
        /captcha|challenge|anomaly\.js|verify\s+(?:that\s+)?you\s+are\s+human/i.test(page.text)) {
      throw new Error("Public Lite search blocked or unexpected; no bypass");
    }
    const results: SearchResult[] = [];
    const links = [...page.text.matchAll(/<a\b([^>]*\sclass\s*=\s*["'][^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)]
      .filter(match => match[1].match(/\sclass\s*=\s*["']([^"']*)["']/i)?.[1].split(/\s+/).includes("result-link"));
    for (let i = 0; i < links.length && results.length < 5; i++) {
      const href = links[i][1].match(/\shref\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!href) continue;
      try {
        const target = new URL(textFromHtml(href), endpoint);
        const duckHost = ["duckduckgo.com", "www.duckduckgo.com", "lite.duckduckgo.com", "html.duckduckgo.com"].includes(target.hostname);
        const wrapped = duckHost ? target.searchParams.get("uddg") : null;
        // Never turn a provider navigation/challenge link into a source capability.
        if (duckHost && !wrapped) continue;
        const url = publicHttpsUrl(wrapped ?? target.href).href;
        const title = textFromHtml(links[i][2]).slice(0, 200);
        if (!title || results.some(result => result.url === url)) continue;
        const end = i + 1 < links.length ? links[i + 1].index! : page.text.length;
        const section = page.text.slice(links[i].index! + links[i][0].length, end);
        const snippet = section.match(/<(?:td|div|span)\b[^>]*\sclass\s*=\s*["'][^"']*\bresult-snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:td|div|span)>/i)?.[1] ?? "";
        results.push({ title, url, snippet: textFromHtml(snippet).slice(0, 400) });
      } catch { /* Every extracted URL must pass the public HTTPS guard. */ }
    }
    if (!results.length) throw new Error("Public Lite search returned no usable results or an unsupported page");
    return { results, consultedUrl: page.url };
  }
}

/** Explicitly selected public instance; never discover/rotate instances or bypass a block. */
export class SearxngProvider implements SearchProvider {
  private readonly origin: string;
  constructor(baseUrl: string) {
    const url = publicHttpsUrl(baseUrl);
    if (url.pathname !== "/" || url.search || url.hash || baseUrl.includes("#")) throw new Error("SearXNG requires a public HTTPS origin without path/query/fragment");
    this.origin = url.origin;
  }
  async search(query: string, client: SafeWebClient) {
    const endpoint = new URL("/search", this.origin);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    const page = await client.readSearchJson(endpoint.href);
    if (new URL(page.url).origin !== this.origin) throw new Error("Search redirected away from selected instance");
    const data: unknown = JSON.parse(page.text);
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        "error" in data || !Array.isArray((data as Record<string, unknown>).results)) throw new Error("Invalid SearXNG response");
    const results: SearchResult[] = [];
    for (const item of (data as { results: unknown[] }).results) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid search result");
      const row = item as Record<string, unknown>;
      if (typeof row.title !== "string" || typeof row.url !== "string" ||
          (row.content !== undefined && typeof row.content !== "string")) throw new Error("Invalid search result fields");
      try {
        const url = publicHttpsUrl(row.url).href;
        const title = textFromHtml(row.title).slice(0, 200);
        if (!title || results.some(result => result.url === url)) continue;
        results.push({ title, url, snippet: textFromHtml(row.content as string ?? "").slice(0, 400) });
      } catch { /* Unsafe URLs cannot become read capabilities. */ }
      if (results.length === 5) break;
    }
    if (!results.length) throw new Error("No usable public results");
    return { results, consultedUrl: page.url };
  }
}

export class UnavailableSearchProvider implements SearchProvider {
  async search(_query: string, _client: SafeWebClient): Promise<{ results: SearchResult[]; consultedUrl: string }> {
    throw new Error("No public search provider selected; use approved public URLs");
  }
}

/** Operator-only registry; selecting a provider does not introduce automatic failover. */
export function configuredSearchProvider(env: Record<string, string | undefined> = process.env): SearchProvider {
  switch (env.SCOUT_SEARCH_PROVIDER ?? "none") {
    case "none": return new UnavailableSearchProvider();
    case "duckduckgo-lite": return new DuckDuckGoLiteProvider();
    case "duckduckgo-html": return new DuckDuckGoHtmlProvider();
    case "searxng":
      if (!env.SCOUT_SEARXNG_URL) throw new Error("SCOUT_SEARXNG_URL is required for searxng");
      return new SearxngProvider(env.SCOUT_SEARXNG_URL);
    default: throw new Error("SCOUT_SEARCH_PROVIDER must be none, searxng, duckduckgo-lite or duckduckgo-html");
  }
}
