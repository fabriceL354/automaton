# Scout V12 — Capital Allocator

Base obligatoire : `fb1f88455f148459ac726a3f1d6e9a853ff35d7b`, sur
`local-ollama-only`. Les correctifs V11.1.1–V11.1.3 sont conservés.

V12 calcule une **proposition locale**. Il ne crée ni projet, ni réservation,
ni approval, ni capability et n'appelle aucun modèle, réseau, paiement ou
outil externe. `NO REAL MONEY WAS SPENT BY V12` et `PROPOSAL_ONLY` figurent dans
chaque proposition. Le JSON n'est jamais une preuve de transaction.

## Utilisation

Après `pnpm build`, avec un ledger V5 déjà initialisé explicitement et une
recherche V11.1 existante dans `~/.automaton/scout-workspace` :

```bash
SCOUT_MODE=allocation node dist/index.js --run
SCOUT_MODE=allocation node dist/index.js --inspect-allocation
```

`--calculate-allocation` est un alias explicite de `--run`. La source par
défaut est `research.json`. Pour utiliser le fichier V3 existant :

```bash
SCOUT_MODE=allocation node dist/index.js --run --source opportunity
```

`--source research` sélectionne explicitement V11.1. Aucun fallback entre
sources, aucune commande de paiement, aucun argument de chemin libre.

La CLI affiche la proposition, son indicateur `stale` et les
`new_attention_items`. Le fichier durable `capital-allocation.json` contient
la proposition courante et ses attention items pertinents. L'affichage de
ces derniers n'est pas un push : un futur consommateur doit utiliser
`new_attention_items` pour éviter de répéter les événements déjà signalés.
L'inspection authentifie les sources, ne remplace pas la proposition et
signale les changements d'état ou l'expiration d'un projet. Recalculer une
proposition périmée ne donne aucun droit d'exécution.

## Données et séparation financière

V12 utilise `readLearningSources` : replay V5 et historiques authentifiés
V6/V7/V9/V10, puis replay V11 et contrôle des projections. Il réutilise les
IDs exacts des projets, expériences, assets, requests et preuves. Une
opportunité est liée à un projet uniquement si son titre normalisé est
exactement celui du plan ; aucune association floue n'est inventée. Un nouveau
candidat garde `project_id`, `experiment_id` et `asset_id` à `null` jusqu'à
une création humaine explicite par V9. V3 n'avait pas d'ID d'opportunité :
V12 lui attribue un ID dérivé de son contenu, distinct de tout ID V9.

| Champ | Sens |
| --- | --- |
| `confirmed_available_cents` | Disponible V5 après réservations et dépenses confirmées |
| `confirmed_reserved_cents` | Réservations comptables existantes, tous modes confondus |
| `planned_unreserved_cents` | Budgets V9 planifiés mais pas encore réservés |
| `approved_allocation_cents` | Budgets V9 des projets approuvés ou actifs, pas une dépense |
| `total_confirmed_spent_cents` | Dépenses historiques effectivement confirmées par V7/V9 |
| `total_confirmed_revenue_cents` | Revenus confirmés, jamais des claims ou prévisions |
| `total_proposed_cents` | Budget indicatif de cette proposition uniquement |
| `actually_spent_by_v12_cents` | Toujours zéro |

La confirmation est celle de l'opérateur local ; aucune vérification bancaire
n'est prétendue. La genèse V5 est un capital déclaré explicitement par
l'opérateur, validé par replay. V5 n'avait pas de signature HMAC indépendante
sur sa genèse. Le premier calcul V12 ancre ce snapshot ; les calculs suivants
refusent son remplacement ou rollback. Les dépenses et revenus doivent avoir
un propriétaire authentifié V7/V9 ; un simple event générique non ancré est
refusé. Une `sale_claim` ou `expense_claim`, même réconciliée, ne s'ajoute pas
aux transactions. Une clé manquante n'est jamais recréée silencieusement.

Les requests standalone V6 sont rapportées séparément dans
`existing_approval_requests`, avec montant maximal et décision historique.
Elles ne s'ajoutent pas à l'allocation approuvée V9 et ne donnent aucun droit V12.

