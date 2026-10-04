import { describe, expect, it } from "vitest";
import { requestedReportLanguage, reportMatchesLanguage, reportLanguageReminder } from "../agent/report-language.js";

const french = "Les sources sont dans le rapport et elles sont utiles pour les lecteurs avec une synthèse claire.";
const english = "The sources are in the report and they are useful for readers with a clear summary of their findings.";
describe("Scout V2.1 local report language", () => {
  it.each([
    ["Réponds en français.", "fr"], ["EN FRANCAIS", "fr"], ["Write in French", "fr"],
    ["Rédige en anglais", "en"], ["Answer in English", "en"],
    ["Summarize the sources", undefined], ["Français et anglais", undefined],
    ["Answer in English et en français", undefined], ["Ne réponds pas en français", undefined],
  ])("detects only clear explicit instruction %s", (mission, language) => {
    expect(requestedReportLanguage(mission)).toBe(language);
  });
  it("rejects strongly opposite prose in both directions", () => {
    expect(reportMatchesLanguage(english, "fr")).toBe(false);
    expect(reportMatchesLanguage(french, "en")).toBe(false);
    expect(reportMatchesLanguage(french, "fr")).toBe(true);
    expect(reportMatchesLanguage(english, "en")).toBe(true);
    expect(reportMatchesLanguage(english, undefined)).toBe(true);
  });
  it.each(["2 + 2 = 4.", "Node.js 24 LTS", "The API works.", french + " Technical English title.", `Résumé utile.\n\nSources\n${english}`, `Résumé utile.\n> ${english}`, `Résumé utile.\n\`\`\`\n${english}\n\`\`\``, `Résumé utile. “${english}”`])("does not reject short/technical/French text with quotations or Sources %s", text => {
    expect(reportMatchesLanguage(text, "fr")).toBe(true);
  });
  it("provides reminders without example report content", () => {
    expect(reportLanguageReminder("fr")).toContain("français");
    expect(reportLanguageReminder("en")).toContain("English");
    expect(reportLanguageReminder(undefined)).toBe("");
  });
});

describe("dedicated drafting output contract", () => {
  it.each(["", "not JSON", '{"content":', "null", "[]", '"free text"', '{"content":42}', '{"content":null}', '{"content":{}}', '{"content":[]}', '{"tool":"write_file","content":"answer"}', '{"content":"answer","path":"MISSION.txt"}', '{"content":"answer","extra":true}', '```json\n{"content":"answer"}\n```'])("rejects non-content output %s", async raw => {
    const { parseScoutReport } = await import("../agent/local-runner.js");
    expect(() => parseScoutReport(raw)).toThrow();
  });
  it("accepts only a content string without interpreting it as an action", async () => {
    const { parseScoutReport } = await import("../agent/local-runner.js");
    expect(parseScoutReport('{"content":"Original report"}')).toBe("Original report");
  });
});
