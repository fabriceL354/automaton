# Scout V14.4 — Observations économiques documentaires authentifiées

Base exacte : `3fa9873f63774a63b7644d127f9f282937a8117c`, dépôt `fabriceL354/automaton`, branche exclusive `local-ollama-only`. Aucun changement de `main`.

## Objectif, responsabilités et audit préalable

V14.4 enregistre des **informations et concordances documentaires**. Elle n'enregistre aucune écriture financière V5/V9, aucune réservation supplémentaire, aucun lancement, aucune vente/paiement/remboursement effectué par Scout et aucun encaissement bancaire indépendamment confirmé.

| Autorité existante | Fonctions auditées / responsabilité conservée |
| --- | --- |
| V5, `economic-ledger.ts`, `ledger-runner.ts` | `parseEconomicLedger()`, réservations/écritures autorisées, chaîne financière, disponibilité comptable et verrou `locked()` ; aucune écriture appelée par V14.4 |
| V9, `project-manager.ts`, `project-model.ts`, `project-store.ts` | `readProjectContext()`, `auditProjects()`, identités, autorisations et historique authentifié des projets ; non modifiés |
| V12.7 | `readPreparationSnapshot()`, `assertPreparationCapacity()`, `decodePreparation()` ; dossiers, preuves coût/marché, affectations et décisions exactes restent leurs autorités |
| V12.8 / V13 | `runPilotReadiness()`, `runOperationalPlanning()` ; contrôles/planifications non exécutables et arrêts terminalement protégés ; non modifiés |
| V14.1 | `simulateFictionalScenarios()` ; simulation pure, aucune preuve ou écriture réelle ; non modifiée |
| V14.2 | `runEconomicHandover()`, `assertHandoverInstalled()` ; transaction comptable locale et reçus exacts ; non modifiés |
| V14.3 | `runSellerAccount()`, `assertAccountWitness()`, `accountPreparationBlockers()` ; opérateur OS, attestations exactes, expiration/révocation et témoin séparé ; non modifiés |
| V10 / V11 | `loadObservationState()`, `readLearningSources()`, `buildProjectEvidence()`, `auditLearning()` ; historique observé et résultats comptables humains authentifiés, **sans preuve bancaire indépendante** ; aucune intégration V14.4 ajoutée |

Le nouveau journal documentaire n'a **aucun solde, capital disponible ou pouvoir financier**. Les chiffres qu'il calcule sont des synthèses d'informations déclarées/documentées ; V5/V9 restent les seules autorités comptables existantes. Aucun pont automatique vers l'apprentissage V11 ou les écritures de résultats V7/V9 n'est créé.

## Niveaux de preuve

1. `HUMAN_DECLARATION` : déclaration locale de l'opérateur, sans vérification indépendante.
2. `LOCAL_COMMERCIAL_ARCHIVE` : pièce JSON locale curée, dont les octets et les faits minimaux sont contrôlés. Cela ne vérifie pas sa véracité, son émission par une plateforme ni la propriété d'un compte.
3. Rapprochement : résultat déterministe `MATCH`, `INCONSISTENT` ou `INCOMPLETE`, avec empreinte des événements utilisés. `MATCH` signifie uniquement concordance documentaire sur les critères pris en charge.
4. Encaissement bancaire indépendant : **non implémenté et impossible à attribuer**. Source bancaire, flags de certification et commandes de confirmation bancaire refusés. Les synthèses exposent `bank_independently_confirmed: false` et `bank_independently_confirmed_receipts_cents: null`.

Une facture, un reçu, une capture ou une archive manuelle ne constitue pas une preuve bancaire indépendante. Le HMAC authentifie l'enregistrement local par le host ; le SHA-256 atteste les octets de la pièce, pas son authenticité commerciale.

## Modèle de données et saisie locale

L'opérateur doit déjà être initialisé par le mécanisme V14.3 existant. Aucune nouvelle identité/permission parallèle n'est créée. Son UUID et son UID OS sont vérifiés. Une personne partageant le même utilisateur OS n'est pas indépendamment authentifiée ; aucun fonctionnement multi-utilisateur n'est revendiqué.

