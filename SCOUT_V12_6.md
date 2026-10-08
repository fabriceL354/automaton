# Scout V12.6 — End-to-end pilot dry run

Parent exact : `bc0a932cb198658dc03d0a0c08a03863a5d2e761`
(`Fix V12.5 control API SIGTERM startup race`). Branche : `local-ollama-only`.

**DRY_RUN_ONLY — ALL FINANCIAL VALUES IN THIS PILOT ARE SIMULATED.**
**NO REAL MONEY WAS SPENT.** Le verdict de préparation technique n'autorise
aucune exécution réelle, même après une décision positive.

## Objectif et architecture

V12.6 orchestre les services canoniques ; aucun second ledger, project store,
approval gate, moteur de sélection, moteur learning ou event layer n'est créé.

| Étape | Autorité existante utilisée |
|---|---|
| Recherche offline | Parsing V11.1 `parseOpportunityPhases`, validation d'evidence/quotes, Attention builder, ingestion `researchCandidates` |
| Learning initial | V11 `list-hypotheses`, lecture authentifiée des sources disponibles |
| Allocation | V12 `runAllocationScout`, proposition signée et fingerprint natifs |
| Projets, réservations, actifs et résultats | V9 `runProjectScout`, replay `auditProjects`, ledger V5 |
| Décisions | V6, via les adaptateurs exact-ID V9/V8 de V12.5 |
| Action préparée et simulée | V8 `runExternalScout`, vérification V9 de scope, payload fixe et validation du transport |
| Monitoring | V10 `runMonitoringScout`, observations authentifiées |
| Résultats et evidence | Résultats V9 canoniques et lecteurs V7/V9 existants de V11 |
| Mise à jour learning | V11 création puis refresh d'une hypothèse, analyse du batch |
| Surface mobile | V12.5 `readControlSnapshot`, `syncControlEvents`, serveur HTTP et six GET réels |

V7 est l'autorité des résultats des anciennes expériences V4. Les projets V9
possèdent déjà leur propre clôture canonique, qui produit les écritures V5 et
les IDs consommés par V11. V12.6 utilise cette clôture, sans recopier un résultat
V9 dans V7 ni comptabiliser deux fois son revenu. Le lecteur V7 existant reste
vérifié par les sources V11 ; son chemin d'écriture autonome est couvert par
la compatibilité historique, pas par une troisième expérience fictive.

Le contexte hôte `AsyncLocalStorage` transporte uniquement le workspace, le
mode de service, l'horloge logique et le garde d'exécution. Les modes normaux
ne reçoivent ni horloge artificielle ni changement global de `SCOUT_MODE`.
Il s'agit de code hôte de confiance, jamais d'un outil accessible au modèle.

## Exécution et isolation

Pré-requis habituels : Node compatible avec le module natif `better-sqlite3`,
pnpm 10.28.1, dépendances installées et build effectué.

```bash
pnpm build
export SCOUT_MODE=pilot-dry-run
export SCOUT_PILOT_WORKSPACE="$(mktemp -d /tmp/scout-pilot.XXXXXXXX)"
node dist/index.js --run
node dist/index.js --status
```

Le root doit être explicite, absolu, normalisé et existant. Un nouveau scénario
exige un répertoire vide. `~/.automaton/scout-workspace`, ses descendants et
ses ancêtres sont interdits. Pas de chemins `..`, de symlinks dans le chemin,
de fichiers symlinkés ou de fichiers avec plusieurs hardlinks. Les ancres
HMAC et le mutex sont privés et voisins du workspace, selon les conventions
canoniques. Préserver le répertoire parent complet pour reprendre un scénario.
Les writers normaux refusent un workspace marqué comme pilote.

Aucun Ollama, Brave, wallet, credential, compte externe, publication ou paiement.
Aucune commande `--real`, `--pay`, `--spend`, `--publish`, `--live-money`.

## Scénario canonique

