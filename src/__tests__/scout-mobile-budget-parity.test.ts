import { describe, expect, it } from 'vitest';

import {
  RESEARCH_LIMITS
} from '../agent/research-model.js';

import {
  RESEARCH_BUDGET_CENTS,
  RESEARCH_HORIZON_CENTS,
  describeResearchBudget
} from '../../apps/scout-mobile/src/domain/researchBudget';

describe('Scout Android — parité budgétaire V14.6', () => {
  it('utilise les plafonds du moteur Scout', () => {
    expect(RESEARCH_BUDGET_CENTS)
      .toBe(RESEARCH_LIMITS.executionBudgetCents);

    expect(RESEARCH_HORIZON_CENTS)
      .toBe(RESEARCH_LIMITS.researchHorizonCents);
  });

  it('ne valide pas les coûts inconnus', () => {
    expect(describeResearchBudget(null))
      .toContain('Coût inconnu');
  });

  it('respecte exactement le plafond de 10 euros', () => {
    expect(describeResearchBudget(1000))
      .toContain('Dans le plafond');

    expect(describeResearchBudget(1001))
      .toContain('Dépasse');
  });

  it('respecte le périmètre de recherche de 100 euros', () => {
    expect(describeResearchBudget(10000))
      .toContain('Dépasse');

    expect(describeResearchBudget(10001))
      .toContain('Hors du périmètre');
  });

  it('rejette les montants invalides', () => {
    expect(describeResearchBudget(-1))
      .toContain('Montant invalide');

    expect(describeResearchBudget(1.5))
      .toContain('Montant invalide');
  });

  it('ne transforme jamais un budget en autorisation', () => {
    expect(describeResearchBudget(850))
      .toContain('non vérifiée et non autorisée');
  });
});