Un événement lie : ID local d'idempotence, numéro de séquence, projet préparé et dossier exacts, candidat et empreintes d'entrée/recherche, opérateur, éventuelle liaison de compte et éventuel reçu V14.2, date UTC de l'événement, date d'enregistrement, source, montant entier en centimes, EUR, référence commerciale lorsqu'elle est connue, relation locale et référence commerciale parente, preuve éventuelle, hash de la photographie des sources, référence humaine et hash précédent.

Catégories : `expense`, `order`, `sale`, `invoice`, `receipt`, `platform_fee`, `payment_fee`, `refund`, `cancellation`, `payment_pending`, `payout`, `payout_receipt`. Les factures, reçus, commandes et justificatifs de versement sont des informations non additives au chiffre d'affaires : seule une ligne `sale` est comptée comme vente rapportée ; seul `payout` est compté comme versement rapporté.

Montants positifs, au maximum 1 000 000 000 centimes par information ; annulation informative : zéro. Aucun nombre flottant, montant négatif, `-0`, dépassement numérique ou autre devise. Les dates doivent être des ISO UTC canoniques, ne pas précéder la préparation et ne pas être futures lors de l'enregistrement. Les références commerciales doivent être réelles lorsqu'elles sont fournies ; `null` indique une inconnue, jamais un numéro inventé par Scout.

Le plafond de 10 EUR concerne le budget/engagement prévu, pas le chiffre d'affaires ou une observation. Une dépense rapportée de 12 EUR est conservée et signalée comme dépassement ; elle n'autorise pas ces 12 EUR et ne modifie aucun plafond ou fonds. Les plafonds historiques restent 1 000 centimes/projet, 2 000 centimes cumulés, deux projets et sept jours de planification.

Le journal est borné à 128 événements et 512 Kio. À saturation, refus sans troncature ni réinitialisation.

## Pièces confinées et métadonnées minimales

V14.4 accepte uniquement `documentary-evidence/<nom borné>.json`, 16 Kio maximum, UTF-8 valide. L'empreinte porte sur **les octets originaux**, avant décodage strict. Chemins absolus/traversées, symlinks, hardlinks, fichiers non réguliers, pièces absentes/altérées ou tailles excessives sont refusés.

Schéma exact d'une pièce curée : `version`, `source: OPERATOR_CURATED_COMMERCIAL_ARCHIVE`, `project_id`, `dossier_hash`, `kind`, `amount_cents`, `currency`, `occurred_at`, `commercial_reference`, `related_commercial_reference`, `related_event_id`. Les faits doivent correspondre exactement à l'information associée. Une référence locale relie les objets Scout ; une référence commerciale parente permet de vérifier leur concordance déclarée avec la référence du parent.

Aucun texte libre, URL, login, mot de passe, cookie, token, clé API, donnée de carte, IBAN complet ou document d'identité n'est demandé. Les champs supplémentaires et motifs sensibles connus sont refusés. L'opérateur reste responsable de ne jamais placer de secret déguisé dans une référence commerciale ; le mécanisme n'est pas un outil général de détection de secrets.

Les PDF, images/captures, exports CSV non structurés et documents bancaires bruts ne sont pas importés. Leur prise en charge sûre nécessiterait une mission séparée. Une extraction manuelle curée n'est pas présentée comme un original indépendant. Une date/référence inconnue ne doit jamais être inventée pour satisfaire le schéma.

Toutes les pièces historiques sont relues avant saisie et rapport, y compris celles d'informations documentées/supersédées. Leur chemin et leur SHA restent dans l'historique. Modifier/supprimer un ancien fichier bloque le rapport ; aucune empreinte n'est recalculée pour accepter une modification. Les documents ne sont jamais exécutés ni transmis à Ollama.

## Idempotence, pièces supplémentaires et corrections

- Même ID local et même portée/contenu : reçu historique, sans nouvel événement ni nouveau total.
- Même ID avec portée/contenu différent : conflit, sans écriture.
- Nouvelle ID dupliquant une vente de même référence commerciale ou une information identique : refus conservateur. Pièce réutilisée par un autre fait : refus.
- `operation: document` ajoute explicitement une pièce à la déclaration courante, avec mêmes faits et lien vers son ID exact. Elle devient documentée sans ajouter son montant une seconde fois.
- `operation: correct` remplace explicitement une déclaration humaine courante par une nouvelle déclaration de même catégorie/relation. L'ancienne ligne reste immuable ; seule la nouvelle ligne participe aux totaux courants. Il faut cibler la dernière révision exacte. Une pièce déjà documentée ne peut pas être réécrite par cette commande.

