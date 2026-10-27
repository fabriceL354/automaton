// Limites extraites du contrat de recherche Scout V14.6.
// Source : src/agent/research-model.ts
// Indicateur uniquement : aucune autorisation d'exécution.

export const RESEARCH_BUDGET_CENTS = 1000;
export const RESEARCH_HORIZON_CENTS = 10000;

export function describeResearchBudget(
  costCents: number | null
): string {
  if (costCents === null) {
    return 'Coût inconnu : aucune conclusion budgétaire.';
  }

  if (!Number.isSafeInteger(costCents) || costCents < 0) {
    return 'Montant invalide : évaluation impossible.';
  }

  if (costCents > RESEARCH_HORIZON_CENTS) {
    return 'Hors du périmètre de recherche V14.6 (100 €).';
  }

  if (costCents > RESEARCH_BUDGET_CENTS) {
    return 'Dépasse le plafond de test V14.6 (10 €).';
  }

  return 'Dans le plafond de test de 10 €, '
    + 'mais non vérifiée et non autorisée.';
}
