# Scout V13 — Planification opérationnelle économique supervisée

Base exacte : `466d3fe11c13c5369c853a60f2e58f427889b8ec`, dépôt `fabriceL354/automaton`, branche exclusive `local-ollama-only`.

**V13 est intégralement non exécutable.** Elle ne réalise aucun paiement, achat, transfert financier, création de compte, publication ou lancement économique. Aucun appel Ollama, fournisseur réseau, shell ou exécuteur n'est effectué par le moteur. Les commandes locales ne produisent que des propositions et un audit authentifié.

## Audit et frontière conservée

V12.8 dispose d'un état V12.7 authentifié par HMAC, de sources et historiques épinglés, de preuves locales confinées, d'autorisations exactes, d'un plan de transfert non exécutable et d'un arrêt terminal indépendant du verrou métier. V13 réutilise ces mécanismes sans créer de writer financier.

**Le transfert V12.7 → V5/V9 reste arrêté : aucune transaction durable commune ne garantit le retrait de l'affectation et la réservation cible tout-ou-rien.** V13 ne retire pas le scellement et ne crée aucune réservation V5/V9. Les plafonds restent deux projets, 1 000 centimes par projet, 2 000 centimes d'exposition totale, sept jours de durée proposée maximum. Tous les historiques V5/V9, même anciens, restent pris en compte par V12.8. Les 10 000 centimes de référence ne prouvent aucun solde bancaire.

## Plan déterministe et provenance

Le moteur exige une préparation V12.7 et une supervision V12.8 déjà créées explicitement. Il vérifie l'authentification HMAC et le workspace, les empreintes du dossier, de l'entrée et des recherches, les préfixes des historiques, les preuves, le plan V12.8, la capacité, l'horloge, les échéances et l'arrêt d'urgence. Une corruption bloque ; aucune donnée ou ancre n'est réparée automatiquement.

Chaque plan contient :

- Une provenance liée aux empreintes de l'état source, des sources financières et commerciales, de l'entrée et du plan V12.8.
- Les dossiers et hypothèses de coût archivés, les offres et publics, les risques, critères de réussite et conditions d'arrêt.
- Des étapes d'examen des preuves, du devis et des autorisations, puis les actions humaines proposées et une revue des résultats.
- Un graphe de dépendances acyclique conservateur. Les actions sources sont proposées dans l'ordre du dossier ; cet ordre ne constitue ni un planning réel ni une inférence sur leur indépendance.
- Trois simulations par projet, sans date de départ, échéance réelle ou résultat bancaire inventés.

`plan_id = operational-plan-<SHA-256 du contenu>`. L'identifiant est stable pour le même workspace authentifié, ses mêmes dossiers et décisions. L'heure de consultation, les écritures V13 et les contrôles V13 n'entrent pas dans cette identité. Un nouveau workspace possède une provenance différente : son identifiant n'est pas destiné à être portable.

Une décision, déclaration ou un contrôle V12.8 ajouté aux sources produit une nouvelle identité. `--plan` archive le nouveau plan et conserve les anciens. Un contrôle lié à l'ancien plan est refusé ; `--report` bloque sur `PLAN_SOURCE_CHANGED` jusqu'à la préparation explicite du nouveau plan. Le moteur ne choisit pas silencieusement une ancienne version.

Répéter `--plan` à sources identiques ne modifie aucun octet d'état et ne duplique ni affectation ni événement. Les contrôles identiques de même portée et résultat sont également idempotents. Chaque événement conserve sa portée, son horodatage, sa séquence, son empreinte et l'empreinte précédente ; `execution_performed` reste toujours `false`.

## Simulations : hypothèses explicites

Les calculs utilisent des centimes entiers, des intermédiaires BigInt et des bornes d'entiers sûrs. Les valeurs invalides, fractions, négatifs et dépassements sont refusés. Un coût supérieur au budget est conservé et signalé, jamais réduit artificiellement pour passer le plafond.

La base de coût est le devis examiné humainement s'il existe, sinon l'estimation de source qualifiée `SOURCE_ESTIMATE`. Une simple hypothèse de coût ne devient pas une estimation documentée. À défaut, le coût reste `null`. La base de revenu est uniquement l'hypothèse du dossier ; les déclarations de revenu ne l'alimentent pas.

| Scénario | Coût estimé | Revenu hypothétique | Résultat prévisionnel |
|---|---|---|---|
| Pessimiste | Maximum du budget et de la base connue ; inconnu si la base manque | Zéro vente supposée | Revenu moins coût, ou inconnu |
| Central | Base de coût connue | Hypothèse du dossier, ou inconnue | Revenu moins coût, ou inconnu |
| Optimiste | 80 % de la base, arrondi au centime inférieur | 150 % de l'hypothèse, arrondi au centime inférieur | Revenu moins coût, ou inconnu |

