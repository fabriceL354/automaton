import { parseMobileResearchImport, type ImportedPreview } from './mobileResearchImport';
import { parseResearchResultFile } from './researchResultFile';

export type ResearchImportReview = { preview: ImportedPreview | null; error: string };
export const IMPORT_REFUSED = 'Résultat refusé : format, provenance ou informations de sécurité ' +
  'non représentables. Le dernier aperçu conservé reste inchangé.';

/** Same transition for both UI entry points. Refusal never clears a valid previous preview. */
export function reviewResearchImport(previous: ImportedPreview | null, raw: string,
  format: 'PREVIEW' | 'RESEARCH_FILE'): ResearchImportReview {
  try {
    const preview = format === 'PREVIEW' ? parseMobileResearchImport(raw) : parseResearchResultFile(raw);
    return { preview, error: '' };
  } catch {
    return { preview: previous, error: IMPORT_REFUSED };
  }
}