Un doublon véritable sans référence ni autre élément distinctif peut être indiscernable de deux opérations de même montant/date ; V14.4 refuse l'ambiguïté plutôt que fabriquer une référence ou doubler un total.

## Rapprochements pris en charge

Les demandes sélectionnent de deux à neuf IDs **courants** d'un même projet/dossier, dans un ordre explicite. Règles : `order-sale`, `sale-receipt` (facture ou reçu), `sale-fees`, `sale-refunds`, `payout-receipt`.

Contrôles : catégories, identité, références commerciales connues et cohérentes, relation locale exacte, ordre des dates, montants, pièces nécessaires et annulations. Les pairs ordre/vente, vente/reçu et versement/reçu doivent partager la même référence commerciale. Les frais/remboursements doivent référencer la vente par sa référence parente. Une demande de frais/remboursements doit sélectionner tous les composants courants liés à la vente ; omission : `INCOMPLETE`. Les remboursements partiels sont possibles ; un cumul supérieur à la vente est signalé comme incohérent.

Une vente déclarée et son reçu curé, ou un versement déclaré et son justificatif curé, peuvent former une concordance documentaire ; ils ne deviennent jamais des encaissements bancaires indépendants. Une concordance entre deux déclarations non documentées reste incomplète.

L'historique de rapprochement conserve son résultat initial et sa base hashée. Les rapports recalculent sa validité courante. Correction, annulation, nouvelle pièce/révision ou ajout d'un composant peut le rendre obsolète ; il n'est ni réécrit ni utilisé comme concordance actuelle. Les rapprochements agrégés entre plusieurs ventes, rapprochements bancaires et répartitions complexes d'un versement sont hors périmètre.

## Règles de synthèse

Les déclarations incluent les informations documentées : les deux colonnes sont des ensembles imbriqués, **jamais à additionner**. Totaux séparés : ventes brutes déclarées/documentées, dépenses, frais, remboursements, annulations, montants en attente et versements déclarés/documentés. Factures/reçus/commandes ne rajoutent aucun revenu ; versements ne rajoutent pas une deuxième vente.

Les ventes rapportées après annulation/remboursement sont calculées par vente : une vente annulée, directement ou via sa commande, contribue zéro ; autrement son montant est diminué de ses remboursements rapportés. Une annulation et son remboursement ne retranchent donc pas deux fois le même montant. Un remboursement excessif reste visible et rend la marge non calculable.

`partial_reported_margin_cents` = ventes rapportées après ces ajustements − frais rapportés − dépenses rapportées, sous réserve d'informations présentes et d'absence de conflit connu. `partial_documentary_margin_cents` n'est disponible que si les informations monétaires/annulations pertinentes sont documentées et sans incohérence connue. Les calculs intermédiaires utilisent des entiers/BigInt, sans arrondi monétaire.

Ces marges restent **partielles** : taxes, autres charges et frais/remboursements non signalés peuvent manquer. `real_net_profit_cents` demeure toujours `null`. Les éléments non rapprochés et les rapprochements obsolètes sont exposés. Une archive ou un versement rapporté ne prouve pas un solde disponible. Aucun revenu n'augmente le capital autorisé, ne libère une réservation ou ne recharge un budget.

## Identités V14.2, comptes V14.3 et apprentissage

Une information doit choisir explicitement `PREPARATION_ONLY` ou `V14_2_ACCOUNTING_IDENTITY`. Dans le second cas, le reçu V14.2 et ses liens V5/V9 sont relus par les contrôles existants ; s'il n'existe pas, refus. Scout ne crée pas d'identité pour rendre la saisie possible. Le statut affiché est `ACCOUNTING_RESERVATION_ONLY_NOT_LAUNCH`. Aucun mode « projet actif » ni calendrier d'expérience réelle n'est fabriqué.

Le suivi en préparation ne supprime aucun blocage V14.3/V13. Révocation/expiration d'un compte lié, dossier expiré, arrêt ou preuve suspecte refuse une nouvelle saisie/rapprochement. Les rapports historiques restent lisibles quand leurs sources/pièces sont intègres, avec les blocages courants. Une donnée déclarée peut décrire une action non autorisée sans créer son autorisation rétroactivement.