Ces coefficients sont des **hypothèses de sensibilité fixes**, pas des probabilités, garanties, estimations apprises ou preuves de demande. L'inconnu reste inconnu ; zéro vente pessimiste est une hypothèse explicitement choisie. Aucune simulation n'augmente les fonds disponibles. Les revenus ne sont jamais acquis. Dépense vérifiée, revenu confirmé et résultat bancaire restent inconnus.

Exemple fictif : budget et coût de base 1 000 centimes, revenu hypothétique 1 500 centimes.

| Scénario | Coût | Revenu | Résultat |
|---|---:|---:|---:|
| Pessimiste | 1 000 | 0 | −1 000 |
| Central | 1 000 | 1 500 | 500 |
| Optimiste | 800 | 2 250 | 1 450 |

Les coûts de temps humain, taxes ou frais absents des dossiers ne sont pas inventés. Les risques et incertitudes sources restent à examiner humainement ; ces résultats n'ont pas la portée d'un bénéfice réellement constaté.

## Dossier de décision et autorisations

Le rapport réunit le plan, les vérifications, les autorisations exactes, leurs décisions et échéances, les déclarations non vérifiées, les blocages et l'audit.

Les décisions continuent à relever des commandes locales V12.7 ; V13 ne crée aucune approbation et n'ajoute aucun endpoint HTTP de décision. `--check-action` exige le plan, le projet, le hash de dossier, l'action, la demande et son empreinte exacts. Il refuse une portée ambiguë ou altérée, une demande en attente/refusée, une expiration à sa borne exacte, un dossier fictif, des preuves manquantes, une revue commerciale absente ou un scénario au-delà du plafond. Même un résultat `EXACT_AUTHORIZATION_CURRENT_NO_EXECUTION` laisse `execution_allowed: false`, ne consomme pas la demande et ne lance rien.

Une préparation de plan est possible avec des décisions en attente ou des dossiers fictifs pour examiner leurs blocages. Un dossier expiré ou une preuve absente empêche une **nouvelle** préparation. Les consultations en lecture seule restent possibles après expiration et affichent les blocages actuels, sans renouvellement. Les refus de contrôle sont audités lorsque les sources sont authentifiables ; une corruption ne reçoit aucun faux événement de vérification.

## Commandes

Sur un workspace déjà préparé en V12.8 :

```bash
SCOUT_MODE=operational-planning node dist/index.js --plan
SCOUT_MODE=operational-planning node dist/index.js --report
SCOUT_MODE=operational-planning node dist/index.js --report-markdown
SCOUT_MODE=operational-planning node dist/index.js --events
SCOUT_MODE=operational-planning node dist/index.js --check-action PLAN_ID PROJECT_ID DOSSIER_HASH ACTION_ID REQUEST_ID FINGERPRINT
SCOUT_MODE=operational-planning node dist/index.js --stop-status
```

Arrêt terminal volontaire :

```bash
SCOUT_MODE=operational-planning node dist/index.js --halt operator-stop
```

Les autres motifs fixes V12.8 restent `budget-concern`, `evidence-concern`, `security-concern`. Aucune commande `--resume`, `--start`, `--run`, `--execute`, `--pay` ou `--publish` n'est admise. Les erreurs CLI utilisent un motif fixe et ne reflètent pas de chemins, valeurs privées ou prose source.

## Persistance, verrou et arrêt

Le champ optionnel `planning` est enregistré dans le **même état HMAC V12.7** que les dossiers et la supervision. Il est validé strictement, y compris les formules, dépendances, plafonds, liens aux dossiers et chaîne d'audit. Il n'existe aucun second journal financier à synchroniser. Les anciens états sans `planning` restent lisibles. V12 à V12.8 et les projections Control API continuent de fonctionner avec ce binaire ; un ancien binaire antérieur à V13 refuse le nouveau champ plutôt que de l'ignorer. Ne pas rétrograder un workspace contenant des plans V13.

Le verrou partagé V5 conserve son caractère exclusif. Les sources sont relues avant le commit. Écriture temporaire privée, validation, `fsync`, renommage atomique et relecture conservent un état ancien ou nouveau complet. Un crash laisse un verrou bloquant qui n'est jamais volé ou automatiquement expiré.

L'arrêt est vérifié avant et sous le verrou, avant le commit et avant le résultat. Le marqueur terminal V12.8 domine les statuts, même si son reçu est absent ou corrompu. Il reste disponible indépendamment d'un verrou abandonné ou de données corrompues. Une écriture locale de proposition/audit déjà admise peut terminer lors d'un arrêt concurrent, mais son résultat n'accorde aucune permission. Une consultation après arrêt reste en lecture seule ; si l'état est corrompu ou le verrou abandonné, seul le contrôle indépendant de l'arrêt reste utilisable.

