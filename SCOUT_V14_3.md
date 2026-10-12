# Scout V14.3 — Comptes vendeurs existants, préparation locale bornée

Base exacte : `171b2e8418603be318041b27f0ec1d923be95708`, dépôt `fabriceL354/automaton`, branche exclusive `local-ollama-only`. Aucun changement de `main`.

Cette version reconnaît une **attestation humaine locale** concernant un compte vendeur déjà existant. Elle ne contacte aucune plateforme et ne vérifie indépendamment ni propriété, ni identité, ni banque, ni conformité contractuelle. Déclarer un compte ne donne aucun droit de l'utiliser.

## Modèle de menace et frontière de confiance

Les signatures HMAC locales ne prouvent pas la fraîcheur. L'audit préalable a montré qu'un ancien état authentique V12.7 peut être accepté après restauration. Cette limite est conservée explicitement.

V14.3 détecte la restauration de l'état de comptes et des décisions concernant ses dossiers **si le témoin séparé de dernière version demeure intact**. Elle détecte également un témoin ancien face à un état plus récent, un témoin absent lorsque l'état exige sa présence, une incohérence, une signature modifiée, des liens symboliques/hardlinks et une installation interrompue.

La garantie ne couvre **pas la restauration concertée de l'état et du témoin**, leur suppression concertée, la compromission de la clé HMAC, du binaire ou de l'utilisateur OS. Un test restaure ensemble état et témoin antérieurs à une révocation : l'ancienne validation redevient visible. Le résultat expose toujours `full_restore_protected: false`. Ces fichiers constituent une protection locale conditionnelle, jamais deux autorités indépendantes.

L'opérateur logique reçoit un UUID généré par le runtime et est lié au UID de l'utilisateur OS ayant initialisé le mécanisme. Cela évite les substitutions accidentelles de périmètre ; cela n'authentifie pas deux personnes partageant le même utilisateur OS. Cette version n'est pas une architecture multi-utilisateur et ne convient pas à une gestion financière autonome.

## Données et réutilisation de l'architecture

Le registre existant V12.7 conserve une extension optionnelle `seller_accounts`, signée avec **sa clé HMAC existante**. Elle contient l'opérateur, son UID, la date d'initialisation et au maximum 64 événements, huit déclarations. Chaque événement lie exactement : opérateur, compte opaque, plateforme, nom de plateforme de la source, candidat/fingerprint, projet, dossier/hash, empreintes d'entrée et de recherche, demande, date et expiration. Son hash référence l'événement précédent.

Le compte et la demande utilisent des UUID générés par Scout ; aucune référence de connexion saisie n'est acceptée. Les références humaines sont construites par le host local. Aucun login, email de compte, URL de boutique, texte libre, cookie, clé API, code 2FA, document d'identité ou donnée bancaire n'est demandé. Les arguments supplémentaires et plateformes non reconnues sont refusés.

Les attestations ne sont pas des permissions économiques V6/V9/V12.7. Elles réutilisent l'ancre, les primitives de validation exacte, les écritures durables et le verrou commun. Aucun second gate de paiement/publication/exécution ni registre financier n'est créé. Les demandes humaines d'action restent les demandes V12.7 existantes, initialement `pending`.

Le témoin est conservé séparément dans `.scout-account-witness-<hash du workspace>/receipt.json`, adjacent au workspace et distinct de l'ancre `.scout-preparation-<hash>/state.json`. Le workspace absolu exact est signé. Répertoires privés 0700, fichiers 0600. Le témoin référence la version exacte de `seller_accounts` **et les dossiers admis par compte**, y compris leurs décisions d'action et leur revue commerciale. Les décisions V12.7 concernant ces dossiers utilisent le protocole du témoin via `savePreparation()`.

Les projets antérieurs sans liaison de compte gardent leurs protections historiques ; V14.3 ne leur attribue pas rétroactivement une nouvelle garantie anti-restauration.

## Protocole durable, interruption et reprise

Toutes les opérations participent au verrou V5 `.economic-ledger.lock`, sans vol ni expiration automatique de verrou abandonné.

