# Scout V14.2 — Transfert comptable atomique local

Base obligatoire : `22c0a11a6e6a866f5464c90ab093cd94617516ab`, dépôt `fabriceL354/automaton`, branche `local-ollama-only`. Aucun changement de `main`.

V14.2 reclassifie une affectation V12.7 vers **les registres existants V5 et V9**. Aucun paiement, achat, publication, compte externe, lancement de projet, action V8, appel Ollama, recherche Web ou vérification bancaire. Les projets V9 cibles restent `reserved`, avec leur autorisation V9 `pending`, sans `started_at`, actif ou résultat.

## Portée et décisions

- Deux projets historiques maximum, anciens engagements autonomes V5 inclus, 1 000 centimes par projet et 2 000 centimes d'exposition cumulée.
- La référence de 10 000 centimes reste distincte de la disponibilité **comptable** V5. Aucune valeur n'atteste un solde bancaire ; `bank_verified_available_cents` reste `null`.
- Dossier réel, revue commerciale, preuves coût/marché présentes et toutes les demandes V12.7 exactes approuvées et non expirées.
- Supervision V12.8 authentifiée exigée ; son plan initial et ses pins sont conservés. Une correspondance par nom ne remplace jamais une liaison d'identité.
- Une demande de transfert propre, avec source exacte, dossier, montant, plan V9 cible, IDs et expiration. L'opérateur l'approuve ou la refuse explicitement ; aucune décision d'action V12.7 n'est convertie en permission de transfert.
- Une seule demande non consommée à la fois. Transférer A avant de préparer B évite de périmer l'empreinte exacte de B. Pas de renouvellement automatique d'une demande expirée ou devenue obsolète.

## Commandes locales

Mode séparé `SCOUT_MODE=economic-handover`. Workspace habituel, aucune URL ni identité distante dans les arguments. Les identifiants doivent venir des vues locales courantes ; les placeholders ci-dessous ne sont pas des valeurs à exécuter.

```bash
SCOUT_MODE=economic-handover node dist/index.js --inspect
SCOUT_MODE=economic-handover node dist/index.js --prepare PROJECT_ID DOSSIER_HASH
SCOUT_MODE=economic-handover node dist/index.js --approve PROJECT_ID DOSSIER_HASH REQUEST_ID FINGERPRINT
SCOUT_MODE=economic-handover node dist/index.js --deny PROJECT_ID DOSSIER_HASH REQUEST_ID FINGERPRINT
SCOUT_MODE=economic-handover node dist/index.js --transfer PROJECT_ID DOSSIER_HASH REQUEST_ID FINGERPRINT
SCOUT_MODE=economic-handover node dist/index.js --recover
```

La préparation de demande ne réserve rien dans V5. Une approbation de transfert ne lance rien. `--transfer` accepte uniquement une demande exacte courante. Répéter un transfert déjà installé renvoie son reçu historique, y compris après expiration, sans nouvelle réservation ou permission. Un arrêt terminal refuse tout nouveau `--transfer`, même si l'appel vise un ancien reçu ; `--inspect` reste le canal de lecture.

Les commandes `--pay`, `--publish`, `--start`, `--execute`, `--open-account`, `--approve-all`, `--resume` et les champs supplémentaires sont refusés. Aucun endpoint HTTP ou outil du modèle n'accepte cette opération. L'API locale conserve ses règles de loopback, token, Host, Origin, limites et refus des décisions de préparation.

## Atomicité : point de commit et reprise

Le verrou V5 partagé est acquis pour validation, décision, commit et installation. Les autres hosts utilisent le même verrou et vérifient le journal de transfert avant leur opération. Les writers legacy restent scellés par l'ancre V12.7 ; aucun exécuteur n'est déverrouillé.

Le journal privé `economic-handover-state.json` est placé **dans l'ancre V12.7 existante**, hors de portée des outils du modèle, et signé avec sa clé HMAC. Il conserve demandes, décisions et au maximum deux ensembles d'écritures. Il ne possède aucun solde financier autonome : il décrit la transaction entre les autorités existantes.

Pour chaque transaction, l'ensemble fermé de neuf cibles contient les images avant/après :

1. `economic-ledger.json` V5 ;
2. `economic-report.txt` ;
3. `project-batch.json` ;
4. `projects.json` ;
5. `assets.json` ;
6. `project-report.txt` ;
7. `state.json` dans l'ancre de préparation ;
8. `integrity-key` dans l'ancre V9 ;
9. `state.json` dans l'ancre V9.

Les réservations sont construites avec `reserveProjectReference()`, les événements avec `economicChanges()`/`transition()` et contrôlés par `auditProjects()`. Les mêmes formats HMAC V12.7/V9 et les mêmes vues sont réutilisés. Les événements antérieurs, empreintes V5, décisions de préparation et plans V13 sont conservés ; seule une extension append-only `accounting_transfer` reclassifie l'affectation. `reserved_budget_cents` conserve son montant historique ; `active_preparation_reserved_cents` devient zéro pour le projet transféré.

