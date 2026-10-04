/** Outbound capabilities are fixed public inputs, never generated from local files. */
import { publicHttpsUrl, SafeWebClient, WEB_LIMITS } from "./network.js";
import { DuckDuckGoHtmlProvider, textFromHtml, type SearchProvider } from "./search.js";

export interface PublicWebInputs { queries: string[]; urls: string[]; }
export function publicWebInputs(env: Record<string, string | undefined> = process.env): PublicWebInputs {
  const array = (name: string, max: number): string[] => {
    if (env[name] === undefined) return [];
    const data: unknown = JSON.parse(env[name]!);
    if (!Array.isArray(data) || data.length > max || data.some(x => typeof x !== "string" || !x.trim() || x.length > 500 || /[\x00-\x1f\x7f]/.test(x))) throw new Error(`${name}: expected a bounded array of public strings`);
    return [...new Set(data)] as string[];
  };
  const queries = array("SCOUT_PUBLIC_QUERIES", WEB_LIMITS.searches);
  const urls = array("SCOUT_PUBLIC_URLS", WEB_LIMITS.pages).map(raw => publicHttpsUrl(raw).href);
  return { queries, urls };
}

export class WebResearchSession {
  private searches = 0;
  private pages = 0;
  private allowedUrls: Set<string>;
  private consulted = new Set<string>();
  constructor(readonly inputs: PublicWebInputs, private readonly client = new SafeWebClient(),
    private readonly provider: SearchProvider = new DuckDuckGoHtmlProvider()) {
    this.allowedUrls = new Set(inputs.urls.map(url => publicHttpsUrl(url).href));
  }
  instructions(): string {
    return `Approved queries: ${JSON.stringify(this.inputs.queries)}\nApproved URLs: ${JSON.stringify([...this.allowedUrls])}`;
  }
  isQueryAllowed(query: string): boolean { return this.inputs.queries.includes(query); }
  isUrlAllowed(raw: string): boolean {
    try { return this.allowedUrls.has(publicHttpsUrl(raw).href); } catch { return false; }
  }

  async search(query: string): Promise<string> {
    if (!this.isQueryAllowed(query)) return "ERROR: search query not explicitly approved as public by the operator";
    if (this.searches >= WEB_LIMITS.searches) return "ERROR: search limit reached";
    this.searches++;
    try {
      const { results, consultedUrl } = await this.provider.search(query, this.client);
      const source = publicHttpsUrl(consultedUrl).href;
      if (!this.client.wasRead(source)) throw new Error("Search provider returned an unverified source");
      const safe = results.slice(0, 5).map(result => ({ title: result.title.slice(0, 200),
        url: publicHttpsUrl(result.url).href, snippet: result.snippet.slice(0, 400) }));
      for (const result of safe) this.allowedUrls.add(result.url);
      this.consulted.add(source);
      return JSON.stringify({ results: safe });
    } catch { return "ERROR: public search unavailable, unsafe, or over limit; no paid/remote fallback. Try an operator-provided URL or explain the limitation."; }
  }
  async readPage(raw: string): Promise<string> {
    try {
      const url = publicHttpsUrl(raw).href;
      if (!this.allowedUrls.has(url)) return "ERROR: URL not provided by the operator or returned by web_search";
      if (this.pages >= WEB_LIMITS.pages) return "ERROR: page limit reached";
      this.pages++;
      const page = await this.client.read(url);
      const text = (page.mime === "text/html" ? textFromHtml(page.text) : page.text.trim());
      if (!text || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return "ERROR: page contains no useful public text";
      this.consulted.add(page.url);
      return JSON.stringify({ url: page.url, text: text.slice(0, WEB_LIMITS.textChars), truncated: text.length > WEB_LIMITS.textChars });
    } catch { return "ERROR: public page refused, unavailable, timed out, or over limit"; }
  }
  sources(): string[] { return [...this.consulted]; }
  report(content: string): string {
    // The runtime owns the Sources section; model-written citations are not trusted.
    const body = content.replace(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*{1,2})?Sources(?:\*{1,2})?\s*:?[ \t]*(?:\n|$)[\s\S]*$/i, "").trim();
    const checked = body.replace(/https?:\/\/[^\s<>"'`\])]+/gi, url =>
      this.consulted.has(url) ? url : "[URL non consultée retirée]");
    if (!checked) return ""; // Never turn an empty answer into success via Sources alone.
    const sources = this.sources();
    return `${checked}\n\nSources\n${sources.length ? sources.map(url => `- ${url}`).join("\n") : "Aucune source Web consultée avec succès."}\n`;
  }
}
