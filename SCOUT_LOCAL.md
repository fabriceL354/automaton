# Scout V3 Opportunity Scout (local-only)

Scout utilise Ollama local pour l’inférence et un workspace confiné pour ses
fichiers. V2 ajoute uniquement des lectures Web publiques HTTPS. Aucun Conway,
wallet, paiement, compte, authentification, publication, shell accessible au
modèle, JavaScript exécuté, navigateur interactif ou binaire téléchargé/exécuté.
Les requêtes Web sont exclusivement GET : aucun POST/PUT/PATCH/DELETE, formulaire
soumis, cookie, jeton, corps de requête ou référent.
L’API Ollama locale conserve son POST d’inférence ; ce POST ne va jamais au Web.

## Démarrer

Prérequis : Node.js 20+, pnpm 10.28.1, Ollama lancé localement et modèle installé.

```sh
pnpm install --frozen-lockfile
pnpm build
ollama pull qwen2.5:1.5b-instruct
mkdir -p ~/.automaton/scout-workspace
```

Créer `~/.automaton/scout-workspace/MISSION.txt`, par exemple :

```text
Recherche ce que recommande la documentation publique de Node.js sur les
versions LTS. Lis les sources proposées et rédige une synthèse courte en français
avec les limites de ton analyse. Enregistre la réponse dans rapport.txt.
```

Les requêtes **publiques** et les URLs de départ sont déclarées séparément de la
mission. Cette séparation est nécessaire pour empêcher l’exfiltration des
fichiers locaux par un modèle ou une page malveillante : Scout ne peut jamais
construire une requête ou une URL avec du texte lu dans le workspace.

```sh
SCOUT_PUBLIC_QUERIES='["Node.js official releases LTS documentation"]' \
SCOUT_PUBLIC_URLS='["https://nodejs.org/en/about/previous-releases"]' \
node dist/index.js --run
```

L’opérateur ne doit mettre que des données destinées à être publiques dans ces
variables, jamais de secret, token, contenu de fichier privé ou mission sensible.
Le runtime n’extrait aucune requête ni URL automatiquement de `MISSION.txt`.
Ces variables ne chargent aucun fichier et ne peuvent pas être modifiées par
Scout. Sans elles, les fichiers locaux continuent de fonctionner, mais aucun
site ni moteur de recherche n’est accessible au modèle.

| Variable | Contrat |
| --- | --- |
| `SCOUT_PUBLIC_QUERIES` | Tableau JSON, maximum 3 requêtes publiques exactes, chacune de 1 à 500 caractères sans caractères de contrôle |
| `SCOUT_PUBLIC_URLS` | Tableau JSON, maximum 5 URLs HTTPS publiques de départ, chacune de 1 à 500 caractères |

Une URL lue doit provenir de cette liste ou être l’URL exacte d’un résultat de
`web_search`. Le modèle ne peut pas ajouter de paramètres, encoder des données
locales dans un chemin, changer le domaine ni fabriquer une URL. Les liens
arbitraires trouvés dans le corps d’une page ne sont pas ouverts automatiquement.
Les redirections du serveur sont vérifiées par la couche réseau.

## Outils et validation

Seuls les six outils suivants sont acceptés. Chaque outil a son propre objet
JSON minimal, sans champs inutilisés :

```json
{"tool":"list_files"}
{"tool":"read_file","path":"MISSION.txt"}
{"tool":"write_file","content":"La réponse complète à la mission."}
{"tool":"web_search","index":0}
{"tool":"read_search_result","index":0}
{"tool":"read_public_url","index":0}
```

Chaque ligne illustre une action indépendante. `index` est un entier sûr positif
ou nul, strictement inférieur au nombre d’éléments de la liste correspondante.
Les autres champs sont des chaînes. Aucune propriété supplémentaire ni coercition
n’est acceptée. Le runtime traduit les index en requêtes/URLs autorisées : le
modèle ne peut fournir ni requête ni URL. Les anciens outils Web textuels sont
refusés. Le texte libre et Markdown ne sont jamais interprétés comme commandes.
Ollama utilise toujours `format:"json"`, sans schéma contraint.

