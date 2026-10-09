# Scout V12.7 — Préparation du pilote réel supervisé

V12.7 prépare des dossiers et des demandes d'autorisation. **Elle ne lance aucun pilote, ne paie rien et ne publie rien**, même après une approbation. Le mode est déterministe et local : aucun appel à Ollama, réseau public, banque, shell modèle ou service cloud.

## Limites imposées par le runtime

| Paramètre | Limite |
|---|---|
| Capital de référence opérateur | 10000 centimes, jamais une preuve de solde bancaire |
| Projets | 2 maximum, batch conservateur incluant les anciens projets V9 fermés |
| Budget par projet | 1000 centimes |
| Exposition totale | 2000 centimes, engagements V5/V9 existants inclus |
| Durée prévue | 1 à 7 jours |
| Validité des demandes | Expiration explicite dans les 7 jours de la préparation |
| Actions automatiques | Aucune : paiement, publication, compte, achats de crédits ou abonnements interdits |

Les montants V12.7 sont exclusivement des entiers en centimes. Le capital de référence ne crée aucune entrée V5. Le runtime utilise la disponibilité comptable existante, plafonnée à 10000 centimes, sans prétendre connaître un compte bancaire.

## Dossiers et sélection

Le fichier local `pilot-preparation-input.json` doit contenir `version: "12.7"`, `source: "research.json"` ou `"opportunities.json"`, et 1 à 3 `dossiers`. Le script d'exemple fournit le schéma intégral.

Chaque dossier lie un identifiant d'opportunité et son `candidate_fingerprint` V12. Il contient description, cible, offre, budget, durée, estimation de revenu, incertitudes, risques, critères de succès/arrêt et actions humaines exactes. Le classement V12 est réutilisé. Deux dossiers admissibles au maximum sont retenus ; les autres restent bloqués avec un événement. Leurs identifiants de projet sont stables, dérivés de l'origine et du nom normalisé ; aucune liaison implicite à un ancien projet n'est créée.

Les preuves sont des archives publiques expurgées, locales, UTF-8, de 32 KiB maximum, sous `evidence/<nom>.txt`, avec SHA-256 exact, identifiant, finalité `cost` ou `market` et URL HTTPS publique facultative, sans paramètres ni identifiants. Le runtime n'accède pas aux URL. Une preuve absente bloque la validation ; une preuve modifiée bloque toute opération. Les archives et empreintes ne prouvent ni une vente ni un paiement.

Les sources V3 restent des hypothèses insuffisamment documentées pour le lancement. Les sources V11.1 sont informatives. Un dossier, une archive, un score ou une estimation ne constituent jamais une validation commerciale automatique. Un dossier fictif ne peut pas recevoir de validation commerciale.

## Séparation des trois validations

1. **Préparation technique** : schéma, sources, plafonds, réservations de préparation et intégrité vérifiés hors ligne.
2. **Validation commerciale humaine documentée** : examen explicite du dossier exact, archive de devis et archive de marché présentes. Le prix du devis reste distinct d'une dépense.
3. **Autorisation humaine** : décision explicite pour chaque demande, avec identifiants projet/action/demande et empreinte exacte. Une autorisation ne lance aucune opération.

Le dossier devient `READY_FOR_MANUAL_LAUNCH` uniquement si les preuves sont présentes, le dossier est réel, la revue commerciale est documentée, toutes les actions sont approuvées et les demandes sont encore valides. Les paiements proposés doivent identifier fournisseur et bénéficiaire et référencer une preuve de coût. Ce statut signale une possibilité à examiner par l'opérateur ; Scout n'effectue pas le lancement.

## Commandes opérateur

```bash
SCOUT_MODE=pilot-preparation node dist/index.js --prepare
SCOUT_MODE=pilot-preparation node dist/index.js --inspect
SCOUT_MODE=pilot-preparation node dist/index.js --events
SCOUT_MODE=pilot-preparation node dist/index.js --review PROJECT_ID DOSSIER_HASH QUOTE_CENTS COST_PROOF_ID
SCOUT_MODE=pilot-preparation node dist/index.js --approve PROJECT_ID ACTION_ID REQUEST_ID FINGERPRINT
SCOUT_MODE=pilot-preparation node dist/index.js --deny PROJECT_ID ACTION_ID REQUEST_ID FINGERPRINT
SCOUT_MODE=pilot-preparation node dist/index.js --declare PROJECT_ID DECLARATION_ID expense AMOUNT_CENTS experiment -
SCOUT_MODE=pilot-preparation node dist/index.js --declare PROJECT_ID DECLARATION_ID revenue AMOUNT_CENTS post_experiment PROOF_ID
```