Les états/reçus V14.2, décisions V12.7, plans V13 et témoins V14.3 restent identiques après une écriture V14.4. Le nouveau journal n'entre pas dans leur empreinte de préparation ; une observation ne périme ni ne rafraîchit une demande de transfert. La simulation V14.1 reste séparée et les analyses V14.4 portent `authenticated_learning_eligible: false`. L'intégration au moteur d'apprentissage exige une mission séparée maintenant la provenance.

## Durabilité, reprise et sécurité locale bornée

Journal : `documentary-state.json` dans l'ancre V12.7 privée existante, HMAC avec sa clé existante et domaine V14.4 distinct. Témoin : répertoire privé séparé `.scout-documentary-witness-<hash du workspace>/receipt.json`, lié au workspace exact et à la dernière séquence. Répertoires 0700, fichiers 0600. Les écritures partagent le verrou V5 ; aucun vol/expiration automatique d'un verrou abandonné.

Avant commit : revalidation des sources et de l'opérateur, dossier/compte/arrêt/expiration, de l'entrée et des pièces, puis refus si changement. Un reçu signé contenant les images avant/après est engagé avec la primitive existante `atomicWrite()` (temporaire, fsync, rename, fsync du répertoire). **Ce reçu durable précède l'installation du journal documentaire**. L'installation synchronisée et relue est ensuite marquée complète.

Ce protocole ne prétend pas offrir deux renames physiquement simultanés. Tant que l'installation est incomplète, le mode documentaire bloque les nouvelles opérations et `--inspect` retourne `COMMITTED_DOCUMENTARY_RECOVERY_REQUIRED`. `--recover` installe uniquement les octets déjà engagés, si le fichier est exactement absent/avant/après selon la transaction ; toute troisième valeur bloque sans écrasement. Répertoire/témoin incomplet, absent lorsque requis, altéré, ancien ou journal incohérent : inspection humaine, aucune réinitialisation silencieuse.

La reprise peut finir une observation déjà engagée après arrêt/révocation/expiration ; elle ne crée aucune nouvelle permission. Les pièces et sources sont contrôlées à la relecture du rapport ; leur perte/altération reste bloquante. Un processus tué peut laisser le verrou : aucun effacement automatique. Les tests ne le retirent qu'après mort vérifiée du processus, dans leur fixture temporaire.

Le journal documentaire n'est aucune autorité financière. Son installation interrompue bloque **son utilisation**, sans importer un solde partiel dans V5/V9 ni réécrire leurs fichiers. Les autres mécanismes conservent leurs propres gardes et récupérations.

Le témoin détecte un ancien journal **uniquement lorsqu'il a été conservé intact**. Restaurer ensemble journal et témoin peut restaurer d'anciennes informations ; un test démontre explicitement cette limite. Les signatures locales ne prouvent pas une fraîcheur absolue. Compromission des clés/binaire/utilisateur OS et restauration concertée de toutes les ancres sont hors garantie. Filesystem local correct pour rename/fsync requis ; les tests de processus ne certifient pas toutes les coupures électriques.

## Commandes locales et validation Chromebook

Aucune route HTTP, outil IA, source bancaire/commerciale distante ou connexion Ollama n'est ajouté. L'API locale garde exactement ses frontières 127.0.0.1, Host/Origin/token/limites. Les fichiers d'entrée et le répertoire de pièces sont interdits à `write_file` du modèle.

Commandes descriptives, avec IDs réellement issus des vues locales, jamais des numéros commerciaux inventés :

```bash
SCOUT_MODE=economic-documentation node dist/index.js --inspect
# Préparer humainement documentary-event-input.json dans le workspace.
SCOUT_MODE=economic-documentation node dist/index.js --append OPERATOR_ID PROJECT_ID DOSSIER_HASH LOCAL_EVENT_ID
# Préparer humainement documentary-reconciliation-input.json.
SCOUT_MODE=economic-documentation node dist/index.js --reconcile OPERATOR_ID PROJECT_ID DOSSIER_HASH LOCAL_RECONCILIATION_ID
SCOUT_MODE=economic-documentation node dist/index.js --recover
```

`--pay`, `--publish`, `--start`, `--refund`, `--connect-bank`, `--login`, `--open-account` et `--confirm-bank` sont refusés. Aucun acteur économique réel ni pilote n'est lancé pour valider cette livraison.