Après relecture des sources, des preuves, de l'expiration au moment du commit et de l'arrêt, **un seul `atomicWrite()` du journal signé engage durablement la transaction complète**, avant la moindre écriture V5/V9. La primitive existante synchronise le temporaire, renomme puis synchronise le répertoire. Si ce commit n'existe pas, les autorités financières/source restent inchangées. S'il existe, les neuf images après sont l'unique résultat engagé, à installer sans nouveau consentement.

L'installation physique des neuf fichiers n'est pas une primitive atomique du système de fichiers. Une interruption peut laisser des fichiers partiellement installés, mais **aucun host coopérant ne peut utiliser cet état comme un transfert partiel ou comme des fonds libres** : l'installation incomplète bloque les autres modes. `--inspect` affiche `COMMITTED_RECOVERY_REQUIRED` sans lire les soldes partiels. Seul `--recover` installe les octets déjà engagés, sous le même verrou.

Avant toute reprise, chaque cible doit correspondre à son image avant ou après. Une troisième valeur, un symlink/hardlink, un journal tronqué, HMAC incorrect, taille excessive ou ancre inconnue bloque sans réparation. Après installation, fichiers et répertoires sont synchronisés et le journal passe à `installed: true`. La vérification ultérieure refuse la perte du journal, le retour d'un fichier financier à une ancienne image et l'altération d'un reçu source.

La garantie est donc une **transaction logique durable avec installation/reprise fermée**, pour les hosts Scout qui respectent le verrou et le journal. Elle ne prétend pas fournir neuf renames physiquement simultanés ni protéger un lecteur OS qui contourne les hosts et consulte les fichiers bruts pendant la transaction. Une erreur après rename/synchronisation ne signifie jamais automatiquement « rien n'a été écrit » : inspecter/reprendre le reçu canonique.

## Exposition et audit

L'affectation historique est retenue, mais le calcul courant ne compte plus le projet source lorsqu'il est lié à sa réservation cible exacte. L'identité, le budget, l'entrée V5, son hash et la réservation V9 doivent tous correspondre. Les projets transférés ne peuvent pas recevoir d'autres écritures de préparation, ni une approbation/démarrage V9 via les anciens writers scellés.

Exemple arithmétique **fictif** avec disponibilité comptable initiale de 2 000 centimes :

| État | Affectations actives | Réservé V5 | Disponible V5 | Exposition |
| --- | ---: | ---: | ---: | ---: |
| Deux dossiers préparés | 2 000 | 0 | 2 000 | 2 000 |
| A transféré | 1 000 | 1 000 | 1 000 | 2 000 |
| A et B transférés | 0 | 2 000 | 0 | 2 000 |

Aucune ligne ne représente un débit bancaire. Aucun revenu ou résultat fictif ne recharge le plafond. Chaque commit ajoute exactement une entrée `reserve`, sans changer le capital initial, les dépenses ou les recettes.

Le journal relit aussi les formats et sémantiques : préfixe ledger intact, une réservation de montant exact, source reclassifiée sans réécriture de son histoire, opérations V9 limitées à création/réservation, autorisation V9 en attente et vues correspondant au replay. Le journal est borné à 2 MiB, huit demandes et deux transactions ; aucun historique n'est tronqué pour tenir dans ces limites.

## Arrêt et verrous abandonnés

L'arrêt est vérifié avant/sous verrou et avant le commit. Un arrêt arrivant pendant une transaction déjà engagée ne supprime ni sa décision ni son audit. L'installation locale peut finir ; le résultat n'accorde aucune permission et le marqueur reste terminal.

`--recover` peut terminer une transaction comptable **déjà engagée**, même après expiration ou arrêt. Il ne crée pas une nouvelle demande, ne renouvelle rien, ne dépense pas et ne reprend aucun projet. C'est une remise en cohérence de l'histoire locale, pas une levée de l'arrêt.

Un crash de processus peut laisser `.economic-ledger.lock`. V14.2 ne vole, ne supprime et n'expire jamais ce verrou. `--recover` échoue alors jusqu'à inspection humaine. Une procédure humaine doit vérifier le processus propriétaire, les sources et le journal ; aucune commande de suppression de verrou réel n'est livrée. Le test de crash ne retire le verrou qu'après avoir vérifié la mort du processus dans une fixture jetable.

## Compatibilité V13 et limites restantes

Les fichiers de logique V13 et V14.1 restent inchangés. Les plans et leurs décisions authentifiés sont conservés dans l'état de préparation. Après transfert, les anciennes vues V12.8/V13 peuvent refuser les nouvelles sources avec `Handover source changed` / `HANDOVER_SOURCE_CHANGED` : l'ancien plan ne devient pas automatiquement courant. Les empreintes ne sont pas recalculées pour contourner ces refus. Le reçu V14.2 est consultable avec `--inspect` ; les vues V12.7/API conservent des blocages d'exécution.