Capital fictif confirmé : **10000 cents**. Trois opportunités issues d'un replay
synthétique offline passent par les parsers V11.1 normaux. Aucun accès aux URLs
citées ; elles servent uniquement à la validation structurale de l'evidence.
A est `QUICK_SERVICE`, B `DURABLE_ASSET`.

| Candidat | Coût estimé | Sélection V12 | Expense simulée | Revenue expérience | Revenue post-expérience |
|---|---:|---|---:|---:|---:|
| A | 1000 | Oui | 700 | 1200 | 200 |
| B | 1000 | Oui | 800 | 400 | 0 |
| C | 3500 | Non, plafond dépassé | 0 | 0 | 0 |

V12 choisit A+B ; V12.6 vérifie le résultat sans réimplémenter le scoring.
La proposition reste `PROPOSAL_ONLY`, total 2000 cents. C ne crée qu'une
attention, aucune réservation, approval financière ou augmentation du plafond.
Les plafonds V9/V12 restent **2 projets, 1000 cents chacun, 2000 au total,
7 jours**. Capital final fictif : **10300 cents**, réservations restantes : 0.

Deux sale claims fictives de 99999 cents sont volontairement laissées non
réconciliées : elles ne deviennent ni capital disponible ni revenu confirmé.
Le résultat A est +500 à J7 et +700 lifetime ; B est −400. V11 conserve les IDs
et hashes de résultats, écritures, observations et evidence. L'hypothèse devient
`mixed`, avec deux observations indépendantes et une confiance très faible.
Ce n'est pas une validation de marché.

## Machine d'état et décisions

```text
CREATED → OPPORTUNITIES_READY → ALLOCATION_READY → PROJECTS_READY
→ APPROVALS_REQUIRED → APPROVED → ACTIONS_PREPARED → ACTIONS_SIMULATED
→ MONITORING → RESULTS_RECORDED → LEARNING_UPDATED → COMPLETED
```

`CREATED` représente le bootstrap ; le premier manifeste complet durable est
`OPPORTUNITIES_READY`. `status` distingue `RUNNING`, `WAITING_FOR_HUMAN`,
`COMPLETED`, `DENIED`, `BLOCKED`, `FAILED`. Les stages ne reculent pas ; des
préconditions canoniques empêchent un stage avancé incompatible. Chaque
transition métier correspond à une intention et exactement un reçu canonique.
Les refus et erreurs conservant un manifeste authentifiable sont rapportés
avec `NOT_READY_FOR_SUPERVISED_REAL_PILOT` et les raisons. Une corruption du
manifeste lui-même est refusée sans réécriture ni réparation.

Deux approvals projet V6 sont requises avant le démarrage. Chaque action V8
requiert ensuite sa propre approval, liée au projet et à l'expérience exacts.
Le runner ne décide jamais de lui-même. Pour fournir une décision explicite :

```bash
node dist/index.js --approve-simulated REQUEST_ID --subject-id SUBJECT_ID
# ou : --deny-simulated REQUEST_ID --subject-id SUBJECT_ID
node dist/index.js --resume
```

`SUBJECT_ID` est le project ID ou l'action ID indiqué par `--status`.
La décision traverse le mécanisme V6 et porte dans le manifeste la mention
`SIMULATED_HUMAN_DECISION`. Les formats historiques V6 restent inchangés.
Un double clic identique avant consommation est idempotent ; mauvais scope,
décision contradictoire et approval consommée sont refusés.

B sans décision met le scénario en attente, génère l'attention canonique et
n'exécute rien. Un refus projet annule le projet et libère sa réservation.
L'autre projet approuvé peut continuer. Un refus V8 clôt le projet concerné
comme cancelled, expense/revenue nuls, sans tentative. Un parcours refusé
n'obtient jamais le verdict READY.

## Manifeste, staleness et reprise

`pilot-dry-run.json` est une enveloppe HMAC liée au root ; elle contient les
références canoniques, le stage, des reçus de transitions, les décisions
explicites, une intention en attente et les fingerprints/counts des sources.
Elle ne constitue pas un store financier. `approval_ids` désigne les IDs des
requests V6 ; les décisions complètes restent dans leurs stores canoniques.

