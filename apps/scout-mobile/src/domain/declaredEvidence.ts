import {
  quotedCostMatches
} from '../../../../src/agent/research-evidence-policy';

/**
 * Controle des notes declarees par l'utilisateur.
 * Aucun acces a une page distante.
 * Ne constitue jamais une preuve verifiee.
 */
export function describeDeclaredEvidence(
  sources: string,
  costCents: number | null
): string {
  if (!sources.trim()) {
    return 'Aucune source declaree ; non verifie.';
  }

  if (costCents === null) {
    return 'Source declaree, cout inconnu ; non verifie.';
  }

  if (quotedCostMatches(sources, costCents)) {
    return 'Prix mentionne dans les notes ; '
      + 'page non consultee, non verifie.';
  }

  return 'Source declaree sans prix concordant ; '
    + 'non verifie.';
}
