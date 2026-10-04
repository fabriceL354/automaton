/** Outbound capabilities are fixed public inputs, never generated from local files. */
import { reportBody } from "../agent/report-validation.js";
import { publicHttpsUrl, SafeWebClient, WEB_LIMITS } from "./network.js";
import { configuredSearchProvider, textFromHtml, type SearchProvider } from "./search.js";

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
  private results: { title: string; url: string; snippet: string }[] = [];
  private pageRead = false;
  private searches = 0;
  private pages = 0;
  private allowedUrls: Set<string>;
  private consulted = new Set<string>();
  constructor(readonly inputs: PublicWebInputs, private readonly client = new SafeWebClient(),
    private readonly provider: SearchProvider = configuredSearchProvider()) {
    this.allowedUrls = new Set(inputs.urls.map(url => publicHttpsUrl(url).href));
  }
  instructions(): string {
    return `Queries (web_search index): ${JSON.stringify(this.inputs.queries.map((query, index) => ({ index, query })))}\nPublic URLs (read_public_url index): ${JSON.stringify(this.inputs.urls.map((url, index) => ({ index, url })))}\n${this.nextStep()}`;
  }
  resultCount(): number { return this.results.length; }
  /** Return only the bounded, runtime-validated search results. */
  resultSnapshot(): Array<{ title: string; url: string; snippet: string }> {
    return this.results.map(result => ({ ...result }));
  }
  canWriteReport(): boolean { return (!this.inputs.queries.length && !this.inputs.urls.length) || this.pageRead; }
  nextStep(): string {
    if (this.canWriteReport()) return 'State: report allowed. Next action must be write_file with content only; runtime writes rapport.txt. Create an original answer to MISSION.txt based on the data read; do not copy the mission or announce completion.';
    if (this.results.length) return 'State: read a source first. Next action: {"tool":"read_search_result","index":0}';
    if (this.inputs.urls.length) return 'State: read a source first. Next action: {"tool":"read_public_url","index":0}';
    return 'State: search first. Next action: {"tool":"web_search","index":0}';
  }
  indexedValue(tool: "web_search" | "read_search_result" | "read_public_url", index: number): string {
    const values = tool === "web_search" ? this.inputs.queries : tool === "read_public_url" ? this.inputs.urls : this.results.map(result => result.url);
    if (!Number.isSafeInteger(index) || index < 0 || index >= values.length) throw new Error("Index out of bounds");
    return values[index]!;
  }
  async searchIndex(index: number): Promise<string> {
    return this.search(this.indexedValue("web_search", index));
  }
  async readIndex(tool: "read_search_result" | "read_public_url", index: number): Promise<string> {
    return this.readPage(this.indexedValue(tool, index));
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
      this.results.push(...safe);
      return JSON.stringify({ results: this.results.map((result, index) => ({ index, title: result.title, snippet: result.snippet.slice(0, 200) })) });
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
      this.pageRead = true;
      return JSON.stringify({ url: page.url, text: text.slice(0, WEB_LIMITS.textChars), truncated: text.length > WEB_LIMITS.textChars });
    } catch { return "ERROR: public page refused, unavailable, timed out, or over limit"; }
  }
  sources(): string[] { return [...this.consulted]; }
  report(content: string): string {
    // The runtime owns the Sources section; model-written citations are not trusted.
    const body = reportBody(content);
    const checked = body.replace(/https?:\/\/[^\s<>"'`\])]+/gi, url =>
      this.consulted.has(url) ? url : "[URL non consultée retirée]");
    if (!checked) return ""; // Never turn an empty answer into success via Sources alone.
    const sources = this.sources();
    return `${checked}\n\nSources\n${sources.length ? sources.map(url => `- ${url}`).join("\n") : "Aucune source Web consultée avec succès."}\n`;
  }
}