## Algorithme déterministe et incertitude

1. Revalider au maximum trois opportunités. V11.1 est reconstruit via
   `parseOpportunityPhases`, avec citation exacte d'une page réellement présente
   et recalcul du score existant. V3 est revalidé via `parseOpportunitiesFile`.
   Aucun second scoring ou bonus appris arbitraire n'est introduit.
2. Trier par score existant décroissant, puis ID canonique lexical. Les scores
   V3 et V11.1 ne sont pas mélangés dans une même entrée ou comparaison.
3. Écarter coûts inconnus, coûts au-delà de 1000 cents, projets déjà engagés ou
   clos et coûts qui dépassent le plan existant. Aucune version moins chère
   d'une opportunité hors budget n'est inventée à partir de son mini-test.
4. Couvrir les budgets planifiés existants avant de proposer de nouveaux
   projets. Pour un plan existant éligible, proposer son budget inchangé ;
   pour une nouvelle opportunité, proposer son coût estimé entier. Pas de
   réduction partielle qui prétendrait financer une opportunité irréalisable.
5. Respecter simultanément cash disponible, réservations et dépenses confirmées,
   deux slots V9, 1000 cents par projet et 2000 cents cumulés. Un revenu même
   confirmé peut augmenter le cash, jamais les plafonds ni réapprovisionner
   l'exposition déjà dépensée. L'argent inutilisé ne relève pas un budget.
6. Éviter une exposition identique si URL source, marché et plateforme normalisés
   sont identiques. La règle vaut également pour un candidat correspondant
   exactement à un projet engagé. V3 ne fournit pas ces données : sa
   diversification reste explicitement inconnue. Aucune corrélation économique
   plus large n'est inférée à partir de prose ou d'un LLM.

V9 ne permet actuellement que deux projets dans son batch initial, **y compris
les projets clos ou annulés**. V12 respecte cette restriction supplémentaire,
sans créer de batch ni recycler les slots. Les plafonds restent ceux de
`PROJECT_LIMITS`, sans env permettant de les augmenter.

Les résultats descriptifs V11 sont référencés dans `learning_evidence`, avec
IDs, hash et recommandations. Une opportunité non liée à un projet n'a aucune
preuve de similarité authentifiée : V12 ne transfère pas à cette opportunité
la rentabilité d'un autre projet. Coût estimé, revenus futurs, durée réelle et
absence d'historique restent des incertitudes visibles. Le délai V3 jusqu'au
premier revenu n'est pas une durée d'expérience. La proposition fixe seulement
une durée maximale de sept jours ; la durée exacte reste une décision V9.
Un projet actif expiré interdit toute nouvelle proposition jusqu'à une décision
humaine et produit une intervention requise.

## Politique hors budget et attention

Une opportunité hors budget est rapportée dans le JSON mais jamais sélectionnée.
Au maximum **une** reçoit un nouvel item `OUT_OF_BUDGET_OPPORTUNITY` par calcul :
coût `SOURCE_ESTIMATE` avec preuve validée, score V11.1 d'au moins 50 et avantage
au moins égal à 15 points sur le meilleur candidat éligible sous plafond de
la même échelle. Sans candidat comparable, le seuil absolu s'applique et cette
absence est explicitement indiquée. V3 n'a pas de citation de coût vérifiable
dans son fichier ; ses coûts restent `ASSUMPTION` et ne déclenchent pas cet item.
Le seuil V3 de 75 est défini pour rendre cette politique explicite, mais un
fichier V3 actuel ne satisfait pas le critère de coût sourcé.

L'item fournit ID, titre, coût, plafond, dépassement, score, baseline, risques,
preuves, motif déterministe et décision humaine requise. Il reste non bloquant.
Un changement de supervision ou de citation sans changement du titre normalisé,
du coût et de l'exposition ne redéclenche pas la notification. Les indices de
recherche propres à chaque run ne déterminent pas l'identité de l'événement.