Sur un workspace non transféré, les contrôles précédents restent disponibles. Un ancien binaire ne doit pas être utilisé sur un workspace enrichi : son parseur strict refuse l'extension source. Sauvegarder ensemble workspace, ancres adjacentes, clés, journal et marqueur d'arrêt ; copier uniquement les fichiers visibles du workspace perdrait une partie de l'autorité.

La frontière de confiance reste l'utilisateur OS et le processus hôte. Les HMAC ne sont pas une authentification bancaire et ne résistent pas à la compromission de leurs clés ou à la restauration concertée de toutes les ancres depuis une ancienne sauvegarde. La durabilité suppose un filesystem local supportant correctement rename/fsync ; les tests de processus ne démontrent pas toutes les coupures électriques possibles.

V14.2 ne fournit pas : compte vendeur existant attesté, suivi de commandes/remboursements/versements, autorisation de lancement, rapprochement bancaire, fonctionnement multi-utilisateur, serveur/mobile ou Scout Invest. Les deux expériences commerciales réelles restent interdites dans cette livraison.

## Validation Chromebook, un worker

Confirmer branche et SHA de livraison, arbre propre et versions Node/pnpm/SQLite compatibles. Environnement de validation de cette livraison : Node 22.16.0, pnpm 10.28.1. Aucun délai de test ou assertion n'est affaibli. Les fixtures enfants exigent le build avant les tests.

```bash
git branch --show-current
git rev-parse HEAD
git status --short
node --version
pnpm --version
pnpm build
export NODE_OPTIONS="--import=$PWD/scripts/scout-offline-test-guard.mjs"
pnpm exec vitest run src/__tests__/scout-economic-handover.test.ts \
  --maxWorkers=1 --minWorkers=1
pnpm exec vitest run src/__tests__/scout-pilot-preparation.test.ts \
  src/__tests__/scout-pilot-readiness.test.ts \
  src/__tests__/scout-operational-planning.test.ts \
  src/__tests__/scout-fictional-simulation.test.ts \
  --maxWorkers=1 --minWorkers=1
node scripts/scout-v12-7-validation.mjs
node scripts/scout-v12-8-validation.mjs
node scripts/scout-v13-validation.mjs
unset NODE_OPTIONS
git status --short
```

Ces tests créent leurs propres espaces temporaires, simulent seulement la comptabilité et la décision dans ces fixtures, et ne transfèrent jamais le workspace réel. La validation matérielle Chromebook reste à effectuer ; les résultats du conteneur ne la remplacent pas. Ne pas exécuter `--transfer` sur un dossier réel pour vérifier l'installation.

## Fichiers et résultats de livraison

Créés : `src/agent/economic-handover-model.ts`, `src/agent/economic-handover-store.ts`, `src/agent/economic-handover.ts`, `src/__tests__/scout-economic-handover.test.ts`, `src/__tests__/fixtures/handover-child.mjs`, `SCOUT_V14_2.md`.

Modifiés : `src/agent/ledger-runner.ts`, `src/agent/local-tools.ts`, `src/agent/pilot-preparation-model.ts`, `src/agent/pilot-preparation-store.ts`, `src/agent/pilot-preparation.ts`, `src/agent/project-store.ts`, `src/index.ts`.

Validation finale dans l'environnement de développement, Node 22.16.0, pnpm 10.28.1, garde réseau active et un seul worker :

| Contrôle | Résultat |
| --- | --- |
| `pnpm build`, bibliothèque et CLI | PASS |
| Tests ciblés V14.2, passage final | 56/56 PASS |
| V12.7, dans la suite finale | 55/55 PASS |
| V12.8, dans la suite finale | 52/52 PASS |
| V13, dans la suite finale | 57/57 PASS |
| V14.1, dans la suite finale | 54/54 PASS |
| Suite complète finale | 87 fichiers, 3 460/3 460 PASS, aucun test ignoré ; 354,29 s |
| Scripts hors ligne V12.7/V12.8/V13 | PASS |
| `git diff --check` et conservation des fichiers de logique V13/V14.1/API | PASS |

Un premier passage complet avait 3 458 succès et deux échecs dans les tests nouveaux : cache de transformation antérieur à l'ajout de la barrière de synchronisation, et fixture de ledger falsifié atteignant le contrôle d'horloge avant celui du delta. Ce passage n'est pas compté comme PASS. La fixture a été précisée avec l'image ledger d'origine, le build et les processus ont été relancés, puis tous les tests ont réussi sur des fichiers inchangés. Aucun délai, assertion de sécurité ou garde réseau n'a été affaibli.

Les tests couvrent chaque cible d'installation, commit absent/présent, ACK perdu, source modifiée, concurrence entre processus, processus tué et lock abandonné, arrêt, expiration à la revalidation finale, rollback d'horloge, perte/altération du journal et absence de capacité HTTP/modèle. Toutes les opérations financières de test sont des réservations comptables synthétiques dans des répertoires temporaires.

La suite globale n'est pas nécessaire comme premier contrôle sur le Chromebook. Aucun PASS matériel Chromebook ni résultat commercial réel n'est revendiqué pour V14.2.