Avant la première création V9, l'inspection V12 doit être fraîche. Les propres
créations du pilote rendent ensuite la proposition initiale stale au sens V12.
Cette proposition est conservée et exposée comme telle. Chaque changement
suivant doit correspondre à l'intention signée attendue, aux préfixes des
historiques et au reçu canonique exact. Toute modification extérieure du ledger,
des projets, des reservations, de la recherche ou des autres sources bloque
le scénario. Aucun recalcul silencieux.

Une intention est fsyncée avant l'appel métier. Après interruption, si le reçu
canonique existe et que la différence des sources est exactement admissible,
il est adopté sans rappeler le writer. Sinon, seul un état source inchangé
permet de réexécuter l'appel. Les étapes terminées sont contrôlées sans effet.
Les tests tuent réellement des processus avec SIGKILL après allocation,
création d'approval, décision, simulation et résultat, avant le reçu manifeste.

La transaction mutex SQLite utilise la dépendance existante, sans table ni
données métier. Elle est libérée par l'OS en cas de décès. Sous ce mutex,
le pilote reprend le verrou V5 ; seul un ancien verrou dont le PID est
certainement mort peut être supprimé. PID vivant, inconnu ou réutilisé : refus.
Les autres modes conservent la règle V5 de non-récupération automatique.
Deux runners ne peuvent pas produire des effets concurrents.

**Limite intentionnelle :** une interruption au milieu d'une transaction
interne d'un ancien store peut laisser un état `prepared`, une vue incomplète
ou une intention V8 `uncertain`. V12.6 refuse alors toute réparation ou replay.
La reprise prouvée porte sur les frontières d'effets canoniques complets,
y compris avant leur accusé de réception par l'orchestrateur. Une coupure à
n'importe quel octet d'une transaction multi-fichiers n'est pas une garantie
introduite par V12.6.

## Transport, monitoring et réseau

V8 conserve son transport natif par défaut. Dans le contexte pilote, seul
`DryRunExternalTransport` est choisi ; aucun transport arbitraire ne peut lui
être substitué. L'endpoint fixe `.invalid`, la résolution synthétique et la
réponse en mémoire traversent les contrôles V8 existants. Le résultat canonique
est `simulated`, affiché `ACTION_SIMULATED — DRY_RUN_ONLY`.

Le garde contextuel bloque TCP hors du port exact de la Control API,
HTTPS, TLS, fetch, DNS public, UDP et sous-processus. Le port 11434 est interdit.
Une tentative bloquée est comptée durablement et empêche READY. Ce garde est
un tripwire de l'application ; il ne prétend pas isoler du code natif hostile.
Aucune dépendance du scénario ne nécessite de réseau externe.

V10 utilise son horloge injectable existante. Les checkpoints start/day_1/day_3/
day_5/deadline sont tous vérifiés par V10 ; pas de sleep ni attente réelle.
Les dates du ledger, des décisions et de V9 suivent la même horloge logique
confinée au pilote. Le revenu passif est enregistré à J8. `completed_at` est
une date logique ; la durée murale figure dans `validation-proof.json`.

## Control API, events et readiness

Le pilote démarre puis ferme proprement la Control API sur `127.0.0.1`, port
dynamique, token aléatoire de test. Il lit réellement health, summary, projects,
events, allocation et approvals, et les compare aux vues canoniques. Health et
summary identifient `DRY_RUN_ONLY` ; summary marque les valeurs simulées.
La proposition reste stale après les mutations attendues, sans état caché.

Les événements sont les projections V12.5 authentifiées, jamais des messages
inventés. La synchronisation aux points d'approval préserve la progression
observable : `APPROVAL_REQUIRED`, `OUT_OF_BUDGET_OPPORTUNITY`,
`PROJECT_UPDATED`, `PROJECT_COMPLETED`. Séquences ordonnées, IDs uniques,
aucun événement supplémentaire après redémarrage de l'API ou reprise complète.

