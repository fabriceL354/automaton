# Scout V12.8 — Sécurisation finale du pilote supervisé

V12.8 prépare et vérifie les dossiers V12.7. **Elle ne lance aucun pilote réel et n'effectue aucun transfert financier, achat, paiement, ouverture de compte ni publication.** Aucun accès bancaire ou appel Ollama n'est requis.

## Base et compatibilité

Base : `ec98eae10ac6c17f3d71778f59f071b1401d7e8e`, branche exclusive `local-ollama-only`. V12, V12.5, V12.6 et V12.7 restent disponibles. Le format V12.7 conserve ses champs ; un champ optionnel `supervision` est ajouté sous le même HMAC lors de la préparation V12.8. Un ancien workspace sans ce champ reste lisible. Un ancien binaire V12.7 doit refuser ce nouveau champ plutôt que l'ignorer : ne pas rétrograder un workspace supervisé.

## Transfert financier : blocage essentiel conservé

Le stockage V12.7 et les historiques V5/V9 n'ont pas de transaction commune garantissant que le retrait d'une affectation et sa réservation cible soient atomiques. **Le développement du transfert effectif est arrêté à cette frontière de sécurité.** Aucun writer V5/V9 n'est appelé par V12.8 ; le scellement V12.7 n'est jamais retiré.

`--prepare-handover` enregistre l'empreinte d'un plan non exécutable, sans créer de réservation. Chaque ligne contient une identité de transfert stable liée au projet et au dossier, le montant déjà affecté, une reclassification proposée, une exposition supplémentaire de zéro et des identités cibles V5/V9 non attribuées. Répéter la commande ne duplique ni budget ni événement.

Le protocole futur devra, sous le verrou partagé :

1. Revérifier l'arrêt d'urgence, les sources, les plafonds et les autorisations exactes.
2. Lier sans ambiguïté un projet V12.7 à un projet V9 et une réservation V5 uniques.
3. Enregistrer le retrait de l'affectation source et la réservation cible dans une transaction durable unique.
4. Rejouer la transaction par identité de transfert sans double comptabilisation.
5. Garantir une reprise tout-ou-rien avant de déverrouiller un writer.
6. Garder distincts autorisation, action humaine, déclaration et vérification financière.

Les deux projets au maximum disposent de 1 000 centimes chacun, avec une exposition totale maximale de 2 000 centimes. L'exposition inclut les réservations V5 historiques, les dépenses historiquement enregistrées et les projets V9 planifiés non encore réservés. Une réservation V9 présente aussi dans V5 compte une seule fois. Les engagements V5 autonomes, même libérés, occupent conservativement une place dans la limite historique ; une collision de noms bloque au lieu d'inventer une correspondance. Les anciens projets V9 fermés restent inclus dans les limites du batch.

Les 10 000 centimes de référence simulée ne prouvent jamais un solde bancaire. Les dépenses historiquement enregistrées par V5/V9 conservent leur qualification comptable et ne sont pas requalifiées en preuves bancaires.

## Commandes locales

Préparer d'abord le dossier V12.7 existant, puis son plan V12.8 :

```bash
SCOUT_MODE=pilot-preparation node dist/index.js --prepare
SCOUT_MODE=pilot-readiness node dist/index.js --prepare-handover
SCOUT_MODE=pilot-readiness node dist/index.js --report
SCOUT_MODE=pilot-readiness node dist/index.js --report-markdown
SCOUT_MODE=pilot-readiness node dist/index.js --events
SCOUT_MODE=pilot-readiness node dist/index.js --stop-status
```

`--report` et `--report-markdown` sont en lecture seule : ils ne préparent pas implicitement le plan et ne renouvellent pas les autorisations. Le rapport Markdown peut être conservé manuellement dans un fichier ; cette copie est informative, jamais une autorisation.

Vérification informative d'une autorisation exacte, en reprenant les identifiants du rapport :

```bash
SCOUT_MODE=pilot-readiness node dist/index.js --check-action PROJECT_ID DOSSIER_HASH ACTION_ID REQUEST_ID FINGERPRINT
```

