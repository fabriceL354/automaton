# Scout V12.5 — Control API + Event Layer

V12.5 ajoute une frontière HTTP locale, single-user/single-tenant, aux états
structurés V5–V12. Elle n'ajoute ni paiement, ni exécution, ni budget, ni outil.
Parent de développement : `f9bb831010bfb4ee07fd8c6c9d999bd8cd94a1f6`.
Aucune nouvelle dépendance. HTTP et cryptographie natifs Node ; moteur du dépôt
`>=20`, validation de livraison sous Node 22.14.0 et pnpm 10.28.1.

## Lancement et arrêt

Compiler avec `pnpm build`. Le workspace reste celui de Scout :
`~/.automaton/scout-workspace`. L'API ne crée jamais un ledger manquant.
L'initialisation financière éventuelle reste une opération explicite du CLI V5.

Fournir `SCOUT_CONTROL_API_TOKEN` avec un secret aléatoire généré et conservé par
l'opérateur : 32 à 256 caractères ASCII `[A-Za-z0-9_-]`. Aucune valeur par défaut,
aucune génération, persistance ou rotation automatique de ce jeton dans Scout.
Exemple de saisie Bash sans afficher le jeton ni l'inscrire dans l'historique :

```bash
read -rsp 'Jeton local : ' SCOUT_CONTROL_API_TOKEN
export SCOUT_CONTROL_API_TOKEN
SCOUT_MODE=control-api node dist/index.js
```

`--run` est également accepté ; tout autre argument de ce mode est refusé.
`SCOUT_CONTROL_API_HOST` doit être littéralement `127.0.0.1` (valeur par défaut).
`0.0.0.0`, `::`, `localhost`, adresse LAN et chaîne vide sont refusés.
`SCOUT_CONTROL_API_PORT` : entier décimal 0–65535, défaut 4317 ; 0 choisit un port
libre. La ligne de démarrage indique le port réel, le mode local et l'absence de
possibilité de dépense/exécution. Elle ne contient pas le jeton.

Arrêt : Ctrl+C / SIGINT ou SIGTERM. Les opérations déjà admises terminent sous le
verrou avant fermeture des sockets ; aucune écriture V6 n'est interrompue par
l'arrêt normal. Un verrou abandonné après crash n'est jamais volé automatiquement.

## Routes `/v1`

Toutes les routes sauf health exigent `Authorization: Bearer <jeton>`.
Les valeurs financières sont des entiers en cents, jamais des euros flottants.

| Méthode | Route | Réponse |
|---|---|---|
| GET | `/v1/health` | Santé du transport, schema 1, mode local, can_spend=false |
| GET | `/v1/summary` | Soldes V5, projets actifs, nombre d'attentions/approvals, dernière proposition |
| GET | `/v1/projects` | DTOs des projets V9 |
| GET | `/v1/projects/:projectId` | Un projet exact ou 404 |
| GET | `/v1/attention` | Projections d'attention actuelles, sans résolution implicite |
| GET | `/v1/events?after=0&limit=50` | Événements persistants après le curseur |
| GET | `/v1/allocation` | Proposition V12 authentifiée, ou `allocation: null` |
| GET | `/v1/approvals` | Demandes V6 autonomes, V6/V9 projets et V6/V8 externes |
| POST | `/v1/approvals/:requestId/approve` | Réponse humaine à une demande existante |
| POST | `/v1/approvals/:requestId/deny` | Refus d'une demande existante |

Le segment appelé approval dans l'URL identifie un **request_id V6**
`request-<UUID v4>`, déjà présent avant une décision. Il ne désigne pas l'approval_id
créé ensuite par V6. Les IDs projets sont `project-<UUID v4>` ; casse et format
exacts exigés.

Les listes projets/attention/approvals acceptent `offset=0..1000` et `limit=1..100`
(défaut 50), et renvoient `{schema_version, items, total, next_offset}`.
Les autres paramètres, paramètres dupliqués, encodages/traversals et corps GET sont
refusés. Les listes ne renvoient jamais une collection sans plafond.

Les POST acceptent uniquement `Content-Type: application/json` et un objet vide
`{}` (espaces JSON autorisés). Aucun champ montant, capacité, commande, chemin,
URL ou identifiant alternatif n'est accepté. Les clés inconnues, doublons JSON,
prototypes, NaN, Infinity, nombres financiers flottants et corps compressés sont
ainsi exclus du contrat. La réponse contient la demande actualisée,
`action_executed: false` et `money_spent_cents: 0`.