1. Vérifier témoin, état signé, sources authentifiées, preuves, horloge, arrêt et portée exacte.
2. Construire les images avant/après de l'état V12.7 et les vérifier avant toute installation.
3. Lors de la première initialisation, créer le répertoire privé du témoin et synchroniser son parent. Un répertoire incomplet reste bloquant et exige inspection humaine.
4. Engager un **unique reçu HMAC durable** dans le témoin : séquence, date, images avant/après, pin du contenu protégé, `installed: false`. `atomicWrite()` synchronise temporaire, rename et répertoire.
5. Installer exactement l'image après dans l'ancre V12.7, synchroniser/revérifier, puis enregistrer `installed: true` dans le témoin.

Il ne s'agit pas de deux renames simultanés. Le reçu durable est le point d'engagement logique ; tant que son installation est incomplète, les hosts économiques coopérants bloquent avant d'utiliser les états. `--inspect` indique `COMMITTED_RECOVERY_REQUIRED`. `--recover` accepte uniquement les octets avant ou après déjà engagés ; une troisième valeur bloque sans écrasement. Un reçu installé en conflit n'est jamais utilisé pour rétablir silencieusement un ancien état.

La reprise finit seulement une transaction déjà engagée. Elle peut la terminer après expiration ou arrêt sans créer de validation supplémentaire ni lever l'arrêt. Une révocation protectrice peut également être enregistrée après arrêt ; toute déclaration, validation ou admission nouvelle reste refusée.

Un processus tué peut laisser le verrou. Aucune suppression automatique n'est livrée ; inspection humaine obligatoire. Les tests retirent un verrou de fixture uniquement après constat de mort du processus. La durabilité dépend d'un filesystem local assurant correctement rename/fsync ; les tests ne certifient pas toutes les coupures électriques.

## États et décisions humaines

- `--initialize` : créer explicitement l'opérateur logique et le témoin ; un retry intact renvoie le reçu existant.
- `--declare` : attester manuellement l'existence du compte, créer une demande exacte en attente. Répéter renvoie le reçu, sans renouvellement.
- `--validate` : décision humaine distincte, portée exacte ; état `validated` pour préparation seulement.
- `--deny` : état bloqué `denied`, décision terminale.
- `--revoke` : état `revoked`, historique conservé ; l'ancienne demande ne peut plus être validée ou admise.
- Expiration : calculée à chaque contrôle à partir de l'échéance authentifiée, au plus sept jours et jamais au-delà de l'échéance du dossier. Aucun renouvellement ou événement d'expiration écrit automatiquement.
- `--new-declaration` : acte explicite distinct, uniquement pour remplacer une attestation terminale/expirée qui n'a pas été admise. Nouveau compte opaque, nouvelle demande ; aucun rejeu de l'ancienne demande. La revalidation d'un dossier déjà admis est volontairement non implémentée ; il reste bloqué après révocation/expiration.
- `--admit` : admission explicite supplémentaire, après validation. Elle prépare un dossier et son affectation V12.7 sous les plafonds existants ; aucun mouvement V5/V9.

## Interaction exacte avec `account_required`

`research.json` reste inchangé, avec `account_required: true` et sa provenance. V12.7 continue de bloquer l'admission habituelle de ces candidats. V14.3 fournit une admission locale distincte, après déclaration ET validation ET commande `--admit`.

Le candidat, son fingerprint, le dossier, les preuves présentes, les sources, l'expiration, la sélection d'allocation et la capacité sont relus. Une seconde revalidation précède le commit. Limites inchangées : deux projets, 1 000 centimes par projet, 2 000 centimes cumulés, sept jours. La disponibilité comptable V5 reste distincte du capital de référence de 10 000 centimes et d'un solde bancaire inconnu.

Plateformes initiales bornées : `etsy`, `payhip`, `itch-io`. La plateforme de recherche doit être exactement reconnue après normalisation limitée (`Etsy`, `Payhip`, `itch.io` acceptés). Une formulation ambiguë ou une autre plateforme reste bloquée ; aucune inférence IA ou sélection implicite.

L'admission est refusée si le batch possède déjà une supervision V12.8 ou un plan V13. Aucun plan historique ni ses empreintes ne sont réécrits pour intégrer rétroactivement un candidat.

