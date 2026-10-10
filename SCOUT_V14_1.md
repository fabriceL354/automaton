# Scout V14.1 — Simulation déterministe et fictive

Base : V13 `34c7fbc566685a94d3982c98bf0dcbd744ac115c`, branche exclusive `local-ollama-only` du dépôt `fabriceL354/automaton`.

## Audit et changement minimal

V13 contient des simulations de sensibilité dans `operational-planning-model.ts`. Ce module dépend des modèles de dossiers et de projets, et son host enregistre des plans dans l'état HMAC V12.7. L'apprentissage V11 dérive ses preuves des historiques authentifiés. Ces mécanismes restent inchangés.

V14.1 ajoute uniquement `src/agent/fictional-simulation.ts`, son test et cette documentation. Le moteur n'a **aucun import**. Il accepte des hypothèses explicites et retourne une comparaison en mémoire, sans lire ni écrire de fichier. Aucun branchement dans `src/index.ts`, les outils du modèle, les registres, l'apprentissage ou les autorisations. Aucun appel réseau, Ollama, paiement, publication ou exécution de commande.

Les plafonds financiers réels V13 restent deux projets, 1 000 centimes par projet et 2 000 centimes d'exposition totale. Les limites arithmétiques ci-dessous ne constituent ni des budgets disponibles ni des permissions. Les HMAC, portées exactes, échéances, verrous, scellements et arrêts terminaux restent dans les modules existants.

## Contrat et calculs

API : `simulateFictionalScenarios(input: unknown)`, importable depuis `dist/agent/fictional-simulation.js` après compilation.

```js
import { simulateFictionalScenarios } from './dist/agent/fictional-simulation.js';

const report = simulateFictionalScenarios({
  version: '14.1', kind: 'FICTIONAL_SIMULATION', currency: 'EUR',
  scenarios: [
    { scenario_id: 'central', budget_cents: 1000, fixed_cost_cents: 601,
      unit_cost_cents: 100, unit_price_cents: 300, units: 4 },
    { scenario_id: 'pessimistic', budget_cents: 1000, fixed_cost_cents: 601,
      unit_cost_cents: 100, unit_price_cents: 300, units: 0 },
  ],
});
```

Tous les champs sont obligatoires. Entre un et trois scénarios distincts ; identifiants ASCII de 1 à 48 caractères (`[a-z][a-z0-9-]*`) ; volume entier de 0 à 10 000 ; chaque montant d'entrée de 0 à 1 000 000 000 centimes. Les montants de sortie ont la même borne, signée pour la marge et le résultat net. Les calculs intermédiaires utilisent `BigInt`.

Pas de coercition : valeurs manquantes/nulles, fractions, chaînes numériques, valeurs non finies, `-0`, champs supplémentaires, doublons, objets à prototype personnalisé, accesseurs, symboles et tableaux creux sont refusés. Une erreur invalide toute la comparaison. Un dépassement de coût, de revenu ou de somme est refusé, même si le résultat net pourrait rentrer dans la borne. Aucun montant n'est tronqué.

Pour chaque scénario :

- Coût variable fictif = coût unitaire × volume.
- Coût total fictif = coût fixe + coût variable.
- Revenu fictif = prix unitaire × volume.
- Résultat net fictif = revenu − coût total.
- Marge unitaire = prix − coût unitaire.
- Dépassement du budget fictif = coût total strictement supérieur au budget.
- Seuil de rentabilité pour une marge positive = plafond exact de coût fixe / marge. Le revenu au seuil utilise ce volume entier.

Le modèle suppose des coûts/prix unitaires constants, sans fiscalité ni financement. Il ne produit aucune prévision de marché ou probabilité de vente.

| Scénario | Coût total fictif | Revenu fictif | Résultat net fictif | Seuil |
| --- | ---: | ---: | ---: | --- |
| central | 1 001 c | 1 200 c | +199 c | 4 unités, 1 200 c |
| pessimistic | 601 c | 0 c | −601 c | 4 unités, 1 200 c |

