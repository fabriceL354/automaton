/** Conservative, local-only checks: explicit instructions and obvious opposite-language prose. */
import { reportBody } from "./report-validation.js";

export type ReportLanguage = "fr" | "en";
const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

export function requestedReportLanguage(mission: string): ReportLanguage | undefined {
  const text = fold(mission);
  // Negated or conflicting instructions are ambiguous; do not guess.
  if (/\b(?:pas|not)\s+(?:en|in)\s+(?:francais|anglais|french|english)\b/.test(text)) return undefined;
  const french = /\b(?:en francais|in french)\b/.test(text);
  const english = /\b(?:en anglais|in english)\b/.test(text);
  return french === english ? undefined : french ? "fr" : "en";
}

export function reportLanguageReminder(language: ReportLanguage | undefined): string {
  if (!language) return "";
  return language === "fr"
    ? "Report language: français (French). Write original report prose in French, including after reading English sources."
    : "Report language: English (anglais). Write original report prose in English, including after reading French sources.";
}

const frenchWords = new Set("le la les des une est sont dans pour avec cette ce ces du aux nous vous mais plus sur donc que qui il elle ils elles ses leurs ont et un selon".split(" "));
const englishWords = new Set("the and is are this these that those with for from has have was were can will should its their they it which when also but because according".split(" "));

export function reportMatchesLanguage(content: string, language: ReportLanguage | undefined): boolean {
  if (!language) return true;
  // Sources, URLs, code and explicit quotations are not evidence about report prose.
  const prose = reportBody(content).replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ")
    .replace(/^\s*>.*$/gm, " ").replace(/https?:\/\/\S+/gi, " ").replace(/["“][^"”]*["”]/g, " ");
  const words = fold(prose).match(/[a-z]+/g) ?? [];
  const evidence = (dictionary: Set<string>) => {
    const hits = words.filter(word => dictionary.has(word));
    return { count: hits.length, distinct: new Set(hits).size };
  };
  const expected = evidence(language === "fr" ? frenchWords : englishWords);
  const opposite = evidence(language === "fr" ? englishWords : frenchWords);
  // Reject only strong, entirely opposite-language evidence. Short/technical/mixed text passes.
  return !(expected.count === 0 && opposite.count >= 6 && opposite.distinct >= 4);
}