L'archive est limitée à huit plans et l'audit à 128 événements, dans la borne de 512 Kio de l'état V12.7. Une limite atteinte bloque la nouvelle écriture, sans tronquer l'histoire ; l'arrêt reste disponible. Les outils du modèle ne peuvent écrire les ancres privées ni les noms d'artefacts `operational-planning`.

Le propriétaire du compte OS et le host restent la frontière de confiance, comme en V12.8. HMAC n'est ni une identité humaine ni une preuve bancaire et n'empêche pas ce propriétaire de supprimer/remplacer toutes les clés et ancres. Les exports Markdown/JSON sont informatifs, jamais des autorisations importables.

## Validation hors ligne et exemple reproductible

Utiliser Node compatible avec les dépendances natives installées et pnpm `10.28.1`. Compiler avant les tests qui démarrent les processus compilés. Les commandes ci-dessous ne nécessitent ni Ollama ni accès public. Le garde réseau bloque les sorties publiques ; le loopback ne sert qu'aux tests locaux Control API. La validation V13 bloque aussi tout `fetch`, y compris Ollama, et vérifie zéro appel.

```bash
git branch --show-current
git rev-parse HEAD
git status --short
pnpm build
export NODE_OPTIONS="--import=$PWD/scripts/scout-offline-test-guard.mjs"
pnpm exec vitest run src/__tests__/scout-operational-planning.test.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run src/__tests__/scout-pilot-preparation.test.ts src/__tests__/scout-pilot-readiness.test.ts src/__tests__/scout-allocation.test.ts src/__tests__/scout-control-api.test.ts src/__tests__/scout-event-layer.test.ts src/__tests__/scout-pilot-dry-run.test.ts src/__tests__/scout-pilot-safety.test.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run --maxWorkers=1 --minWorkers=1
node scripts/scout-v12-validation.mjs
node scripts/scout-v12-5-validation.mjs
node scripts/scout-v12-6-validation.mjs
node scripts/scout-v12-7-validation.mjs
node scripts/scout-v12-8-validation.mjs
node scripts/scout-v13-validation.mjs
node scripts/scout-v13-example.mjs
unset NODE_OPTIONS
```

L'exemple crée un workspace temporaire neuf, deux dossiers fictifs V12.8 et un dossier de décision V13 Markdown/JSON. Il refuse une destination existante et ne modifie pas le workspace réel. Les contrôles de rejeu reproduisent les mêmes plans ; les deux budgets restent de simples affectations V12.7. L'exemple conserve les déclarations fictives V12.8, explicitement non vérifiées.

Les tests couvrent intégrité et provenance, calculs et inconnus, plafonds et overflow, idempotence et redémarrage, portées exactes, décisions et échéances, corruption et modification des sources, verrous concurrents, crashes avant/après renommage, arrêt pendant le commit, compatibilité des versions et absence d'effets économiques.

### Chromebook et `hookTimeout`

**Cette livraison n'est pas une validation matérielle Chromebook.** Exécuter ces commandes sur le vrai appareil avant de déclarer V13 validée matériellement. Un seul worker est utilisé ; les délais existants ne sont pas augmentés et chaque enfant V13 dispose d'une borne de 15 secondes.

En cas de dépassement `hookTimeout`, conserver la sortie et relever le fichier, le hook, le délai affiché, la version de Node/pnpm et la charge machine. Vérifier la compatibilité SQLite/Node et l'absence de processus concurrent, puis rejouer le test isolé et la suite. Ne pas ignorer le test, modifier ses assertions, augmenter silencieusement ses délais ou compter un échec comme PASS. Distinguer les résultats de ce conteneur des observations sur Chromebook.

### Résultats dans l'environnement de livraison

- Compilation : PASS avec Node `22.16.0` et pnpm `10.28.1`.
- Tests V13 : 57/57 PASS ; tests ciblés de compatibilité V12 à V12.8 : 404/404 PASS.
- Suite complète finale, un seul worker : 85 fichiers, 3 350/3 350 tests PASS, sans test ignoré.
- Validations hors ligne V12, V12.5, V12.6, V12.7, V12.8 et V13 : PASS ; exemple V13 : PASS.
- Aucun dépassement de `hookTimeout` observé dans ce conteneur. Aucun délai ni assertion n'a été affaibli.

Un premier essai de suite complète avec Node `24.19.0` et SQLite reconstruit a été interrompu par une assertion native `RemoveEnvironmentCleanupHook` lors de la destruction d'un statement SQLite. Cet essai n'est pas un PASS. La relance complète avec Node `22.16.0` et son module SQLite compatible a réussi. Les dépendances et la configuration de tests du dépôt n'ont pas été modifiées pour contourner cet échec d'environnement.

**Aucune validation matérielle Chromebook ni expérimentation économique réelle n'est déclarée.**