Après import du commit, vérifier SHA/branche/arbre propre, puis utiliser un seul worker. Les fixtures enfants requièrent le build. Les tests emploient exclusivement des workspaces temporaires et des données synthétiques ; certains dossiers sont marqués non fictifs **dans ces fixtures uniquement** pour exercer leurs contrôles, sans certifier d'activité réelle.

```bash
git branch --show-current
git rev-parse HEAD
git status --short
node --version
pnpm --version
pnpm build
export NODE_OPTIONS="--import=$PWD/scripts/scout-offline-test-guard.mjs"
pnpm exec vitest run src/__tests__/scout-documentary.test.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run src/__tests__/scout-pilot-preparation.test.ts \
  src/__tests__/scout-pilot-readiness.test.ts \
  src/__tests__/scout-operational-planning.test.ts \
  src/__tests__/scout-fictional-simulation.test.ts \
  src/__tests__/scout-economic-handover.test.ts \
  src/__tests__/scout-seller-account.test.ts \
  src/__tests__/scout-ledger.test.ts \
  src/__tests__/scout-projects.test.ts \
  src/__tests__/scout-approval.test.ts \
  src/__tests__/scout-control-api.test.ts \
  --maxWorkers=1 --minWorkers=1
unset NODE_OPTIONS
git status --short
```

Ne pas utiliser le workspace économique réel pour tester une mutation. La validation Work ne remplace pas la validation matérielle Chromebook. Scout Invest, serveur/mobile, import de documents bruts, apprentissage autonome, rapprochement bancaire et autorisation de lancement restent hors périmètre.

## Fichiers et résultats de livraison

Créés : `src/agent/documentary-model.ts`, `src/agent/documentary-store.ts`, `src/agent/documentary.ts`, `src/__tests__/scout-documentary.test.ts`, `src/__tests__/fixtures/documentary-child.mjs`, `SCOUT_V14_4.md`.

Modifiés : `src/agent/ledger-runner.ts` (périmètre de verrou explicite), `src/agent/local-tools.ts` (entrées/pièces réservées à l'opérateur), `src/index.ts` (dispatch CLI local).

Validation finale Work : Node 22.16.0, pnpm 10.28.1, garde réseau active et un seul worker. Aucun délai, assertion, garde hors ligne ou seuil de sécurité n'a été affaibli.

| Contrôle | Résultat |
| --- | --- |
| `pnpm build`, bibliothèque et CLI | PASS |
| V14.4, passage ciblé final | 1 fichier, 108/108 PASS |
| Passage ciblé de compatibilité intermédiaire | 7 fichiers, 441/441 PASS (97 tests V14.4 à cette étape, puis extension à 108) |
| V12.7 / V12.8 / V13 / V14.1 / V14.2 / V14.3, dans la suite finale | 55 + 52 + 57 + 54 + 56 + 70 = 344/344 PASS |
| V5 / V9 / autorisations V6 / API, dans la suite finale | 61 + 109 + 64 + 98 = 332/332 PASS |
| Suite complète finale | 89 fichiers, 3 638/3 638 PASS, aucun test ignoré ; 573,91 s |
| Scripts hors ligne V12.7 / V12.8 / V13 | PASS |
| Diff Git et conservation des autorités financières, plans, transfert, comptes, apprentissage et API | PASS |

Les tests couvrent les 35 familles demandées : saisie sans preuve, pièces intègres/missing/altérées, encodage et confinement, doublons/rejeu, nombres/devise, identités/sources, frais/commandes/ventes/versements, remboursements partiels/totaux, annulation et corrections, rapprochements complets/incomplets/incohérents/obsolètes, arrêts/révocations, concurrence réelle, interruption avant engagement/après engagement/ACK perdu, reprise en nouveau processus et processus tué/verrou abandonné, HMAC/témoin/ancien état/restauration concertée explicitement hors garantie, absence de réseau/action bancaire/commerciale et autorité modèle/HTTP, compatibilités historiques et isolation fictive.

Le premier passage de développement (60/60), le passage de compatibilité (441/441), puis le passage ciblé étendu (108/108) ont réussi. Les contrôles finaux ont ensuite passé la suite complète sur le code stabilisé. Aucune opération réelle ni résultat économique réel n'a été produit. Validation matérielle Chromebook encore à effectuer ; les résultats Work ne la remplacent pas.