Les requêtes et URLs publiques sont numérotées au démarrage. Après chaque recherche,
le modèle reçoit une liste courte de titres/extraits avec index ; les URLs restent
côté runtime. Les résultats s’ajoutent à une liste stable (au maximum 15 résultats,
avec les 3 recherches autorisées). `read_search_result` utilise cette liste ;
`read_public_url` utilise uniquement `SCOUT_PUBLIC_URLS`.

Le runtime indique l’étape suivante après chaque outil ou rejet. Si des entrées
Web sont fournies, aucune écriture de `rapport.txt` n’est autorisée avant la lecture
réussie d’une page contenant du texte utile. Une recherche seule, une erreur ou une
page vide ne débloque pas le rapport. Aucun rapport de remplacement n’est écrit
si une étape Web obligatoire échoue : l’exécution se termine immédiatement en erreur.
Les sélections/rédactions invalides restent bornées à 12 appels au modèle. Sans entrée
Web, le rapport local reste autorisé. Un ancien rapport ne satisfait pas ce garde.

`write_file` accepte exclusivement `tool` et `content`, sans `path`.
Tout champ `path` est refusé avant exécution, y compris `MISSION.txt`, `rapport.txt`
ou un autre fichier. Le runtime fournit toujours le chemin fixe `rapport.txt`
à l’outil interne, dont le contrat et les protections restent inchangés.
Après lecture Web utile, le runtime passe à la rédaction dédiée décrite ci-dessous :
le modèle fournit uniquement `content`, sans action. Le modèle n’a aucun choix de
destination d’écriture.
Les Sources sont ajoutées par le runtime, et l’arrêt reste immédiat après
relecture d’un rapport valide et non vide.

Le prompt ne présente aucune valeur d’exemple pour `content`. Après une lecture
utile, le runtime demande `write_file` avec une réponse originale fondée sur les
données lues. Avant écriture, puis après relecture confinée, il contrôle le corps
du rapport sans la section Sources : texte vide, placeholders connus, copie de
`MISSION.txt` (casse/espaces normalisés) et simples annonces de statut sont refusés.
Un refus avant écriture préserve le rapport existant, demande un nouvel essai et
consomme un tour. Une section Sources seule ne permet jamais le succès.
Ces contrôles ciblent les formes connues ; ils ne garantissent pas à eux seuls
l’exactitude factuelle ni la qualité de toute réponse originale.

Pour diagnostiquer un rejet sur la machine locale, activer facultativement
`SCOUT_DEBUG_ACTIONS=1`. Seule la réponse brute rejetée par la validation d’action
(JSON invalide inclus, ou index/étape non autorisé) est affichée sur stderr local.
Les actions acceptées ne sont pas affichées par ce diagnostic. Aucun fichier de
journal, appel réseau ni journal externe n’est ajouté. Le texte affiché peut
contenir du contenu proposé par le modèle. Par défaut le diagnostic est désactivé
(variable absente ou `0`) ; toute autre valeur que `0` ou `1` est refusée.

Le workspace reste `~/.automaton/scout-workspace`. Chemins absolus, sorties du
workspace, liens symboliques et fichiers avec plusieurs liens physiques sont
refusés. Les fichiers sont limités à 128 Kio et `MISSION.txt` est protégé contre
l’écriture par Scout. Ne pas modifier simultanément le workspace depuis un
processus extérieur.

Le texte du Web est considéré comme des données non fiables, jamais comme des
instructions donnant des droits. Il n’est ni exécuté ni transmis à un service
externe : il est synthétisé par Ollama local. Une page ne peut pas ajouter un
outil, une requête publique, un header, des identifiants ou une URL construite
par le modèle aux capacités autorisées.

## Réseau et limites par exécution