Chaque dossier admis conserve `ACCOUNT_PREPARATION_ONLY_EXECUTION_FORBIDDEN`, même avec une attestation validée. Révocation et expiration ajoutent leurs blocages propres. Une attestation non courante bloque les nouvelles revues/décisions positives/déclarations V12.7 de son dossier ; une décision de refus demeure possible.

## Protections conservées et fonctions absentes

V5/V9 ne sont pas modifiés. Aucun paiement, achat, remboursement, encaissement, publication, offre, ouverture de compte, login, acceptation contractuelle, modification de profil/banque ou lecture privée de plateforme. Aucun client réseau commercial ni modèle Ollama n'intervient.

V14.2 conserve son protocole et ses autorisations exactes. Aucun fichier de son transfert n'est modifié. Les nouveaux dossiers liés à un compte restent bloqués pour ce transfert dans V14.3 ; le transfert des dossiers historiques sans compte conserve son périmètre. Toute modification de préparation peut également rendre obsolète une demande V14.2 en attente liée à son empreinte exacte ; aucune permission de transfert n'est renouvelée implicitement. Les plans V13 restent non exécutables et V14.1 reste une simulation isolée. Une modification d'attestation peut rendre un ancien plan V13 obsolète : aucune mise à jour implicite de ses pins.

Aucun outil IA et aucun endpoint HTTP de déclaration/validation/admission/reprise n'est ajouté. L'API conserve ses protections 127.0.0.1, Host, Origin, token, limites et refus des décisions V12.7. Aucun service Ollama n'est exposé.

Pas de commandes/ventes réelles, preuves bancaires, lancement des deux pilotes, Scout Invest, serveur/mobile ou multi-utilisateur. Le serveur nécessitera une autorité de fraîcheur indépendante des sauvegardes restaurables.

## Commandes locales descriptives

Les IDs et hashes doivent venir des vues locales actuelles. Ces placeholders ne constituent pas un compte réel ou un pilote à lancer.

```bash
SCOUT_MODE=pilot-preparation node dist/index.js --prepare
SCOUT_MODE=seller-account node dist/index.js --initialize
SCOUT_MODE=seller-account node dist/index.js --inspect
SCOUT_MODE=seller-account node dist/index.js --declare OPERATOR_ID OPPORTUNITY_ID DOSSIER_HASH etsy
SCOUT_MODE=seller-account node dist/index.js --validate OPERATOR_ID ACCOUNT_ID REQUEST_ID FINGERPRINT
SCOUT_MODE=seller-account node dist/index.js --admit OPERATOR_ID ACCOUNT_ID REQUEST_ID FINGERPRINT
SCOUT_MODE=seller-account node dist/index.js --revoke OPERATOR_ID ACCOUNT_ID REQUEST_ID FINGERPRINT
SCOUT_MODE=seller-account node dist/index.js --recover
```

Aucune commande ci-dessus ne contacte un compte vendeur. Aucun compte réel n'a été déclaré ni utilisé pendant le développement.

## Sauvegardes et inspection

Le témoin doit être préservé séparément des restaurations habituelles de préparation pour que la protection bornée fonctionne. Une sauvegarde/restauration concertée de toutes les ancres peut supprimer la connaissance d'une révocation ; elle n'est pas couverte. Ne jamais supprimer le témoin pour faire accepter une ancienne sauvegarde. Témoin absent/incomplet, conflit, HMAC invalide ou verrou abandonné : bloquer et inspecter humainement.

Un ancien binaire ne doit pas écrire un workspace enrichi V14.3 : son parseur strict ne connaît pas les extensions. Conserver le binaire de version correspondante et les ancres ; aucun import automatique ne réinitialise les historiques.

## Validation Chromebook, un worker

Vérifier branche, SHA de livraison et arbre propre. Les fixtures enfants nécessitent le build avant les tests. Les tests utilisent des workspaces temporaires synthétiques et ne valident aucune activité économique réelle.