`pilot-dry-run-report.json` contient les IDs, montants explicitement simulés,
références learning/evidence, plage de séquences, fingerprint initial et final,
invariants, warnings et raisons bloquantes. `real_money_spent_cents` reste 0.
Le premier achèvement demande une reprise de vérification ; `--resume` rejoue
les contrôles sans effet, valide l'idempotence puis permet READY si tous les
invariants passent. Un rapport est un constat sur son fingerprint et sa date,
pas une autorisation ni une garantie contre une corruption ultérieure.

## Validation

```bash
pnpm build
pnpm vitest run src/__tests__/scout-pilot-dry-run.test.ts src/__tests__/scout-pilot-safety.test.ts --maxWorkers=2 --minWorkers=1
node scripts/scout-v12-6-validation.mjs
pnpm vitest run src/__tests__/scout-control-api.test.ts src/__tests__/scout-event-layer.test.ts --maxWorkers=2 --minWorkers=1
pnpm vitest run src/__tests__/scout-allocation.test.ts src/__tests__/loop.test.ts src/__tests__/context-hardening.test.ts src/__tests__/scout-research-autonomy.test.ts --maxWorkers=2 --minWorkers=1
NODE_OPTIONS="--import=$PWD/scripts/scout-offline-test-guard.mjs" pnpm vitest run --maxWorkers=2 --minWorkers=1
```

Le build est nécessaire avant les tests de sous-processus qui utilisent dist.
Sur Chromebook, `--maxWorkers=1 --minWorkers=1` reste possible. Aucun corpus
massif, tokenisation de modèle, retry non borné ou attente calendaire.
Le script conserve son dossier temporaire et imprime son chemin : rapport,
preuves et stores sont inspectables. Il calcule l'empreinte du vrai workspace
avant/après, sans suivre ses symlinks ni y écrire. Les décisions automatiques
sont fournies explicitement par le script de validation, jamais par le runner.

## FIRST REAL PILOT - NOT IMPLEMENTED BY V12.6

Avant un vrai pilote : validation sur Chromebook de ce nouveau commit,
vérification humaine de la piste économique, de ses conditions, de ses coûts,
de sa méthode de mesure et de sa procédure d'arrêt. Un test Brave live séparé
et la conception du transport réel supervisé restent à faire.

Le futur pilote restera limité à deux projets, **10 € chacun, 20 € total**,
approbation humaine et **paiement humain**. Aucun credential bancaire ne sera
remis à Scout. V12.6 n'implémente ni cet exécuteur réel ni sa commande.

Aucune app Android, serveur cloud, multi-tenant, compte public, banque, Stripe,
crypto, marketplace, publication/email réels, login externe, Strategy Engine
V13, worker agent ou réplication autonome n'est ajouté.

## Résultats réellement exécutés dans Work — 8 octobre 2026

Environnement : Node 22.14.0, pnpm 10.28.1, module natif SQLite fonctionnel.

| Validation | Résultat |
|---|---|
| `pnpm build` | PASS |
| V12.6 dédié | 86/86 tests, 2 fichiers PASS |
| V12.5 Control API + Event Layer | 122/122 PASS |
| V12 allocation + loop + context-hardening + research-autonomy | 372/372 PASS |
| Scout historique | 1016/1016 tests, 12 fichiers PASS |
| Suite complète sous garde offline | 3186/3186 tests, 82/82 fichiers PASS, 102,07 s |
| Script `scout-v12-6-validation.mjs` | PASS, workspace réel inchangé |
| CLI compilé `SCOUT_MODE=pilot-dry-run … --resume` | PASS, READY |
| Exécution de V12.6 sur le Chromebook physique | NOT RUN dans Work |

Le garde de la suite historique bloque aussi des tentatives de réseau propres
à d'autres anciens tests. Le scénario canonique V12.6 n'en tente aucune : son
garde dédié compte zéro tentative interdite et ne tolère que sa Control API.
Le verdict observé est `READY_FOR_SUPERVISED_REAL_PILOT`, uniquement informatif.