| Protection | Limite |
| --- | --- |
| Protocole / port | HTTPS uniquement, port 443, sans identifiants ni mot de passe |
| Adresses | Refus de localhost, loopback, privé, link-local, multicast, réservées/documentation, IPv4 mappé et tunnels IPv6 |
| DNS | Toutes les réponses doivent être publiques ; adresse validée fixée sur la connexion TLS, sans seconde résolution |
| Redirections | Maximum 3 par lecture ; contrôle URL et DNS à chaque saut, y compris changement de domaine |
| Timeout Web | 15 secondes pour toute la lecture, DNS/connexion/redirections/corps compris |
| Taille par réponse | 256 Kio maximum, vérifiés en en-tête et en streaming |
| Budget de corps téléchargés | 1 Mio cumulé ; arrêt dès dépassement et aucune nouvelle requête après épuisement |
| Recherches | Maximum 3, échecs inclus |
| Pages | Maximum 5, échecs inclus |
| Résultats par recherche | Maximum 5, titre/URL/extrait structurés |
| Texte transmis au modèle | Maximum 6000 caractères par page, HTML/scripts/styles retirés |
| Tours du modèle | Maximum 12, actions refusées comprises |

Un échec réseau/DNS, une réponse non reconnue ou une limite dépassée est refusé.
Seuls `text/html` et `text/plain` UTF-8/ASCII sont lus. PDF, images, archives,
binaires, scripts, JSON, compression et autres MIME sont refusés. Aucun sous-
fichier, image, script ou ressource d’une page n’est téléchargé.

L’API Ollama est séparée de la couche Web : elle reste limitée aux IP loopback
`127.0.0.1` et `::1`. `localhost` est normalisé en `127.0.0.1` et ses redirections
HTTP sont refusées. Utiliser un Ollama local de confiance, sans modèle cloud ni
proxy vers un service distant.

## Fournisseur de recherche

`SearchProvider` reste l’interface commune. Le registre accepte
`SCOUT_SEARCH_PROVIDER=none` (défaut), `duckduckgo-lite`, `searxng` ou
`duckduckgo-html`.
Aucun fournisseur n’est choisi automatiquement ni remplacé après un blocage.
La lecture directe via `SCOUT_PUBLIC_URLS` reste disponible sans moteur.

DuckDuckGo Lite est disponible par sélection explicite :

```sh
SCOUT_SEARCH_PROVIDER=duckduckgo-lite \
SCOUT_PUBLIC_QUERIES='["votre requête publique"]' \
node dist/index.js --run
```

Le runtime construit uniquement `q` à partir de la requête déjà autorisée vers
l’endpoint fixe `https://lite.duckduckgo.com/lite/`. HTTP 200 et `text/html` sont
obligatoires ; la destination finale doit rester sur cet endpoint. Le parseur
reconnaît les liens de classe `result-link`, décode les wrappers DuckDuckGo `uddg`,
filtre les URLs avec `publicHttpsUrl`, élimine les doublons et fournit au maximum
5 résultats (titres 200 caractères, extraits `result-snippet` 400 caractères).
Aucun lien de navigation DuckDuckGo n’est utilisé comme résultat. CAPTCHA,
challenge, page inhabituelle, HTTP 202 et zéro résultat utilisable donnent un échec
sans nouvel essai automatique ni fallback. Les tests sont simulés uniquement.
Le test matériel fourni par l’opérateur a confirmé HTTP/1.1 200 et `result-link`
pour une requête de test ; cela ne garantit pas la disponibilité pour toute requête.
La lecture des destinations garde les vérifications DNS/pinning/SSRF et budgets.

SearXNG est une alternative maintenable grâce à son API GET documentée :
https://docs.searxng.org/dev/search_api.html
Cependant beaucoup d’instances publiques désactivent JSON ou limitent les robots.
Aucune instance publique généraliste suffisamment fiable n’a été validée ici :
le fournisseur est donc **optionnel**, sans promesse de disponibilité. Choisir
explicitement une instance gratuite, sans compte/authentification, dont l’opérateur
autorise l’usage anonyme de cette API. Scout ne découvre pas d’instances et ne
les fait pas tourner pour contourner des restrictions.

