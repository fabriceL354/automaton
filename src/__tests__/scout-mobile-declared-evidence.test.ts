import { describe, expect, it } from 'vitest';
import {
  describeDeclaredEvidence
} from '../../apps/scout-mobile/src/domain/declaredEvidence';

describe('Scout Android - sources declarees', () => {
  it('refuse de valider une source absente', () => {
    expect(describeDeclaredEvidence('', 850))
      .toContain('Aucune source');
  });

  it('refuse de valider un cout inconnu', () => {
    expect(describeDeclaredEvidence('Note manuelle', null))
      .toContain('cout inconnu');
  });

  it('detecte un prix mentionne dans les notes', () => {
    const result = describeDeclaredEvidence(
      'Une page indique un tarif de 8,50 EUR.',
      850
    );
    expect(result).toContain('Prix mentionne');
    expect(result).toContain('non verifie');
  });

  it('detecte un montant non concordant', () => {
    expect(describeDeclaredEvidence(
      'Le tarif indique est de 9,50 EUR.',
      850
    )).toContain('sans prix concordant');
  });

  it('ne valide pas les notes de demonstration', () => {
    expect(describeDeclaredEvidence(
      'Donnees de demonstration',
      850
    )).toContain('non verifie');
  });
});
