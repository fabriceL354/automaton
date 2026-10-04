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