Les identifiants et empreintes sont ceux retournés par `--inspect`. Aucun argument d'approbation globale, renouvellement automatique, paiement, publication, création de compte, lancement ou consommation d'autorisation n'existe. Une décision est terminale ; une approbation expirée n'est plus valable. Il n'existe aucune passerelle transférant ces demandes aux exécuteurs V8 ni aux autorisations historiques V6.

Procédure future : Scout propose une dépense, vérifie les plafonds, puis l'opérateur examine et accepte ou refuse la demande exacte. Tout éventuel paiement se fait manuellement hors de Scout. **La mission V12.7 s'arrête avant cette étape réelle.**

## Réservations, déclarations et résultats

`preparation_reserved_cents` est une affectation locale du budget de préparation dans l'histoire V12.7. Elle n'est ni une réservation V5, ni un blocage bancaire, ni une dépense. Le ledger V5 et les anciennes données métier ne sont jamais modifiés par V12.7.

| Donnée | Traitement |
|---|---|
| Budget prévu | Entier issu du dossier, maximum 1000 |
| Budget réservé pour préparation | Affectation unique, atomique et authentifiée |
| Coût estimé | Source V12, jamais un paiement |
| Devis documenté | Prix examiné humainement, jamais un paiement |
| Dépense déclarée | `UNVERIFIED_HUMAN_DECLARATION`, sans promotion automatique |
| Dépense confirmée par preuve / banque | `null` ; confirmation financière non implémentée |
| Revenu estimé | Hypothèse du dossier, sans effet sur les plafonds |
| Revenu déclaré | Déclaration non vérifiée, période explicite |
| Revenu confirmé | `null`, même avec une archive jointe |
| Résultat expérimental / économique | `null` tant qu'aucun résultat authentifié n'existe |

Les déclarations `experiment` et `post_experiment` restent séparées. Les recettes passives V9 d'un actif après clôture conservent leurs mécanismes historiques. V12.7 ne ferme pas une expérience, ne retire pas un actif et ne transforme pas les déclarations en résultats V7/V9. Un devis n'est pas une preuve de paiement. Aucune fausse dépense confirmée n'est créée pour tester V12.7.

## Supervision locale

Les neuf types d'événements demandés ont des contrats fixes et n'accordent aucune capacité : opportunité prête, autorisation nécessaire, budget insuffisant, plafond dépassé, preuve absente, lancement manuel à examiner, blocage, fin de période expérimentale et résultat économique à examiner. La fin d'une période est déduite exclusivement des véritables dates historiques V9 ; l'expiration d'un dossier V12.7 produit un blocage, pas une fausse fin d'expérience. Les événements sont consultables par CLI.

La Control API V12.5 expose `GET /v1/preparation`, `GET /v1/events` et `GET /v1/attention` avec les mêmes protections loopback/authentification. `GET /v1/preparation` contient uniquement des DTO fixes, références, plafonds et statuts : aucune prose libre, archive ou coordonnée bancaire. Les événements historiques sont un journal, pas une garantie que la demande est toujours valide : consulter le statut courant. Les décisions V12.7 exigent le CLI local avec portée exacte ; aucun endpoint HTTP ne peut les accepter avec une simple approbation générique.

Les rejets antérieurs à l'écriture d'un dossier produisent un code d'événement structuré dans le terminal ; ils ne sont pas ajoutés à une histoire canonique invalide. Une anomalie n'est jamais réparée silencieusement.

## Stockage, concurrence et reprise

Les dossiers, décisions, déclarations et événements résident dans un seul fichier canonique authentifié HMAC, sous un répertoire privé adjacent au workspace. Les mécanismes V5 `safePath`, `readConfined`, `locked` et `atomicWrite` sont réutilisés. L'état est vérifié avant toute écriture, puis relu. Les archives, entrées sources et préfixes V5/V6/V7/V9/V10/V11 sont vérifiés et épinglés. Aucun fichier métier historique n'est réécrit.

