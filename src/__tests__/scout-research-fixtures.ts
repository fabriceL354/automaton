import { vi } from "vitest";
import { gzipSync } from "node:zlib";
import { SafeWebClient, type HttpReply, type WebTransport } from "../scout-web/network.js";
import { BraveSearchProvider } from "../scout-web/search.js";
import type { ResearchModel } from "../agent/research-controller.js";
export const FIXTURE_KEY = "fixture-Brave-runtime-key-123456789";
export const QUICK_QUOTE = "Un test de correction peut être gratuit sans investissement.";
export const ASSET_QUOTE = "Le coût de création du template est estimé à 25 EUR.";
export const QUICK_TEXT = `En France, la correction de textes courts peut constituer un micro-service freelance pour un opérateur seul. ${QUICK_QUOTE} Les premiers clients peuvent être interrogés directement. La demande réelle et les frais de plateforme restent à vérifier. Un compte peut être nécessaire selon la distribution choisie.`;
export const ASSET_TEXT = `Une page titrée business sous 1000 EUR peut contenir une idée concrète plus petite : un template de tableur numérique. ${ASSET_QUOTE} Un mini-test gratuit auprès de trois personnes peut précéder la réalisation. Cet actif numérique durable demande une distribution et une validation des frais. Les ventes ne sont pas garanties.`;
export function reply(body: string | Buffer = QUICK_TEXT, headers: Record<string, string | undefined> = { "content-type": "text/plain; charset=utf-8" }, status = 200): HttpReply {
  return { status, headers, body: (async function* () { yield Buffer.isBuffer(body) ? body : Buffer.from(body); })(), close: vi.fn() };
}
export function transport(...responses: HttpReply[]): WebTransport & { resolve: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; getBrave: ReturnType<typeof vi.fn> } {
  const next = vi.fn(async () => { if (!responses.length) throw new Error("Fixture exhausted"); return responses.shift()!; });
  return { resolve: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]), get: vi.fn(() => next()), getBrave: vi.fn(() => next()) };
}
export function braveJson(n = 2) {
  return JSON.stringify({ web: { results: Array.from({ length: n }, (_, i) => ({ title: "Public idea " + i, url: `https://example.com/${i}`, description: "Public evidence" })) } });
}
export function fixtureNetwork() {
  const network: WebTransport = {
    resolve: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
    getBrave: vi.fn(async () => reply(braveJson(), { "content-type": "application/json" })),
    get: vi.fn(async url => reply(gzipSync(Buffer.from(`<p>${url.pathname === "/0" ? QUICK_TEXT : ASSET_TEXT}</p>`)), { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" })),
  };
  return { network, client: new SafeWebClient(network, { bytes: 4 * 1024 * 1024, responseBytes: 256 * 1024 }), provider: new BraveSearchProvider(FIXTURE_KEY) };
}
export const TOOL = { capability_needed: "pdf_processing", suggested_tool: "Outil PDF à évaluer", purpose: "Préparer un guide public", project_relevance: "Présentation du service",
  required: true, account_required: true, credential_required: true, estimated_cost_cents: 1800, paid_tool: true,
  data_sent: ["public project description"], risk_level: "medium", expected_benefit: "Comparer les possibilités de présentation" };
export function phaseResponse(phase: string, data: string): string {
  if (phase === "query_proposal") {
    const round = Number(data.match(/Round (\d)/)?.[1]);
    return JSON.stringify({ intents: ["micro_service", "digital_template"].map(family => ({ family,
      focus: round === 1 ? "explore" : round === 2 ? "market" : "cost", evidence_index: round === 1 ? null : 0 })) });
  }
  if (phase === "candidates") return JSON.stringify({ candidates: [
    { name: "Correction de textes", kind: "QUICK_SERVICE", source_index: 0 },
    { name: "Template tableur", kind: "DURABLE_ASSET", source_index: 1 },
  ] });
  const asset = data.includes('"name":"Template tableur"');
  if (phase === "economics") return JSON.stringify({ summary: asset ? "Créer un template numérique après validation" : "Tester une prestation de correction", estimated_cost_cents: asset ? 2500 : 0, cost_basis: "SOURCE_ESTIMATE", human_minutes_daily: asset ? 5 : 12, account_required: true });
  if (phase === "evidence") return JSON.stringify({ market: "Demande locale à vérifier", platform: "Distribution directe ou plateforme à vérifier", fees: "Frais non confirmés", quote: asset ? ASSET_QUOTE : QUICK_QUOTE });
  if (phase === "risks") return JSON.stringify({ risks: ["Demande non confirmée"], reason_surfaced: "Un actif réutilisable pourrait limiter le temps de supervision après un premier test gratuit.", mini_test_possible: true, mini_test_cost_cents: 0, mini_test_description: "Interroger trois personnes sans achat" });
  if (phase === "tool_selection") return JSON.stringify({ capabilities: ["pdf_processing"] });
  if (phase === "tool_request") return JSON.stringify(TOOL);
  throw new Error("Unknown fixture phase");
}
export function fixtureModel(): ResearchModel & { ask: ReturnType<typeof vi.fn> } {
  return { ask: vi.fn(async (phase: string, data: string) => phaseResponse(phase, data)) };
}