Même lorsque cette vérification réussit, `execution_allowed` reste `false`, l'autorisation n'est pas consommée, aucun exécuteur n'est appelé, aucune date de lancement n'est créée. Une demande en attente, refusée, expirée, transférée à un autre projet/action ou liée à un dossier altéré est rejetée. Les preuves manquantes, les projets fictifs et les blocages commerciaux interdisent également un contrôle positif.

Les décisions V12.7 restent explicitement locales (`--review`, `--approve`, `--deny`) et liées au dossier initial ; la Control API ne gagne aucun endpoint de décision. Après préparation V12.8, les vues V12.7 et V12.5 indiquent elles aussi le blocage du transfert. Les anciennes entrées d'événements « ready » restent historiques, jamais des permissions actuelles.

Les déclarations V12.7 existantes restent lisibles. Dans un workspace supervisé V12.8, une **nouvelle** déclaration nécessite un dossier courant, des preuves présentes et les autorisations exactes approuvées. Une déclaration de revenu après expérience demeure une déclaration non vérifiée, sans démarrage ni clôture implicites. Le suivi réel à long terme nécessitera le futur host de transition ; V12.8 ne déverrouille pas V9.

## Arrêt d'urgence terminal

Commande opérateur volontaire, qui bloque durablement les nouvelles écritures dans ce workspace :

```bash
SCOUT_MODE=pilot-readiness node dist/index.js --halt operator-stop
SCOUT_MODE=pilot-readiness node dist/index.js --stop-status
```

Les autres motifs fixes acceptés sont `budget-concern`, `evidence-concern`, `security-concern`. Aucun motif libre ou secret n'est stocké. **Il n'existe aucune commande de reprise dans V12.8.** Ne pas supprimer le marqueur pour tenter de contourner un arrêt.

L'arrêt ne dépend pas du verrou métier ni de la validité du dossier. Un répertoire privé adjacent au workspace est créé de façon exclusive ; son existence constitue l'arrêt. Le répertoire parent est synchronisé avant la rédaction du reçu. Un crash entre ces étapes, un reçu absent/corrompu ou un marqueur anormal restent bloquants. La répétition de `--halt` conserve le premier reçu et ne l'écrase pas.

Les writers vérifient le marqueur avant et sous le verrou partagé. Les writers V12.7/V12.8 le revérifient avant leur commit et avant leur résultat. L'arrêt peut survenir pendant une opération déjà admise : une écriture locale d'audit déjà en cours peut finir, mais son résultat n'accorde aucune permission ; le marqueur domine ensuite tous les statuts. V12.8 n'a aucun exécuteur réel à interrompre. L'arrêt ne peut pas annuler une action humaine réalisée hors de Scout.

`--stop-status` fonctionne sans le verrou métier. Les rapports restent consultables après arrêt si les données et le verrou sont valides. En cas de verrou abandonné ou d'état corrompu, les rapports échouent fermés et `--stop-status` reste disponible ; aucune histoire invalide n'est réparée silencieusement. L'arrêt bloque aussi les anciens writers V5–V12.7 et de nouvelles préparations dans ce workspace.

## Audit, corruption et reprise

Le plan et les contrôles V12.8 sont ajoutés au fichier canonique V12.7, authentifié HMAC. Les événements ont une séquence, un horodatage, une portée exacte, un résultat fixe et une chaîne SHA-256 ; ils ne peuvent contenir `execution_performed: true`. Les contrôles refusés pour portée, expiration ou absence d'autorisation sont journalisés quand l'état source est vérifiable. Si les sources sont corrompues, aucun événement n'est écrit dans une histoire invalide : la commande retourne un blocage fixe.

Le journal est borné à 128 événements ; une fois plein, aucune décision supplémentaire n'est acceptée et l'arrêt reste disponible. Les anciens dossiers conservent leurs décisions V12.7 avec la portée, l'échéance et la référence opérateur. Une horloge reculée bloque les opérations ; aucune approbation n'est renouvelée automatiquement.

Le stockage réutilise le verrou exclusif V5, les lectures confinées, l'écriture temporaire vérifiée, `fsync`, le renommage atomique et la relecture. Un crash avant/après renommage conserve un état ancien ou nouveau complet. Un verrou laissé par un processus mort n'est ni volé ni expiré automatiquement ; inspection humaine requise. Une relance propre après fin normale ne répète pas les affectations.