```sh
SCOUT_SEARCH_PROVIDER=searxng \
SCOUT_SEARXNG_URL='https://votre-instance-publique-autorisée.example' \
SCOUT_PUBLIC_QUERIES='["votre requête publique"]' \
node dist/index.js --run
```

L’URL de configuration doit être une origine HTTPS publique sans identifiants,
chemin, paramètres ou fragment. `/search?q=...&format=json` est construit uniquement
par le runtime à partir d’une requête publique déjà approuvée. Seuls HTTP 200 et
`application/json` sont acceptés pour cette API ; cette autorisation MIME spécifique
ne s’applique pas aux lectures de pages. Tous les contrôles DNS/SSRF/redirections,
timeouts, limites d’octets et compteurs de recherche restent partagés. Une
redirection finale vers une autre origine est refusée comme résultat de recherche.
Les titres/extraits sont convertis en texte et limités ; les URLs sont contrôlées
avant de devenir des résultats indexés, puis contrôlées de nouveau avant lecture.

DuckDuckGo HTML reste disponible uniquement par choix explicite pour compatibilité,
mais le test matériel a montré HTTP 202 sans résultats reconnus. Ce statut est
refusé, même si le corps ressemble à des résultats. CAPTCHA, HTTP 403/429/202,
JSON/HTML inattendu, absence de résultat utile ou réponse trop volumineuse donnent
un échec propre. Aucun contournement, cookie, navigateur, JavaScript, formulaire,
POST, clé API, service payant ou fallback automatique n’est utilisé.

Les tests des fournisseurs et du réseau sont entièrement simulés, sans Internet.
Si la recherche échoue, utiliser des URLs publiques connues approuvées ; le rapport
reste bloqué tant qu’aucune page utile n’a été lue. Cette limitation concerne la
recherche générale, pas la lecture HTTPS directe déjà validée sur la machine.

## Rapport et sources

`MISSION.txt` est chargé automatiquement au démarrage. Le modèle doit répondre
réellement à la mission, et expliquer les informations manquantes ou capacités
indisponibles au lieu de prétendre avoir réussi.

La section `Sources` est construite par le runtime, à partir des pages ou pages
de résultats du moteur effectivement lues avec succès. Une URL de résultat non
ouverte n’est pas une source consultée. Les redirections donnent l’URL finale.
La section proposée par le modèle est remplacée et les URLs HTTP(S) non
consultées dans le texte sont retirées. Sans consultation réussie, le rapport
l’indique ; aucune source n’est inventée. Le runtime ne garantit pas la qualité
factuelle de la synthèse du petit modèle.

Scout termine immédiatement après `write_file` réussi sur `rapport.txt`, relecture
confinée et vérification d’une réponse non vide. La seule section Sources ne
suffit pas à transformer un rapport vide en succès. Aucun `finish` ni autre appel
au modèle n’est nécessaire. Un ancien rapport ne suffit pas.

## Réglages CPU et inférence

Le défaut reste `qwen2.5:1.5b-instruct`, avec `format:"json"` d’Ollama et validation
stricte côté runtime. Un modèle cloud ou un ancien choix Gemma n’est pas utilisé
comme fallback. Pour le choix rapide manuel :

```sh
ollama pull qwen2.5:0.5b-instruct
SCOUT_MODEL=qwen2.5:0.5b-instruct node dist/index.js --run
```

| Variable | Défaut | Plage autorisée |
| --- | ---: | ---: |
| `SCOUT_NUM_CTX` | 2048 | 512 à 8192 tokens |
| `SCOUT_NUM_PREDICT` | 256 | 64 à 2048 tokens, enveloppe JSON comprise |
| `SCOUT_TIMEOUT_MS` | 300000 | 1000 à 1800000 millisecondes, par requête Ollama locale |

Les entiers doivent être décimaux canoniques, sans espaces, signe, décimales,
exposant ni zéro initial. Une variable vide ou invalide arrête Scout avant
l’inférence. Conserver des missions et rapports courts avec les valeurs par
défaut ; les pages et l’historique consomment aussi le contexte de 2048 tokens.
Ces réglages ne constituent pas une garantie de consommation mémoire sur 3 Go.
Les commandes historiques wallet/provisionnement/setup restent bloquées.