Il n'existe aucune route pay/execute/publish/shell/spend/reserve/capability/install,
ni route fichier, configuration, création de projet ou création d'approval.

## DTOs et sources

`control-snapshot.ts` lit sous le verrou V5 les stores existants, authentifie leurs
ancres et vérifie leurs vues et historiques. Le ledger reste l'autorité comptable ;
les modèles V9 sont reconstruits par le replay existant. Les résultats financiers
sont reliés aux confirmations V7/V9. Le learning et le monitoring sont vérifiés
par leurs propres mécanismes. Les données V9 ne sont pas copiées dans une seconde
base de projets.

Les DTOs ne reprennent que les champs choisis : IDs, enums, dates et nombres.
Aucun texte arbitraire de projet/action/hypothèse, credential, clé HMAC, URL privée,
chemin de workspace, rapport ou contenu de fichier n'est retourné. Les messages
d'événements sont fixes. Les résultats de projet encore inconnus sont `null`,
jamais des revenus ou dépenses inventés. Le nombre de projets actifs inclut les
états `reserved`, `approved` et `active` ; le détail expose le statut exact.
`attention_count` est un nombre d'attentions présentes, pas un nombre de messages
non lus : aucun état read/ack n'est implémenté.

L'allocation est la proposition sauvegardée, avec `stale`, ses entiers financiers,
projets proposés, candidats hors budget et références d'évidence. Ses montants sont
ceux du snapshot daté. Les soldes actuels se trouvent dans summary. Sa notice reste
`NO REAL MONEY WAS SPENT BY V12`. L'API vérifie les préfixes authentifiés V12 sans
recalculer, réserver ou modifier la proposition. Une proposition obsolète nécessite
une action explicite du CLI V12 ; ses anciennes alertes ne sont pas présentées
comme des demandes actuelles. Les alertes V6 viennent de l'état V6 actuel.

Les Attention Items V11.1 sont reconstruits avec `buildAttentionItems` après
validation des opportunités, demandes d'outils et indicateurs de sécurité. Ils
restent marqués `informational_research` : le fichier de recherche n'est pas une
preuve financière/approval authentifiée. Les textes bruts n'entrent pas dans les
DTOs. Un fichier de recherche invalide bloque les endpoints d'état, sans réparation
ni tentative réseau. Les sorties V12 valides sont marquées `authenticated_state`.

## Décisions humaines et idempotence

Le chemin est HTTP authentifié → adaptateur limité à approve/deny → parsers,
transitions et écritures V6 existants. Les adaptateurs ne sont pas des outils du
modèle. Ils n'acceptent pas de commande métier générique et ne changent jamais
`process.env.SCOUT_MODE` pour contourner un contrôle de mode.

- V6 autonome : demande courante exacte, historique/vues intacts, liaison V4/V5
  courante ; une clôture V7 rend la demande consommée.
- Projet : état V9 authentifié et demande V6 du projet ; aucune réservation ou
  activation. Un projet démarré, clos ou annulé n'est plus réapprouvable.
- Externe : demande V6/V8 courante, endpoint configuré correspondant, aucune
  tentative d'exécution antérieure. Aucun transport V8 n'est appelé.

La paire `(request_id, décision)` est la clé d'idempotence naturelle. Un retry de la
même décision encore admissible renvoie l'autorisation existante sans réécriture.
La décision opposée, un ID supplanté ou consommé, ou une liaison devenue obsolète
renvoie 409. Aucun header Idempotency-Key ni nouveau store de décisions n'est
nécessaire. Les refus natifs de replay du CLI historique restent inchangés.
Le champ historique `human_reference` conserve le format V6 `local-cli:...`, pour
préserver le schéma et les vérificateurs V6 ; il n'identifie pas le transport HTTP.
L'API est single-user et n'apporte aucune preuve d'identité multi-utilisateur.

Un échec d'écriture entre le journal V6 et ses vues reste bloquant et exige une
inspection humaine, comme avant V12.5. Si une décision est déjà durable mais que
sa projection/réponse échoue, elle n'est pas annulée ni exécutée : consulter l'état
puis réessayer la même décision après résolution du défaut. L'API ne promet pas une
transaction atomique commune entre plusieurs stores historiques.

## Event Layer

`control-events.ts` est un journal de **projections**, pas une nouvelle vérité
métier. Il réutilise `locked`, `readConfined`, `safePath` et `atomicWrite`.
Le store privé est voisin du workspace, sous `.scout-control-<hash du workspace>`.
Il n'est accessible ni via HTTP ni via les outils de fichiers confinés du modèle.

