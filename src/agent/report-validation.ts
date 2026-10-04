/** Content checks run before writing and again after confined rereading. */
export function reportBody(content: string): string {
  return content.replace(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*{1,2})?Sources(?:\*{1,2})?\s*:?[ \t]*(?:\n|$)[\s\S]*$/i, "").trim();
}

function normalized(content: string): string {
  return content.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function validReportContent(content: string, mission: string): boolean {
  const body = reportBody(content);
  const text = normalized(body);
  if (!text || text === normalized(mission)) return false;
  // Ignore presentation punctuation for known stand-alone placeholders/statuses.
  const plain = text.replace(/[\p{P}\p{S}]/gu, " ").replace(/\s+/g, " ").trim();
  const placeholders = [
    "actual complete answer to mission txt", "your actual answer to mission txt",
    "the answer to the mission", "rapport final", "final report", "your final report",
    "la réponse complète à la mission", "réponse à mission txt", "rapport prêt",
    "le rapport est prêt", "rapport terminé", "mission accomplie", "mission completed",
    "the report is ready", "report ready", "report completed", "done", "terminé",
    "content", "contenu", "placeholder", "todo", "à compléter",
  ];
  if (placeholders.includes(plain)) return false;
  if (/^(?:(?:le |mon |votre |the |your )?rapport|report) (?:est |is )?(?:prêt|ready|terminé|completed|créé|created|rédigé|written)(?: (?:dans|in) rapport txt)?$/.test(plain)) return false;
  return true;
}