## Vérification sans Internet

```sh
git diff --check
pnpm build
pnpm exec vitest run src/__tests__/scout-local.test.ts src/__tests__/scout-web.test.ts
pnpm exec vitest run src/__tests__/scout-opportunity.test.ts
```

Les tests simulent HTTP, DNS, redirections, SSRF, limites, timeouts, MIME,
recherche, extraction, exfiltration refusée, validation des actions, sources et
parcours mission → recherche → lecture → rapport. Ils ne dépendent pas d’Internet.

## Langue du rapport (V2.1)

Les consignes explicites `en français`, `in French`, `en anglais` et `in English`
sont reconnues localement, sans distinction de casse/accents. Sans consigne claire,
ou avec des consignes contradictoires/négatives, aucune langue n’est imposée.
Le runtime rappelle la langue au démarrage, après chaque lecture et dans les
retours avant rédaction/reprise. La langue des sources ne change pas la consigne.

Avant toute écriture, puis après relecture, une heuristique locale examine le
corps du rapport hors Sources, URLs, code et citations explicites. Elle refuse
uniquement des indices forts de prose entièrement dans l’autre langue : au moins
6 occurrences et 4 mots courants distincts, sans indice de la langue demandée.
Le refus préserve le rapport existant et demande une nouvelle réponse dans la
langue demandée. Les textes courts, techniques ou mixtes restent acceptés pour
éviter les faux positifs. Ce contrôle léger n’est pas une détection linguistique
complète ni une garantie de traduction ; aucun texte n’est envoyé à un service
externe. Le diagnostic local `SCOUT_DEBUG_ACTIONS=1` affiche aussi les actions
rejetées pour langue incorrecte. L’architecture et les budgets Web sont inchangés.

## Contrôleur des étapes Web obligatoires

Avec au moins une requête publique, le runtime exécute `web_search` sur l’index 0
avant tout appel à Ollama. Il ne demande jamais au modèle de déclencher cette
recherche initiale. Échec de recherche ou absence de résultat : arrêt en erreur,
sans rédaction, sans fallback vers une autre requête, URL ou fournisseur.

Avec un résultat unique, le runtime lit automatiquement son index 0. Avec plusieurs
résultats, un prompt court demande seulement `read_search_result` et un index.
Le runtime refuse toutes les autres actions pendant cette sélection, y compris
`write_file`, les fichiers locaux et une nouvelle recherche. Un index invalide
ne déclenche aucune lecture ; le modèle peut réessayer dans la limite des tours.
Après la sélection valide, le runtime lit la source avant de passer à la rédaction.
Un échec ou une page vide termine immédiatement l’exécution sans rapport.

Avec des URLs publiques mais aucune requête, la première URL est lue automatiquement.
Sans entrée Web, le mode de rapport local reste disponible. Après une source utile,
le modèle reçoit le texte comme données non fiables et la consigne de langue dans
un appel dédié à la rédaction, avec uniquement un champ `content`. Sources, validation du rapport,
confinement et arrêt immédiat restent inchangés. Les lectures/recherches automatiques
consomment les mêmes budgets Web ; le choix d’index et la rédaction partagent les
12 appels maximum à Ollama. Aucun droit supplémentaire n’est accordé au modèle.

## Rédaction Web dédiée et déterministe

Après une lecture Web utile, le runtime quitte le protocole d’actions et lance
un appel Ollama dédié à la rédaction. Il fournit uniquement un prompt court,
`MISSION.txt`, les données de la source lue (non fiables) et le rappel de langue.
L’historique de sélection et les exemples d’actions ne sont pas inclus. La sortie
utilise toujours `format:"json"`, avec un seul champ obligatoire `content` de type
chaîne. Toute action, champ `tool`/`path`, propriété supplémentaire, mauvais type,
texte libre ou JSON invalide est refusé ; aucune réponse n’est exécutée comme commande.