Une marge nulle ou négative donne `NON_POSITIVE_MARGIN` et un seuil `null`, même si zéro vente et zéro coût fixe produisent ponctuellement un solde nul. Exception : marge nulle et coût fixe nul donnent `ALWAYS_BREAK_EVEN`, seuil zéro. Pour une marge positive sans coût fixe, le seuil est zéro (`FINITE`). Si le seuil dépasse les bornes de volume ou de montants, il reste `null` avec `OUTSIDE_LIMITS`, sans prétendre que la rentabilité a été atteinte.

Les lignes sont triées par identifiant ASCII. L'ordre initial des scénarios et des propriétés ne change pas le JSON résultant. Aucun identifiant aléatoire, timestamp ou état global ne participe au résultat. Les entrées sont copiées et ne sont pas modifiées ; modifier une sortie n'affecte ni l'entrée ni les appels ultérieurs.

## Frontière de preuve

Chaque rapport porte `fictional: true`, `real_evidence: false`, `authenticated_learning_eligible: false`, `action_authorized: false` et `execution_allowed: false`. Aucun transfert financier ni augmentation de fonds disponibles : montants zéro.

Le rapport n'est pas authentifié, ne constitue pas une observation réelle et ne doit pas être importé comme preuve commerciale, bancaire ou d'apprentissage. Les validateurs existants du registre financier, des définitions d'apprentissage et des plans V13 refusent son schéma. Aucune conversion/importation vers ces systèmes n'est ajoutée. Les mentions de sortie sont informatives ; elles ne remplacent aucun contrôle de sécurité existant.

## Validation ciblée

Utiliser Node et SQLite compatibles avec les dépendances installées ; environnement de livraison : Node 22.16.0, pnpm 10.28.1. Un seul worker, garde réseau existant, aucun délai augmenté. Les tests V13 démarrent des processus compilés : ils se lancent après le build.

```bash
export NODE_OPTIONS="--import=$PWD/scripts/scout-offline-test-guard.mjs"
pnpm exec vitest run src/__tests__/scout-fictional-simulation.test.ts \
  -t 'V14.1 (calculations|strict input|capability isolation)' --maxWorkers=1 --minWorkers=1
pnpm build
pnpm exec vitest run src/__tests__/scout-fictional-simulation.test.ts \
  src/__tests__/scout-operational-planning.test.ts \
  src/__tests__/scout-learning.test.ts \
  src/__tests__/scout-pilot-preparation.test.ts \
  src/__tests__/scout-pilot-readiness.test.ts --maxWorkers=1 --minWorkers=1
node scripts/scout-v13-validation.mjs
unset NODE_OPTIONS
```

Les tests vérifient les calculs et seuils, les bornes exactes, les dépassements, la validation stricte, la reproductibilité, l'absence d'alias et la frontière de capacités. Un contrôle de l'AST interdit les imports statiques/dynamiques et les capacités externes dans le moteur. Un test crée un workspace V13 authentifié temporaire, une décision et un arrêt terminal, puis vérifie que tous ses fichiers, y compris les ancres privées, restent identiques après simulation et que l'arrêt est conservé.

La suite complète n'est pas requise pour cette livraison et ne doit pas être lancée sur le Chromebook avant validation des tests ciblés. Les résultats de ce conteneur ne constituent pas une validation matérielle Chromebook.

### Résultats de livraison

- `pnpm build` : PASS, bibliothèque et CLI.
- V14.1 : **54/54 PASS**, aucun test ignoré lors de la relance finale ; 4,28 s pour ce fichier.
- Compatibilité existante : **267/267 PASS** (V13 : 57 ; apprentissage : 103 ; préparation V12.7 : 55 ; supervision V12.8 : 52).
- `node scripts/scout-v13-validation.mjs` : PASS ; propositions reproductibles, portées exactes, arrêt durable, aucune exécution économique.
- Aucun fichier existant V13 modifié ; seulement trois fichiers ajoutés. Suite complète non lancée.

La première sélection de tests a volontairement exclu les tests nécessitant le build. Le premier passage de compatibilité a ensuite révélé un mauvais nom de commande dans le nouveau test d'isolation (`supervise` au lieu de `prepare-handover`). Cette fixture a été corrigée ; tout le fichier V14.1 a été relancé avec succès. Aucun calcul, contrôle, délai ou assertion n'a été affaibli. Les 267 tests existants avaient tous réussi au premier passage.