Comme V6/V12.7, le propriétaire du compte OS et le host sont la frontière de confiance. HMAC n'est pas une identité humaine ni une preuve bancaire ; il ne protège pas contre le propriétaire OS qui remplace/supprime tout l'historique et ses clés. Le reçu d'arrêt a un checksum d'intégrité, pas une signature bancaire ou une authentification distante. Son contenu ne peut jamais lever l'arrêt : seule l'existence du marqueur décide du blocage. La suppression malveillante de toutes les ancres par le propriétaire OS est hors de cette garantie.

## Rapport et distinctions économiques

Chaque projet expose l'opportunité, l'offre, le public, les risques, les références de preuves de coût/marché, le devis examiné humainement, les demandes exactes, les décisions, les actions manuelles restantes, les conditions d'arrêt et tous les blocages.

| Donnée | Qualification V12.8 |
|---|---|
| Budget prévu | Plafond du dossier, en centimes entiers |
| Budget affecté | Affectation V12.7 conservée, pas de réservation bancaire |
| Dépense déclarée | Déclaration humaine non vérifiée |
| Dépense réellement vérifiée | `null` — mécanisme non implémenté |
| Revenu estimé | Hypothèse, jamais ajoutée aux fonds disponibles |
| Revenu déclaré | Non vérifié, périodes expérience/après-expérience séparées |
| Revenu réellement confirmé | `null` — pas de confirmation automatique |
| Lancement manuel | `NOT_RECORDED` — aucune preuve d'exécution inventée |
| Date de départ et échéance réelle | `null` — pas de faux début de période |

La période expérimentale prévue reste limitée à sept jours. Les revenus ultérieurs d'un actif ont une période distincte et aucune fausse date de fin à sept jours. Une expiration d'autorisation n'est pas une fin d'expérience. Les archives publiques et déclarations ne deviennent jamais des justificatifs bancaires.

## Exemple et validation Chromebook

Node compatible avec les dépendances natives déjà installées et pnpm du dépôt (`10.28.1`). `pnpm build` est indispensable avant les tests qui démarrent des processus compilés. Les suites s'exécutent avec un seul worker, sans augmenter les délais globaux de 30 secondes ; les enfants V12.8 ont une borne de 15 secondes. Seuls les tests de concurrence démarrent intentionnellement deux petits processus.

```bash
git branch --show-current
git status --short
pnpm build
export NODE_OPTIONS="--import=$PWD/scripts/scout-offline-test-guard.mjs"
pnpm exec vitest run src/__tests__/scout-pilot-readiness.test.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run src/__tests__/scout-pilot-preparation.test.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run src/__tests__/scout-allocation.test.ts src/__tests__/scout-control-api.test.ts src/__tests__/scout-event-layer.test.ts src/__tests__/scout-pilot-dry-run.test.ts src/__tests__/scout-pilot-safety.test.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run --maxWorkers=1 --minWorkers=1
node scripts/scout-v12-validation.mjs
node scripts/scout-v12-5-validation.mjs
node scripts/scout-v12-6-validation.mjs
node scripts/scout-v12-7-validation.mjs
node scripts/scout-v12-8-validation.mjs
node scripts/scout-v12-8-example.mjs
unset NODE_OPTIONS
```

Le garde réseau interdit les sorties publiques ; le loopback est autorisé uniquement pour les tests locaux de Control API. Les validations déterministes ne nécessitent pas Ollama. La simulation V12.8 rejette aussi tout `fetch`, y compris vers Ollama, et vérifie zéro appel.

L'exemple et la simulation créent des répertoires temporaires neufs et refusent d'écraser une destination. Deux offres fictives sont reprises de V12.7 (modèle numérique et mise en page), avec 1 000 centimes chacune et des devis/marchés fictifs. Le premier dossier contient des déclarations fictives de 200 centimes de dépense, 300 centimes de revenu expérimental et 100 centimes de revenu ultérieur. Rien n'est confirmé. La simulation teste aussi l'arrêt durable et l'absence de modification du workspace réel.

**Validation matérielle Chromebook toujours à effectuer par l'opérateur. Aucun pilote réel ne doit démarrer à cette livraison.**