```bash
git branch --show-current
git rev-parse HEAD
git status --short
node --version
pnpm --version
pnpm build
export NODE_OPTIONS="--import=$PWD/scripts/scout-offline-test-guard.mjs"
pnpm exec vitest run src/__tests__/scout-seller-account.test.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run src/__tests__/scout-pilot-preparation.test.ts \
  src/__tests__/scout-pilot-readiness.test.ts \
  src/__tests__/scout-operational-planning.test.ts \
  src/__tests__/scout-fictional-simulation.test.ts \
  src/__tests__/scout-economic-handover.test.ts \
  src/__tests__/scout-approval.test.ts \
  src/__tests__/scout-ledger.test.ts \
  src/__tests__/scout-projects.test.ts \
  src/__tests__/scout-control-api.test.ts \
  --maxWorkers=1 --minWorkers=1
unset NODE_OPTIONS
git status --short
```

Ne pas exécuter de commande de mutation sur un workspace réel pour tester l'installation. La validation Work ne remplace pas la validation matérielle Chromebook.

## Résultats et fichiers

Validation finale Work : Node 22.16.0, pnpm 10.28.1, SQLite 3.49.2, garde réseau active et un seul worker. Aucun seuil ou délai de test n'a été affaibli.

| Contrôle | Résultat |
| --- | --- |
| `pnpm build`, bibliothèque et CLI | PASS |
| V14.3, passage ciblé final | 1 fichier, 70/70 PASS |
| V12.7, dans la suite complète | 55/55 PASS |
| V12.8, dans la suite complète | 52/52 PASS |
| V13, dans la suite complète | 57/57 PASS |
| V14.1, dans la suite complète | 54/54 PASS |
| V14.2, dans la suite complète | 56/56 PASS |
| V6 autorisations / V5 registre / V9 projets / API locale, dans la suite complète | 64 + 61 + 109 + 98 = 332/332 PASS |
| Suite complète finale | 88 fichiers, 3 530/3 530 PASS, aucun test ignoré ; 344,10 s |
| Scripts hors ligne V12.7, V12.8, V13 | PASS |
| Diff Git et conservation des fichiers de logique V5/V9, V13, V14.1, V14.2 et API | PASS |

Les scénarios V14.3 couvrent déclarations, décisions exactes, substitutions, limites, révocation, expiration au commit, restauration avec témoin conservé, restauration concertée explicitement hors garantie, absence/falsification/ancienneté du témoin, interruptions avant/après installation et ACK perdu, reprise dans un nouveau processus, processus tué/verrou abandonné, concurrence, secrets rejetés, API et modèle sans capacité, arrêt pendant commit, autorisations V12.7 protégées, non-régression V14.2 et simulation V14.1 sur un workspace enrichi.

Un premier passage ciblé avait 52/57 succès : cinq injections d'interruption ne remplaçaient pas les exports filesystem utilisés par le runtime. Les mocks ont été corrigés pour atteindre ces appels. Le passage étendu suivant avait 65/68 succès : deux fixtures de capital n'avaient présenté qu'une demande effectivement admissible ; elles ont été remplacées par deux demandes distinctes de 10 EUR pour vérifier le refus de la seconde. Une fixture V14.2 utilisait une horloge artificiellement future par rapport aux timestamps V5 ; elle utilise maintenant l'horloge courante, comme le runtime V14.2 historique. Les contrôles de sécurité n'ont pas été désactivés. Le passage final ciblé (70/70) et la suite complète (3 530/3 530) ont ensuite réussi.

Aucun compte réel, paiement, publication, encaissement, transfert bancaire ou lancement n'a été réalisé. La validation matérielle Chromebook reste à effectuer ; elle n'est pas revendiquée par les tests Work.

Créés : `src/agent/seller-account-model.ts`, `src/agent/seller-account-store.ts`, `src/agent/seller-account.ts`, `src/__tests__/scout-seller-account.test.ts`, `src/__tests__/fixtures/account-child.mjs`, `SCOUT_V14_3.md`.

Modifiés : `src/agent/ledger-runner.ts`, `src/agent/pilot-preparation-model.ts`, `src/agent/pilot-preparation-store.ts`, `src/agent/pilot-preparation.ts`, `src/index.ts`.