Une interruption après l'écriture atomique peut être reprise en relançant `--prepare` ou `--inspect`, sans dupliquer le budget. Une interruption laissant une clé sans état, une écriture incomplète, une corruption ou un verrou abandonné bloque et exige une inspection humaine. Le verrou V5 n'est jamais volé ni expiré automatiquement.

**Un workspace préparé est scellé contre les anciens writers financiers/actions.** Ceci empêche qu'un processus V5/V9/V8 engage en parallèle des montants ignorant les affectations V12.7. Le contrôle est effectué sous le verrou partagé, y compris à l'initialisation. La Control API reste consultable, mais ses anciennes décisions sont refusées dans ce workspace. Les workspaces sans ancre V12.7 gardent leur comportement historique. La migration/handover vers un véritable pilote financier n'est pas implémentée.

Les chemins hors workspace, symlinks et hardlinks dangereux sont refusés. Le modèle ne peut écrire les fichiers `pilot-preparation*` ; il n'a pas accès à l'ancre privée ni aux commandes opérateur. Le runtime rejette les champs inattendus et les formes connues de carte/CVV/IBAN/identifiants/secrets. Ne jamais fournir d'archives bancaires ou de secrets : les preuves sont des documents publics expurgés. Comme V6, l'utilisateur OS et le processus hôte sont la frontière de confiance ; HMAC ne prouve pas l'identité humaine et ne résiste pas à leur compromission ou à la suppression de toute l'ancre privée.

## Exemple hors ligne, sans toucher au workspace réel

```bash
pnpm build
node scripts/scout-v12-7-example.mjs
node --import ./scripts/scout-offline-test-guard.mjs scripts/scout-v12-7-validation.mjs
```

L'exemple crée un nouveau répertoire temporaire et refuse une destination existante. Projet 1 : modèle numérique de suivi pour indépendants ; projet 2 : service ponctuel de mise en page. Chacun a 1000 centimes de budget, 7 jours prévus et 1500 centimes de revenu **hypothétique**. Les devis et signaux de marché sont explicitement fictifs. Les deux dossiers sont préparables mais restent bloqués pour tout lancement réel. La validation vérifie les dossiers, la reprise et l'absence de modification du workspace réel.

## Validation sur Chromebook

Depuis `local-ollama-only`, avec les dépendances locales habituelles et un Node compatible avec `better-sqlite3` :

```bash
git branch --show-current
git status --short
pnpm build
pnpm exec vitest run src/__tests__/scout-pilot-preparation.test.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run src/__tests__/scout-allocation.test.ts src/__tests__/scout-control-api.test.ts src/__tests__/scout-event-layer.test.ts src/__tests__/scout-pilot-dry-run.test.ts src/__tests__/scout-pilot-safety.test.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run src/__tests__/scout-*.test.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run --maxWorkers=1 --minWorkers=1
node --import ./scripts/scout-offline-test-guard.mjs scripts/scout-v12-validation.mjs
node --import ./scripts/scout-offline-test-guard.mjs scripts/scout-v12-5-validation.mjs
node --import ./scripts/scout-offline-test-guard.mjs scripts/scout-v12-6-validation.mjs
node --import ./scripts/scout-offline-test-guard.mjs scripts/scout-v12-7-validation.mjs
```

La suite V12.7 utilise les fichiers compilés pour ses enfants/processus : exécuter `pnpm build` avant les tests. Aucun appel réseau externe n'est nécessaire ; la Control API utilise seulement le loopback. Les attentes de sous-processus sont bornées.

## Avant le premier pilote véritable

Validation matérielle Chromebook et décision explicite de l'opérateur encore requises. Il faut remplacer les exemples fictifs par deux opportunités réelles, archiver et examiner des preuves publiques récentes, vérifier le public cible, les frais et les fournisseurs, puis examiner chaque demande exacte avant expiration.

Il reste à concevoir un handover explicite des affectations V12.7 vers le cycle V9, l'enregistrement documenté du lancement manuel et une procédure humaine de rapprochement des paiements/recettes. V12.7 ne fournit ni preuve de fonds disponibles, ni vérification bancaire, ni intégration de paiement, ni création de compte, ni publication, ni renouvellement/consommation d'autorisations. Ces absences sont intentionnelles : **ne pas démarrer de pilote avec de l'argent réel à la livraison**.