Le runtime valide le contenu et la langue, construit lui-même Sources, puis appelle
l’outil interne avec le chemin fixe `rapport.txt`. Il relit ensuite le fichier,
vérifie l’égalité avec le texte écrit ainsi que le contenu/langue, et s’arrête
immédiatement avec succès. Une erreur d’écriture ou de relecture termine en erreur.

Une sortie invalide, un placeholder ou une langue manifestement incorrecte demande
une nouvelle rédaction sans refaire la recherche ni la lecture. Le maximum est de
3 tentatives de rédaction (premier essai inclus), limité aussi par le budget restant
des 12 appels à Ollama. Épuisement : erreur, aucun nouveau rapport écrit, rapport
précédent préservé. Le debug local affiche seulement les sorties brutes rejetées.
Qwen2.5 1.5B, les réglages Ollama et les budgets/protections Web restent inchangés.
Sans entrée Web, le protocole local d’actions reste disponible.

## V3 — Opportunity Scout (opt-in)

Le mode économique est désactivé par défaut. L’activer explicitement avec
`SCOUT_MODE=opportunity` ; sans cette variable Scout conserve le parcours local
ou Web V2.1. Ce mode produit deux fichiers confinés à
`~/.automaton/scout-workspace` : `opportunities.json` (données structurées) puis
`rapport.txt` (résumé humain). Le modèle local n’exécute aucune action : le
runtime fait les recherches, lit automatiquement quelques pages, valide les
données, calcule les scores et écrit les fichiers.

```sh
SCOUT_MODE=opportunity \
SCOUT_BUDGET_EUR=100 \
SCOUT_SEARCH_PROVIDER=duckduckgo-lite \
SCOUT_PUBLIC_QUERIES='["services locaux sans investissement"]' \
node dist/index.js --run
```

`SCOUT_BUDGET_EUR` est un entier positif (défaut `100`, maximum `10000`).
`SCOUT_COUNTRY` et `SCOUT_CONTEXT` sont des indications facultatives fournies
explicitement par l’opérateur ; Scout ne géolocalise jamais la machine et ne
construit aucune requête supplémentaire. `SCOUT_PUBLIC_QUERIES` reste l’unique
origine des recherches, et des `SCOUT_PUBLIC_URLS` peuvent aussi fournir des
pages publiques approuvées. Les recherches, pages, octets, redirections,
HTTPS, DNS et épingles réseau réutilisent strictement les budgets et contrôles
V2. Un échec Web arrête le mode sans rapport.

Après les lectures réussies, Qwen reçoit uniquement le texte borné des sources
comme données non fiables et renvoie un JSON d’analyse sans outil ni chemin.
Chaque opportunité doit avoir exactement les champs documentés par le runtime :
nom, résumé, coût de démarrage, délai, temps hebdomadaire, difficulté, risque,
potentiel de marge, scalabilité, besoins de compte/service payant, risques,
trois premières étapes et `evidence_source_indexes` (index des sources lues,
commençant à zéro). Les types, longueurs, scores 1–5, coûts (au plus le budget),
index de sources et maximum de cinq opportunités sont validés avant toute
écriture. Une analyse vide est conservée comme « aucune opportunité viable » ;
elle ne devient pas une promesse.

Le score 0–100 est calculé exclusivement par le runtime à partir du coût,
rapidité, risque, marge, scalabilité et difficulté. Les opportunités sont triées
déterministiquement et le résumé montre le top 3, les risques, les hypothèses et
les données manquantes. La première expérience est plafonnée à 10 € et n’est
jamais exécutée par Scout. Les revenus ne sont jamais garantis. `Sources` est
ajouté par le runtime à partir des URL effectivement lues ; aucune source ou
affirmation non reliée à un index de preuve n’est considérée comme vérifiée.

Le mode n’ajoute aucun shell, réseau arbitraire, compte, authentification,
paiement, wallet, publication, formulaire, POST externe ou agent enfant. Le seul
POST est l’appel local à Ollama sur la boucle locale, comme en V2. Les tests V3
simulent entièrement les réponses HTTP et Ollama et vérifient budget, validation,
classement, sources, absence d’opportunité et échec Web.