Les événements sont projetés lors des lectures authentifiées et des décisions.
Aucun watcher, intervalle, LLM, job autonome ou push externe. Les changements V9
sont rejoués depuis leur journal existant ; `PROJECT_COMPLETED` correspond
strictement à `close-experiment`, avec le résultat réel consultable dans le projet.
Une annulation n'est pas maquillée en réussite. Les demandes/attentions sont les
états observés au moment de la projection : une attention de recherche remplacée
entre deux polls peut ne jamais être observée. Le journal ne capture pas tous les
états intermédiaires d'une source qui ne possède elle-même qu'un snapshot.

Chaque événement contient :

```json
{
  "schema_version": 1,
  "event_id": "event-<sha256 du type et de la référence source>",
  "sequence": 158,
  "created_at": "2026-10-08T12:00:00.000Z",
  "event_type": "APPROVAL_REQUIRED",
  "severity": "warning",
  "subject_type": "approval",
  "subject_id": "request-<UUID v4>",
  "title": "APPROVAL_REQUIRED",
  "short_message": "Review the existing approval request. Authorization does not execute an action.",
  "requires_human_action": true,
  "source_ref": "request-<UUID v4>",
  "attention_id": "approval-attention-request-<UUID v4>",
  "authority": "authenticated_state",
  "payload": { "action_authorized": false, "capability_granted": false }
}
```

Types : APPROVAL_REQUIRED, HUMAN_INTERVENTION_REQUIRED, OUT_OF_BUDGET_OPPORTUNITY,
TOOL_REQUEST, PROJECT_UPDATED, PROJECT_COMPLETED. La séquence est l'ordre de
livraison durable ; created_at est la date canonique quand disponible, sinon la
date de première observation. Des événements anciens rattrapés peuvent donc avoir
une date antérieure avec une séquence plus récente. Le tri des nouveaux événements
est déterministe (date puis identité ASCII). Une ancienne alerte n'est pas une
preuve que l'action reste requise : reconsulter attention/approvals avant décision.

Le client appelle `/v1/events?after=157&limit=50`, traite `items`, conserve
`next_after`, puis poursuit tant que `has_more` vaut true. `latest_sequence` indique
le dernier numéro disponible. `after=0` commence au début ; curseur supérieur à
l'historique → 409 CURSOR_AHEAD, pour détecter notamment un mauvais workspace.
Le journal conserve les identités ; un redémarrage ne produit pas de doublon.
Le polling peut commencer à environ 5 secondes et ralentir lorsque l'app est en
arrière-plan. L'API ne lance pas une nouvelle recherche à chaque poll.

HMAC SHA-256, répertoire 0700, fichiers 0600, rejet symlinks/hardlinks, écriture
atomique + fsync + relecture. Un store partiel, falsifié, trop ouvert ou une clé
manquante provoque un refus, sans régénération ni récupération silencieuse.
Les checkpoints des historiques financiers, projets, observations, learning et
approvals détectent les retours en arrière par rapport aux préfixes déjà observés.
Comme les ancres précédentes, ce système ne protège pas d'un OS utilisateur
compromis ni de la restauration coordonnée de tous les fichiers/ancres à une ancienne
version : pas de compteur matériel externe.

## Limites et sécurité HTTP

| Élément | Plafond / choix |
|---|---|
| Corps décision | 1 024 octets, objet vide uniquement |
| Cible HTTP | 512 caractères ASCII, routes exactes |
| En-têtes | 8 192 octets, 32 headers ; doublons refusés |
| Connexions | 32, une requête par socket |
| Corps/headers/socket inactif | 5 secondes |
| File d'opérations | 8 en attente/exécution par serveur |
| Taille réponse | 256 Kio |
| Page | 1–100 éléments, défaut 50 |
| Journal événements | 1 024 événements et 1 Mio |
| Projets | 2 dans le batch V9 existant |
| Approbations | Bornes existantes V6/V8/V9 + pagination |

Le journal plein renvoie 503 EVENT_STORE_FULL. Il ne supprime aucun événement,
ne recycle aucun numéro et ne perd pas son index de déduplication. Une procédure
d'archivage/migration, avec changement explicite de curseur côté client, reste à
concevoir avant usage prolongé. Aucune route d'archivage ou reset n'est exposée.

La file sérialise les requêtes dans un processus. Le verrou V5 exclusif protège
les autres processus Scout/API ; contention inter-processus → 503, retry ultérieur,
sans vol de verrou ni états financiers contradictoires.