`APPROVAL_REQUIRED` ne concerne qu'une request V9 réellement existante et encore
pending. V12 n'en crée jamais. `HUMAN_INTERVENTION_REQUIRED` signale une deadline
atteinte ou des engagements planifiés non couverts. Les opportunités ordinaires
et les informations déjà dans le rapport ne créent pas de bruit `INFO`.
Aucun item, quelle que soit sa catégorie, ne confère un droit.

## Intégrité, concurrence et limites

Le verrou exclusif `.economic-ledger.lock` est partagé avec V5–V11. Il couvre
lecture, calcul, contrôles et commit V12. Une seule proposition courante existe :
les recalculs **remplacent**, ils n'additionnent pas une liste d'allocations.
Un second processus concurrent échoue proprement sur le verrou. Deux runs
séquentiels du même état relisent le même snapshot et ne répètent aucun item.
Les anciennes copies ne sont pas exécutables, et ne constituent pas des réservations.

Le store privé `.scout-allocation-<workspace-hash>` reprend le schéma HMAC
SHA-256 et le protocole prepared/complete des stores V9/V11 : clé 0600, répertoire
0700, fichiers confinés, refus des liens, écritures fsync + rename atomique,
relecture et sources revérifiées avant/après écriture. Pas de modification des
stores économiques, approvals ou projets. Le writer accessible au modèle refuse
les fichiers `capital-allocation.*`, y compris dans des sous-dossiers.

Les prefixes financiers, V11 et V6 sont ancrés : V6 peut terminer sa dernière
request pending ; le corps immuable des requests et les décisions terminales
sont contrôlés séparément. Rollback, corruption, projection orpheline ou commit
interrompu bloquent le mode ; aucune réparation automatique ni suppression de
verrou stale. Ce modèle protège des écritures par les outils de Scout ; il ne
prétend pas résister à un administrateur qui possède toutes les clés locales.

Limites V12 : trois candidats, entrée/sortie 128 KiB, store 512 KiB,
128 IDs d'attention conservés sans éviction silencieuse. La saturation demande
une inspection humaine avant toute nouvelle notification. Tous les montants
sont en cents entiers sûrs ; les euros V3 ne sont convertis que s'ils ont au
maximum deux décimales, sans arrondi.

## Vérification reproductible

```bash
pnpm build
pnpm vitest run src/__tests__/scout-allocation.test.ts
pnpm vitest run src/__tests__/scout-research-autonomy.test.ts
node scripts/scout-v12-validation.mjs
pnpm vitest run
```

Le script utilise uniquement un workspace temporaire synthétique ; il ne touche
pas au capital ou aux projets réels de l'opérateur. La validation sur le vrai
Chromebook reste à effectuer après intégration de V12.

## Validation effectuée ici

- Build TypeScript racine et package CLI : PASS.
- Scénario synthétique `scripts/scout-v12-validation.mjs` : PASS.
- Tests V12 : 89/89 PASS, dont concurrence de deux processus CLI réels.
- Suite complète sous Node 22.16.0, avec réseau externe réel bloqué :
  78/78 fichiers et 2978/2978 tests PASS, environ 82 secondes.
- Aucun changement dans V6/V8/V9, ni dans le correctif de comptage V11.1.3.

L'essai non isolé sous Node 24 a rencontré un problème natif SQLite à la
fermeture. L'exécution de la suite avec réseau réel a aussi été rejetée par
le contrôle automatique parce qu'un test historique tentait une sortie vers
un domaine externe non autorisé. Aucun accès à ce domaine n'est nécessaire
à V12. La validation complète ci-dessus utilise un garde **de test uniquement**,
qui bloque les requêtes externes effectives tout en laissant fonctionner les
mocks et les serveurs loopback. Pour reproduire ce contrôle depuis la racine :

```bash
NODE_OPTIONS="--import=$PWD/scripts/scout-offline-test-guard.mjs" pnpm vitest run --maxWorkers=2 --minWorkers=2
```

Le garde n'est pas importé par Scout et ne modifie aucune politique de son
runtime. Les tests historiques qui se contentent d'exercer une erreur réseau
ne valident pas un service externe réel dans ce mode.