Jeton comparé via digests de longueur fixe et `timingSafeEqual`. Authentification
avant lecture des stores/corps sensibles. Aucun jeton dans logs, URLs, DTOs ou
erreurs. Host doit être `127.0.0.1:<port réel>`, adresses distantes autres que
127.0.0.1 et Origin sont refusées pour limiter rebinding et accès navigateur.
Aucun CORS permissif, aucune origine `*`, aucun endpoint préflight.
Réponses JSON, `Cache-Control: no-store`, `nosniff`, CSP restrictive.
Les erreurs applicatives sont `{error:{code,message}}`, fixes, sans stack, chemin
ou détail crypto. Les erreurs du parseur HTTP natif ferment la connexion avec une
réponse minimale. Health signifie serveur disponible, pas intégrité des stores.

Les plages 10 EUR/projet, 20 EUR/batch, deux projets, sept jours et les règles
V9/V12 demeurent inchangées. Lire une API peut écrire le journal de projections,
mais pas le ledger, les projets, les approvals ou la proposition V12.

## Frontière mobile et cloud

Une future application native peut consommer ces DTOs et le curseur sans connaître
les fichiers. Une app native n'a pas la contrainte CORS du navigateur, mais le
loopback d'un téléphone désigne le téléphone : **cette version ne permet pas un
accès direct au Scout du Chromebook depuis le téléphone**. Il faudra une nouvelle
étape explicite pour un transport distant authentifié et chiffré. Un navigateur
avec Origin est actuellement refusé, même pour une future UI locale.

Ne pas exposer ce serveur par proxy/tunnel/port public. Le cloud nécessitera une
conception distincte : TLS, identité, autorisation par utilisateur, isolation des
stores, rotation des secrets, limites partagées et exploitation. V12.5 n'active
aucune de ces fonctions et ne fournit pas de commutateur d'exposition publique.

Hors périmètre : comptes, multi-tenant, cloud public, OAuth, Firebase, stores
mobiles, push Android/Apple, SSE/WebSocket, read/ack, paiement, publication, shell,
accès direct à Ollama/workspace, création de capacités et autonomie supplémentaire.

## Vérification reproductible

```bash
pnpm build
pnpm vitest run src/__tests__/scout-control-api.test.ts src/__tests__/scout-event-layer.test.ts --maxWorkers=1 --minWorkers=1
node scripts/scout-v12-5-validation.mjs
pnpm vitest run src/__tests__/scout-allocation.test.ts src/__tests__/loop.test.ts src/__tests__/context-hardening.test.ts src/__tests__/scout-research-autonomy.test.ts --maxWorkers=1 --minWorkers=1
```

Pour la suite historique complète, activer le garde réseau existant :

```bash
NODE_OPTIONS="--import=$PWD/scripts/scout-offline-test-guard.mjs" pnpm vitest run --maxWorkers=1 --minWorkers=1
```

Certains tests historiques d'autres chemins tentent des appels externes ; ce garde
les bloque. Le script V12.5, plus strict, n'autorise que les connexions au port
exact du serveur temporaire sur 127.0.0.1, interdit fetch/Ollama/HTTPS/DNS externe,
compte les tentatives et exige zéro. Il crée un workspace fictif isolé, une
proposition V12, une approval V6 sans coût, vérifie les refus d'authentification,
les décisions/retries, le curseur/redémarrage et les octets inchangés du ledger
et de la proposition. Il nettoie ses fichiers et arrête son serveur.
Le PASS de ce script dans l'environnement de développement ne constitue pas un
test exécuté sur le Chromebook réel de l'opérateur.

### Résultats de livraison exécutés le 8 octobre 2026

- `pnpm build` : PASS (runtime et package CLI).
- Tests V12.5 : 122/122 PASS (98 HTTP/approvals + 24 événements).
- Allocation V12 : 89/89 PASS.
- Zones sensibles loop/context-hardening/research-autonomy : 283/283 PASS.
- Suite complète avec garde hors ligne, deux workers maximum : 80/80 fichiers,
  3 100/3 100 tests PASS, 85,53 secondes dans cet environnement.
- `node scripts/scout-v12-5-validation.mjs` : PASS sous Node 22.14.0 ; aucune
  tentative réseau sortante/Ollama, ledger et proposition V12 inchangés.
- Chromebook réel : non exécuté ici ; le script est livré pour ce contrôle.

Le premier essai de build avec le pnpm 11 global a échoué sur la configuration de
l'environnement (gestion automatique des dépendances/lien de node_modules).
Le build final ci-dessus utilise pnpm 10.28.1 déclaré par le dépôt et une copie
locale des dépendances ; aucun changement de dépendance ou de lockfile n'est livré.
