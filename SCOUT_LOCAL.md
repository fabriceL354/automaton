# Scout V10 Experiment Monitoring & Observation Engine (inférence locale)

Scout utilise Ollama local pour l’inférence et un workspace confiné pour ses
fichiers. V2 ajoute uniquement des lectures Web publiques HTTPS. Aucun Conway,
wallet, paiement, compte, authentification, publication, shell accessible au
modèle, JavaScript exécuté, navigateur interactif ou binaire téléchargé/exécuté.
Les recherches Web V2 restent exclusivement GET : aucun POST/PUT/PATCH/DELETE,
formulaire soumis, cookie, jeton, corps de requête ou référent.
L’API Ollama locale conserve son POST d’inférence ; ce POST ne va jamais au Web.
V8 ajoute un seul POST externe fixe `webhook_ping`, déclenché par le CLI après
approbation humaine exacte. Ce mode déterministe n'utilise jamais Ollama et
n'ajoute aucun outil réseau au modèle. Voir la procédure V8 en fin de document.

## Démarrer

Prérequis : Node.js 20+, pnpm 10.28.1. Les modes local/opportunity/experiment
nécessitent aussi Ollama lancé localement et un modèle installé. Les modes
ledger/approval/revenue/projects/monitoring ne nécessitent ni Ollama, ni mission, ni réseau.
Le mode external ne nécessite ni Ollama ni mission ; seule son exécution réelle
ouvre une connexion réseau, après préparation et approbation distinctes.

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
pnpm exec vitest run src/__tests__/scout-opportunity.test.ts # V3/V3.1
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
index de sources et maximum de trois opportunités sont validés avant toute
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

## V3.1 — Analyse par petits appels

Sur une machine CPU limitée, le mode Opportunity ne demande plus à Qwen de
produire plusieurs opportunités complètes dans un seul JSON. Après les lectures
Web, le runtime demande d’abord une liste courte de **trois candidats maximum**.
Il analyse ensuite chaque candidat séparément, dans l’ordre, avec un petit appel
Ollama et un objet minimal. Les champs libres restent courts ; les scores
`difficulty_1_5`, `risk_1_5`, `margin_potential_1_5` et `scalability_1_5` sont des
entiers 1–5. Le nom vient du candidat validé et les indexes de preuves sont
fournis/contrôlés par le runtime ; une URL ou une requête n’est jamais acceptée
à cet endroit.

`SCOUT_NUM_PREDICT` reste la limite opérateur, mais V3.1 plafonne chaque petite
étape à 128 tokens pour les candidats et 256 tokens pour une fiche. Cela évite
qu’un réglage matériel élevé transforme une seule réponse en génération lente ou
tronquée. `SCOUT_NUM_CTX` et `SCOUT_TIMEOUT_MS` restent appliqués à chaque appel.
Le budget de tours interne (douze maximum) couvre la liste et les reprises ; un
timeout ou une fiche invalide n’efface jamais les fiches déjà validées. Une fiche
invalide est retentée au plus deux fois, tandis qu’un timeout fait passer
immédiatement au candidat suivant. Si aucun candidat ne passe la validation,
le runtime écrit un résultat vide explicite, sans inventer d’opportunité.

`opportunities.json` est assemblé exclusivement par le runtime : coût au plus
égal au budget, types/plages, preuves réellement lues, score déterministe,
classement et maximum trois entrées. `rapport.txt` est ensuite généré séparément
par le runtime, avec budget, top 3, risques, hypothèses, première expérience
plafonnée à 10 €, recommandation et `Sources` vérifiées. Aucun achat, paiement,
compte, publication ou dépense n’est effectué.

## V4 — Experiment Runner (planification uniquement)

Le mode V4 est opt-in : `SCOUT_MODE=experiment`. Il ne fait aucune nouvelle
recherche Web et ne donne aucun outil supplémentaire au modèle. Il lit
exclusivement le fichier `opportunities.json` produit et validé par V3, recalcule
les scores et sélectionne automatiquement l'opportunité au meilleur score (avec
un départage déterministe). Le modèle ne peut pas choisir un autre nom ou un
chemin de fichier.

```sh
SCOUT_MODE=experiment \
SCOUT_EXPERIMENT_BUDGET_EUR=10 \
node dist/index.js --run
```

`SCOUT_EXPERIMENT_BUDGET_EUR` est un entier de `0` à `10`, et ne peut jamais
dépasser `SCOUT_BUDGET_EUR` enregistré dans `opportunities.json`. C'est un
plafond de planification, jamais une autorisation de dépense. V4 préfère un plan
à `0 €` lorsque les critères indiquent qu'aucune dépense réelle n'est nécessaire.

Depuis V4.1, le runner conserve les appels hypothèse et actions puis découpe
les critères en cinq micro-appels séquentiels : `success_metrics`,
`stop_conditions`, `expected_learning`, `duration_days` et `requirements`.
Chaque JSON est validé immédiatement, avec au plus deux tentatives par étape
(premier essai inclus) et quatorze appels au total. Les actions sont bornées
à cinq, la durée à 1–7 jours, les métriques et conditions sont non vides, et les
booléens sont stricts. Une sortie invalide n'est jamais acceptée silencieusement.
Le runtime calcule `requires_human_approval` si le plan mentionne une dépense,
un compte, une publication ou une action sensible ; cela ne déclenche aucune
action.

Le mode écrit uniquement deux fichiers fixes dans le workspace :

- `experiment.json` : version 4, statut `planned`, opportunité et score V3,
  hypothèse, budget/durée, actions, métriques, conditions, apprentissage attendu
  et indicateurs d'approbation ;
- `experiment-report.txt` : résumé court dans la langue explicitement demandée
  par `MISSION.txt`, avec la mention exacte `Aucune dépense ni action externe
  n'a été exécutée par Scout.`

V4 ne possède aucun outil d'achat, wallet, paiement, compte, authentification,
publication, email, formulaire, shell ou réseau externe. Le seul POST reste
l'inférence vers Ollama sur loopback. Les tests V4 simulent Ollama et vérifient
les artefacts, la sélection, les budgets, les retries bornés, les booléens et
l'absence d'exécution externe.

### V4.1 — Critères adaptés au petit modèle

Les trois micro-appels textuels demandent uniquement leur champ nommé : un
tableau court de métriques, un tableau court de conditions d'arrêt, puis une
phrase d'apprentissage attendu. Le prompt demande 1–2 éléments courts pour les
tableaux ; les limites strictes V4 (1–5 éléments, longueurs bornées) restent
appliquées. La durée est demandée séparément : seul `duration_days`, entier 1–7.
Il n'y a plus de gros objet `criteria` demandé au modèle.

Le dernier micro-appel `requirements` exige exactement trois booléens :
`requires_real_spending`, `requires_external_account`, `requires_publication`.
Une analyse de mots seule ne suffit pas à déterminer leur absence de façon
fiable. Ils restent donc explicitement obligatoires : aucune valeur manquante
ne devient `false`, et aucune chaîne ou valeur numérique n'est convertie.
`requires_human_approval` est toujours calculé par le runtime, avec les contrôles
sensibles V4 existants ; ce champ est interdit dans les sorties du modèle.

Tout JSON invalide, champ supplémentaire ou type incorrect provoque une reprise
de la seule micro-phase concernée, sans rejouer les étapes validées. Après deux
échecs, le runner s'arrête sans écrire les artefacts finaux ; d'anciens artefacts
restent inchangés et ne signifient pas que cette exécution a réussi. L'assemblage
et la revalidation du contrat V4 complet n'ont lieu qu'après toutes les étapes.
Le schéma final reste `version: 4`, `status: planned`, avec les mêmes chemins
fixes et le même confinement. Aucune recherche ni capacité externe n'est ajoutée.

`SCOUT_NUM_PREDICT=256` reste adapté à la cible : chaque appel V4.1 conserve le
plafond interne de 128 tokens (ou la limite opérateur si elle est inférieure).
`SCOUT_NUM_CTX`, `SCOUT_TIMEOUT_MS`, `format:"json"`, Qwen2.5 1.5B et le debug
local sont conservés. Sept petits appels au lieu de trois peuvent allonger la
durée totale ; la robustesse et la durée sur Chromebook restent à valider
matériellement. Tests simulés :

```sh
pnpm exec vitest run src/__tests__/scout-experiment.test.ts
pnpm exec vitest run src/__tests__/scout-*.test.ts
```

## V5 — Mémoire économique locale, déterministe et auditable

`SCOUT_MODE=ledger` est un mode séparé qui ne fait **aucun appel Ollama ni Web**.
Il n'a besoin ni d'un modèle installé, ni de `MISSION.txt`. Les modes `local`,
`opportunity` et `experiment` conservent leur parcours. Le ledger n'est pas un
compte bancaire : son capital et ses mouvements sont uniquement comptables.
Aucun achat, paiement, wallet, compte, message ou publication n'est effectué.

```sh
SCOUT_MODE=ledger SCOUT_INITIAL_CAPITAL_EUR=100 node dist/index.js --run
```

Le runtime produit deux fichiers fixes dans `~/.automaton/scout-workspace` :
`economic-ledger.json` et `economic-report.txt`. L'outil générique `write_file`
refuse les noms économiques, y compris le verrou et les fichiers temporaires.
Le modèle ne reçoit aucune API comptable et ne peut pas modifier les soldes.

### Capital et monnaie exacte

`SCOUT_INITIAL_CAPITAL_EUR` vaut `100` par défaut. Il accepte une valeur de
`0` à `10000` EUR, avec au plus deux décimales séparées par un point : `100`,
`0.10`, `25.99`. Les signes, espaces, exposants, virgules et arrondis implicites
sont refusés. Les chiffres sont convertis directement en centimes via `BigInt`.
Toutes les opérations monétaires utilisent des entiers exacts ; les fichiers
JSON stockent des nombres entiers sûrs, jamais des montants décimaux en euros.

Cette variable sert **uniquement si le ledger n'existe pas**. Dès qu'il existe,
le capital vient de l'entrée d'initialisation vérifiée. Changer la variable,
même avec une nouvelle valeur invalide, ne réinitialise pas le ledger. Un fichier
présent mais vide ou corrompu est une erreur, jamais un ledger inexistant.

### Format et invariants

La racine contient exactement `version: 5`, `currency: "EUR"`, `entries` et :

- `initial_capital_cents` ;
- `available_balance_cents` ;
- `reserved_balance_cents` ;
- `total_recorded_expenses_cents` ;
- `total_recorded_revenue_cents` ;
- `realized_net_result_cents` (seul total pouvant être négatif).

Chaque entrée contient exactement `id`, `type`, `amount_cents`, `timestamp`,
`description`, `experiment`, `human_reference`, `previous_hash` et `hash`.
Les IDs séquentiels et les timestamps UTC sont produits par le runtime.
La description est bornée à 240 caractères ; la référence humaine à 120.
`experiment` vaut `null` ou contient l'identifiant SHA-256 du plan V4 canonique,
son nom, son budget en centimes et les deux indicateurs de dépense/approbation.
Tous les champs supplémentaires, types inconnus, booléens coercibles, fractions,
montants négatifs ou hors plage sont refusés.

Les types d'entrée sont :

| Type | Effet comptable |
| --- | --- |
| `initialization` | Une seule première entrée ; définit le capital local |
| `reserve` | Déplace du disponible vers le réservé pour un plan précis |
| `release` | Restitue au disponible une partie non consommée de la réservation |
| `expense` | Consomme une réservation existante ; augmente les dépenses enregistrées |
| `revenue` | Augmente le disponible et les revenus explicitement confirmés |

Chaque lecture rejoue l'historique entier. À chaque étape, les montants restent
bornés ; aucune réservation ne dépasse le disponible ; une dépense/libération
ne dépasse pas le reste de la réservation associée. Les totaux stockés doivent
être exactement égaux au recalcul. Les relations sont :

```text
disponible + réservé = capital initial + revenus enregistrés - dépenses enregistrées
résultat net réalisé enregistré = revenus enregistrés - dépenses enregistrées
```

V5 limite l'historique à 1000 entrées et le fichier à 2 MiB. Les soldes et
compteurs cumulés sont plafonnés à 1 000 000 000 centimes (10 millions EUR) ;
le capital initial reste plafonné à 10 000 EUR. Dépasser une limite provoque une
erreur explicite : aucune troncature ni suppression d'historique.

Chaque entrée inclut le hash de la précédente et son propre SHA-256. Cette
chaîne détecte une altération sans recalcul cohérent ; elle n'est ni une
blockchain ni une signature. Un utilisateur ayant accès en écriture aux fichiers
et capable de recalculer toute la chaîne peut les falsifier. Elle ne prouve pas
qu'un paiement ou revenu externe a eu lieu ; les sauvegardes restent nécessaires.

### Intégration V4 et approbation

Si `experiment.json` existe, le runtime revalide le schéma V4/V4.1 exact, le statut
`planned`, les types, la durée 1–7 jours, les actions bornées, les critères,
le budget 0–10 EUR et les indicateurs sensibles. Un plan exigeant dépense,
compte ou publication avec `requires_human_approval: false` est refusé.
Un fichier invalide arrête l'exécution sans nouvelle écriture du ledger.
L'absence de fichier permet simplement l'initialisation/lecture comptable.

Un plan signalant une dépense avec un budget positif donne au maximum une
**réservation comptable locale**, bornée par le disponible. La lecture du plan
ne constitue ni une approbation ni une dépense. Le même contenu canonique de
plan donne le même identifiant : relancer ne réserve jamais deux fois, même
après consommation ou libération. Changer le contenu produit un nouvel
identifiant et peut créer une nouvelle réservation : vérifier le disponible
et les réservations avant de remplacer un plan. Un plan à budget nul ne crée
aucun mouvement. Aucun texte libre du plan n'est exécuté ou interprété comme
un montant, revenu confirmé ou autorisation.

Les références vers V4 restent des propositions : V5 ne vérifie pas les revenus
futurs, ne consulte pas de banque et n'authentifie pas l'origine des plans.
Le rapport affiche capital, disponible, réservé, dépenses/revenus enregistrés,
résultat net, nombre d'entrées, plans associés et approbation requise. Il rappelle
qu'aucune dépense ni action externe n'a été exécutée par Scout.

### API interne de futurs événements autorisés

`recordAuthorizedEvent` (calcul pur) et `recordLedgerEvent` (persistance atomique)
sont réservées au code hôte de confiance. Elles ne sont exposées ni comme outils
du modèle, ni comme paramètres d'actions, ni via un fichier de commandes,
ni via des variables d'environnement ou une commande CLI de dépense.

Pour enregistrer une dépense, un revenu confirmé ou une libération, l'appelant
doit fournir un montant entier positif en centimes, une description et
`authorization: { source: "human", reference: "..." }`. Dépenses et libérations
exigent aussi l'identifiant d'une réservation existante. Une référence humaine
déjà enregistrée est refusée, empêchant de répéter un événement confirmé.
Le code hôte doit obtenir cette autorisation/confirmation auprès de l'humain ;
ce champ n'est pas un mécanisme d'authentification ni le futur Approval Gate V6.
Il est interdit de construire cet appel directement depuis une affirmation LLM.

### Écriture atomique, concurrence et récupération

Le runtime prend un verrou exclusif `.economic-ledger.lock` avant lecture et le
garde jusqu'à la vérification finale. Une deuxième exécution échoue proprement.
Chaque écriture utilise un temporaire exclusif dans le même workspace, une
validation, une relecture, `fsync`, un renommage atomique et la synchronisation
du répertoire. Les liens symboliques et fichiers à liens physiques multiples
sont refusés. Les chemins sont choisis uniquement par le runtime.

Le ledger est la référence. Ledger et rapport sont atomiques individuellement,
pas comme une paire : si le ledger est enregistré mais le rapport échoue, le
prochain lancement régénère le rapport sans doubler la réservation. Après un
arrêt brutal, le ledger reste ancien ou nouveau mais complet ; un verrou et
un temporaire peuvent rester. Le runtime ne les efface pas automatiquement.

En cas de ledger invalide ou verrou bloqué :

1. Arrêter les relances et vérifier qu'aucun processus Scout n'écrit encore.
2. Sauvegarder les fichiers existants, y compris ledger, rapport, verrou et
   éventuels temporaires, sans modifier les originaux.
3. Inspecter l'erreur et comparer avec une sauvegarde connue valide. Ne pas
   éditer les soldes pour les faire correspondre et ne pas supprimer le ledger
   pour repartir silencieusement à zéro.
4. Une restauration de sauvegarde ou un traitement du verrou orphelin doit être
   une décision humaine explicite, après conservation des pièces d'audit. Retirer
   uniquement un verrou confirmé orphelin ; ne jamais voler celui d'un processus
   actif. Un temporaire n'est jamais promu automatiquement en ledger.
5. Relancer le mode ledger : il revalide l'historique avant tout mouvement.
   Si aucun historique fiable n'est disponible, conserver l'erreur visible et
   demander une analyse humaine ; aucune réparation automatique n'est prévue.

### Tests V5

```sh
git diff --check
pnpm build
pnpm exec vitest run src/__tests__/scout-ledger.test.ts
pnpm exec vitest run src/__tests__/scout-*.test.ts
```

Les tests utilisent uniquement des fichiers temporaires et des événements
simulés, sans Internet ni Ollama. Ils couvrent également les échecs de renommage,
la concurrence, les liens dangereux et le CLI réel. La validation matérielle
sur Chromebook reste à effectuer séparément après intégration.

## V6 — Approval Gate local, sans exécution

`SCOUT_MODE=approval` ne fait aucun appel au modèle, au Web ou à un service
externe. Il ne crée ni compte ni message, ne publie rien, n'exécute aucune action
proposée, aucun shell, aucune transaction et n'enregistre **aucune dépense V5**.
Une approbation signifie uniquement une autorisation locale du plan exact,
avec son plafond en centimes et ses capacités précises. Ce n'est pas une preuve
de paiement ni une preuve d'identité civile.

### Commandes exactes sur le Chromebook

Depuis le dépôt, sur `local-ollama-only`, après intégration du bundle :

```sh
pnpm build
pnpm exec vitest run src/__tests__/scout-approval.test.ts
export SCOUT_MODE=approval
node dist/index.js --run
cat ~/.automaton/scout-workspace/approval-report.txt
```

`experiment.json` V4/V4.1 et `economic-ledger.json` V5 doivent déjà être présents
et valides dans ce workspace. V6 refuse leur absence ; il ne les crée ni ne les
répare. Un budget positif exige une réservation V5 correspondante, intacte et
non consommée/libérée, du même montant. Le cas matériel attendu est une demande
`pending`, plafond 1000 centimes, capacité `real_spending`.

Lire toutes les actions proposées, les capacités et le montant dans le rapport,
puis remplacer `IDENTIFIANT_EXACT_COPIE_DU_RAPPORT` ci-dessous par le véritable
identifiant `request-…`. Le placeholder lui-même est refusé.

```sh
node dist/index.js --approve IDENTIFIANT_EXACT_COPIE_DU_RAPPORT
node dist/index.js --run
cat ~/.automaton/scout-workspace/approval-report.txt
cat ~/.automaton/scout-workspace/approval.json
```

Pour **refuser au lieu d'approuver**, sur une demande encore pending :

```sh
node dist/index.js --deny IDENTIFIANT_EXACT_COPIE_DU_RAPPORT
```

Un identifiant absent, `yes`, `true`, `latest`, `*`, `approve-all`, un identifiant
inconnu ou une décision rejouée est refusé. Aucun texte de mission, fichier de
réponse du modèle ou variable d'environnement ne peut approuver/refuser. Les
commandes de décision sont réservées au mode explicitement activé `approval`.
`human_reference` est construite par le CLI (`local-cli:approve:request-…` ou
`local-cli:deny:request-…`) et n'est jamais fournie par Ollama.

Vérifier les soldes après l'approbation, sans relancer de planification :

```sh
cat ~/.automaton/scout-workspace/economic-ledger.json
```

Pour la fixture matérielle annoncée, ils doivent rester :

| Champ V5 | Centimes |
| --- | ---: |
| `initial_capital_cents` | 10000 |
| `available_balance_cents` | 9000 |
| `reserved_balance_cents` | 1000 |
| `total_recorded_expenses_cents` | 0 |
| `total_recorded_revenue_cents` | 0 |
| `realized_net_result_cents` | 0 |

V6 ne touche à aucun octet du ledger : une réservation reste une réservation.
La commande `--run` vérifie l'état courant, sans nouvelle approbation implicite.

### Fichiers, périmètre et réexamen explicite

Dans le workspace :

- `approval-request.json` : version 6, UUID runtime, date, identifiant V5 de
  l'expérience, actions précises, montant EUR, indicateurs sensibles, capacités,
  hashes du plan/ledger, référence de réservation, fingerprint et état strict
  `pending`, `approved` ou `denied`.
- `approval.json` : uniquement pour la demande courante approuvée, UUID runtime,
  date, identifiants et fingerprint liés, montant/capacités exacts et référence
  de la commande humaine. Sa présence seule ne vaut **jamais** autorisation.
- `approval-report.txt` : actions, montant, capacités, identifiant exact, état et
  rappel explicite : `Aucune dépense ni action externe n'a été exécutée par Scout.`

Les capacités `real_spending`, `external_account` et `publication` correspondent
exactement aux indicateurs V4 validés ; elles ne s'accordent pas mutuellement.
Si seul `requires_human_approval` est vrai, sans ces trois indicateurs,
`other_sensitive_action` conserve explicitement cette exigence. Un plan sans
aucune exigence sensible n'obtient pas d'autorisation inutile. Les textes ne sont
jamais exécutés ; V6 n'est pas un interpréteur de leur sémantique. Les futurs
exécuteurs devront vérifier leurs propres opérations concrètes, sans déduire de
ces catégories une permission générale.

Le fingerprint lie l'identifiant runtime, l'expérience exacte, les actions,
les capacités, le montant, les hashes et la réservation. L'identifiant
`experiment_id` reste le hash canonique utilisé par V5. V6 lie aussi les **octets**
du plan et du ledger : même un changement de mise en forme ou une entrée V5 sans
rapport invalide conservativement la liaison courante. Toute consommation ou
libération de la réservation rend celle-ci impropre à une nouvelle demande.
Un plan à 0 EUR peut demander compte/publication sans réservation positive,
mais exige toujours un ledger V5 valide et une autorisation de montant nul.

Après modification volontaire du plan et sa validation/réservation V5, ou pour
réexaminer un refus, utiliser explicitement :

```sh
SCOUT_MODE=approval node dist/index.js --new-request
cat ~/.automaton/scout-workspace/approval-report.txt
```

Cette commande crée un **nouvel** identifiant et fingerprint pending. L'ancienne
décision reste dans l'historique privé et n'autorise plus la demande courante.
L'ancienne vue `approval.json` est retirée lors de ce réexamen explicite. Une
ancienne demande denied ne devient jamais approved. Des vues modifiées ou
corrompues bloquent également `--new-request` : ce n'est pas un moyen de réparer
ou contourner une incohérence.

### Ancrage d'intégrité hors de portée du modèle

Un simple SHA-256 éditable avec son JSON ne suffit pas à prouver une décision.
V6 conserve donc l'historique autoritatif `state.json`, authentifié par HMAC-SHA256,
et une clé d'intégrité aléatoire locale de 32 octets dans un répertoire privé
**frère du workspace**, choisi uniquement par le runtime :

```text
~/.automaton/.scout-approval-<hash-du-chemin-workspace>/
  integrity-key
  state.json
```

Ce secret technique n'est ni une clé API, ni un credential externe, ni une donnée
bancaire. Il n'est jamais inclus dans les rapports/artefacts publics, envoyé au
modèle ou au réseau. Répertoire 0700, clé et fichiers créés en 0600 ; aucune
régénération automatique d'une clé perdue. Les outils confinés du modèle ne
peuvent ni lire ni écrire ce répertoire. `write_file` refuse également toutes
les vues d'approbation dans le workspace. L'historique est borné à 100 demandes
et 512 KiB ; aucune purge automatique.

Chaque lecture authentifie l'historique, revalide ses schémas stricts, compare
les vues exactes et vérifie les artefacts V4/V5 actuels. Une modification manuelle
de `approval.json`, même apparemment bénigne, est rejetée. Le contenu local
signé ne représente aucune exécution et ne doit jamais devenir un outil modèle.

**Frontière de confiance :** le CLI et le compte système opérateur sont fiables.
Ce mécanisme protège contre le modèle et la falsification isolée des fichiers
du workspace. Il ne peut pas prouver qu'un humain physique a tapé la commande,
ni résister à un administrateur/logiciel compromis contrôlant le même compte,
le code, la clé ou une restauration complète d'une ancienne sauvegarde signée.
Une garantie anti-rollback contre cet acteur exigerait un ancrage externe ou
matériel, hors périmètre V6. Ne pas exposer ce CLI comme outil du modèle.

### Atomicité, concurrence et arrêt fail-closed

V6 partage `.economic-ledger.lock` avec V5 et refuse les opérations concurrentes
ou un verrou orphelin. Aucun verrou n'est volé. Les fonctions V5 de lecture
confinée et d'écriture atomique sont réutilisées : fichiers ordinaires uniquement,
liens symboliques/physiques multiples refusés, temporaire exclusif, vérification,
`fsync`, renommage atomique et synchronisation du répertoire. Les entrées V4/V5
sont relues avant et après écriture ; une modification concurrente provoque une
erreur. Ne pas lancer le planificateur V4 en parallèle du gate.

L'historique authentifié est écrit avant les vues. Les fichiers sont atomiques
**individuellement**, pas comme un ensemble transactionnel. Une panne entre deux
écritures laisse une incohérence visible qui bloque les relances ; aucune décision
n'est inférée, rejouée ou promue depuis un temporaire. Un ancien rapport peut
subsister après une erreur : il ne constitue pas une autorisation vérifiée.

En cas d'erreur d'intégrité, de fichiers manquants, de vue partielle ou de verrou :
arrêter les relances, conserver une copie du workspace et du répertoire privé,
vérifier qu'aucun processus n'écrit, puis examiner l'erreur humainement. Ne pas
éditer les JSON, supprimer la clé ou effacer le journal pour débloquer une
approbation. Une restauration exige une sauvegarde **complète et cohérente** et
une décision humaine ; aucun outil de réparation automatique n'est fourni.
Préserver les fichiers invalides pour analyse. Un réexamen normal utilise
`--new-request` seulement lorsque les artefacts et vues sont intègres.

### Validation logicielle et matérielle

```sh
git diff --check
pnpm build
pnpm exec vitest run src/__tests__/scout-approval.test.ts
pnpm exec vitest run src/__tests__/scout-*.test.ts
```

Les tests V6 couvrent décisions/identifiants explicites, refus et réexamen,
liaisons V4/V5, montants et capacités, corruption/falsification, liens dangereux,
échecs d'écriture, concurrence, invariance du ledger et CLI sans Ollama.
Ces tests utilisent des fixtures temporaires. La validation matérielle sur
Chromebook reste distincte et doit être effectuée après intégration.

## V7 — Revenue Loop supervisée, comptabilité sans exécution

`SCOUT_MODE=revenue` enregistre uniquement les montants **réalisés et déclarés
explicitement par l'humain**. Aucun modèle, aucune banque, aucun paiement,
transfert, achat, compte, publication, message ou API externe n'est appelé.
La présence d'une approval n'est jamais une preuve de dépense et ne crée aucun
événement à elle seule. V7 ne vérifie pas automatiquement la déclaration humaine
auprès d'une banque. Aucun montant ne peut provenir d'Ollama, d'une mission,
d'un fichier de commandes ou d'une variable d'environnement.

### Premier test Chromebook : aperçu sans clôture

Après intégration sur `local-ollama-only`, depuis le dépôt :

```sh
pnpm build
pnpm exec vitest run src/__tests__/scout-revenue.test.ts
cat ~/.automaton/scout-workspace/approval-request.json
```

Copier **experiment_id** (64 caractères hexadécimaux), et non request_id,
depuis la demande V6. Remplacer `EXPERIMENT_ID_EXACT` dans cette commande :

```sh
SCOUT_MODE=revenue node dist/index.js \
  --record-result EXPERIMENT_ID_EXACT \
  --expense-cents 0 \
  --revenue-cents 0 \
  --outcome cancelled \
  --preview
```

L'aperçu utilise les mêmes contrôles que l'enregistrement. Il n'écrit ni ledger,
ni résultat, ni rapport, ni historique/clé V7. Il prend seulement le verrou
exclusif V5 pendant la lecture, puis le retire. Les montants affichés sont
**projetés**, sans confirmation comptable. La suppression de `--preview` constitue
la commande humaine de clôture ; elle ne doit pas être faite pour une simple
simulation. Il n'existe pas de mode qui injecte silencieusement de faux revenus.

Pour l'état matériel annoncé, l'aperçu zéro/zéro doit afficher une libération
**projetée de 10 EUR** et un disponible **projeté de 100 EUR**. Le fichier réel
doit toujours rester à 100 EUR initial, 90 EUR disponibles, 10 EUR réservés,
0 EUR de dépenses/revenus/résultat net. Vérifier :

```sh
cat ~/.automaton/scout-workspace/economic-ledger.json
```

Les tests Vitest utilisent des workspaces temporaires isolés et n'altèrent pas
le workspace réel. C'est la méthode recommandée pour tester un scénario fictif
7 EUR / 25 EUR. Pour annuler réellement l'expérience locale sans frais ni revenu,
relire l'aperçu puis exécuter la même commande **sans `--preview`** : la réservation
sera effectivement libérée dans le ledger et l'expérience définitivement clôturée.
Cela n'exécute toujours aucune transaction externe.

### Enregistrer un résultat réellement confirmé

Exemple uniquement si l'humain confirme avoir effectivement dépensé 7 EUR et
reçu 25 EUR en dehors de Scout. Copier aussi le **request_id** précis de V6 :

```sh
SCOUT_MODE=revenue node dist/index.js \
  --record-result EXPERIMENT_ID_EXACT \
  --expense-cents 700 \
  --revenue-cents 2500 \
  --outcome success \
  --approval-request-id REQUEST_ID_EXACT \
  --preview
```

Après examen, répéter sans `--preview` uniquement pour confirmer ces montants
réalisés. Les placeholders ci-dessus, `latest`, `all`, `*`, `yes` et les phrases
libres sont refusés. L'identifiant d'expérience, les deux montants et l'outcome
sont obligatoires, même lorsque les montants sont nuls. Champs inconnus ou
dupliqués refusés. Outcomes acceptés : `success`, `partial`, `failed`, `cancelled`.
Le choix de l'outcome est humain ; le runtime n'invente pas un succès à partir
d'un revenu positif. Une expérience annulée peut avoir occasionné des frais.

Pour toute dépense positive, `--approval-request-id` est obligatoire : la
requête courante doit être approved, authentifiée et toujours liée aux octets
exacts du plan/ledger, à la réservation, au montant et à la capacité
`real_spending`. Une capability publication n'autorise pas une dépense.
Le montant réalisé doit être <= réservation et <= autorisation. Un plan à
budget nul ne peut enregistrer de dépense positive.

À dépense nulle, une clôture peut se faire sans approval ou avec une requête
pending/denied. Cependant, **tout état V6 existant** doit être intègre et lié au
plan/ledger courant : son absence autorisée ne permet pas d'ignorer un fichier
présent mais corrompu, incomplet ou périmé. L'option request_id, si fournie même
à zéro, doit correspondre exactement. V7 ne prétend jamais qu'une publication
ou création de compte a été effectuée par Scout.

### Écriture comptable et formule du disponible

Le runtime calcule en centimes entiers exacts. Aucune arithmétique monétaire
flottante, conversion approximative, commission supposée ni ROI indéfini.
Les limites V5 restent actives : 1000 événements et montants/compteurs bornés
à 1 000 000 000 centimes. `NaN`, `Infinity`, flottants, négatifs, `-0`, notation
exponentielle et dépassements sont refusés avant mutation.

Sous le verrou partagé V5/V6, les événements sont construits et validés en
mémoire dans cet ordre déterministe, en omettant les montants nuls :

1. `expense` : dépense réalisée déclarée par l'humain, consommée sur la réservation.
2. `release` : reliquat intégral, ajouté au disponible.
3. `revenue` : revenu réalisé déclaré par l'humain, ajouté au disponible.

Le ledger entier est remplacé **une seule fois**, atomiquement. Il n'existe
aucun ledger intermédiaire persistant avec une dépense mais sans libération.
Les entrées antérieures restent identiques et la chaîne V5 est rejouée.
La réservation de cette expérience doit être intacte avant clôture ; V7 refuse
une réservation déjà partiellement dépensée/libérée par une autre opération.
À la clôture il ne reste aucune réservation pour cette expérience.

```text
released_cents = reserved_cents - expense_cents
net_result_cents = revenue_cents - expense_cents
available_after = available_before + released_cents + revenue_cents
available + reserved = initial_capital + total_revenue - total_expenses
realized_net_result = total_revenue - total_expenses
```

La dépense n'est pas déduite à nouveau du disponible : V5 a déjà retiré la
réservation du disponible. Exemple 100 EUR initial, 10 EUR réservés, dépense
confirmée 7 EUR, revenu confirmé 25 EUR :

| Champ final | Centimes |
| --- | ---: |
| Initial | 10000 |
| Disponible | 11800 |
| Réservé | 0 |
| Dépenses cumulées | 700 |
| Revenus cumulés | 2500 |
| Résultat net cumulé | 1800 |

Le schéma V5 des revenus reste inchangé (`experiment: null`). Leur lien à
l'expérience est explicite dans la description, la référence humaine de résultat
et la liste des identifiants d'entrées dans le résultat V7 authentifié. V7 revalide
ces liens et l'ordre de chaque événement ; aucun revenu n'est compté deux fois.

### Résultat, état de clôture et mémoire économique

Fichiers produits dans le workspace :

- `experiment-result.json` : résultat courant version 7, UUID/date runtime,
  experiment_id exact, outcome humain, montants, net, reliquat, références V6,
  human_reference runtime, source `human_confirmed`, statut `closed`, score V3,
  durée prévue, apprentissage attendu, hash du plan et événements V5 associés.
- `economic-history.json` : résultats antérieurs conservés dans l'ordre,
  compteurs d'outcomes, coûts/revenus/nets dérivés par le runtime. Aucun texte
  de mémoire inventé par le modèle. Le nom d'opportunité est conservé ; aucun
  « type » économique non présent dans V4 n'est inventé.
- `revenue-report.txt` : état et montants à la clôture, résultat net, disponible
  après clôture, totaux cumulés et mentions obligatoires :
  `Les montants réalisés ont été déclarés explicitement par l'utilisateur.`
  `Scout n'a exécuté aucun paiement ni transaction externe.`
- `economic-report.txt` : résumé V5 rafraîchi depuis le nouveau ledger.

Le plan `experiment.json` V4 reste inchangé avec `status=planned` : c'est la
proposition historique approuvée. L'état de cycle de vie **closed** appartient
au résultat V7 et à son historique. Le réécrire en V4 casserait le fingerprint
V6 et ferait passer la même expérience pour un nouveau plan.

Une même expérience est clôturable une seule fois. La commande strictement
identique retourne le résultat initial sans nouvel UUID/date, sans événements
ni écriture. Changer outcome, montant ou l'option request_id après clôture est
refusé. Modifier/reformater le plan d'une expérience déjà clôturée est refusé.
Pour une nouvelle expérience V4 réellement distincte, suivre le cycle normal
V4 → réservation V5 → nouvelle demande V6 si nécessaire → V7. Les résultats
précédents sont conservés ; le rapport courant correspond à la dernière clôture.

Une clôture change volontairement le ledger et consomme/libère la réservation :
l'approbation V6 devient donc **périmée pour toute nouvelle dépense**. V7 ne la
réécrit pas pour la faire paraître actuelle. Pour une relance idempotente, V7
vérifie la preuve V6 historique authentifiée et les empreintes avant/après
clôture, au lieu d'exiger à tort une réservation encore active. Un nouveau
lancement du mode approval peut normalement signaler cette liaison périmée.

### Intégrité, transaction incomplète et confinement

Un historique autoritatif V7 authentifié par HMAC-SHA256 est conservé dans
`~/.automaton/.scout-revenue-<hash-du-chemin-workspace>/`, frère du workspace :
`state.json` et `integrity-key`. Les outils du modèle n'y ont aucun accès ;
`write_file` refuse aussi résultat, historique et rapport publics. Répertoire
0700 et fichiers créés en 0600, aucune clé API ou banque. Limite : 100 clôtures,
1 MiB pour l'historique V7, sans purge automatique.

Les résultats sont vérifiés contre l'historique authentifié, les préfixes de
ledger rejoués par V5 et l'historique V6. Toute altération d'une ancienne entrée
V5 reste détectée même si sa chaîne a été recalculée. Des ajouts V5 valides pour
une nouvelle expérience sont permis ; ils ne peuvent réécrire le préfixe déjà
lié à une clôture. Si aucune entrée n'a été ajoutée, même une modification des
octets du ledger après clôture est refusée.

V7 réutilise les protections symlink/hardlink, `O_NOFOLLOW`, temporaires
exclusifs, relecture, `fsync`, renommage et verrou partagé de V5. Il écrit d'abord
un journal durable `prepared`, puis le ledger en une opération atomique, les
vues, et enfin l'état `complete`. Les différents fichiers **ne forment pas une
transaction atomique collective** : après interruption, l'état prepared bloque
les relances, même si certaines écritures ont abouti. Aucun revenu/dépense
n'est rejoué, aucun résultat n'est reconstruit silencieusement depuis un état
incohérent. Un échec après création de la clé mais avant le journal bloque aussi.

En cas d'interruption/corruption : arrêter les opérations, conserver les fichiers
et le verrou, vérifier qu'aucun processus n'écrit, puis faire une inspection
humaine. Ne pas supprimer l'ancrage, éditer le résultat ou relancer aveuglément.
Une sauvegarde de récupération doit inclure **ensemble** le workspace et les
répertoires privés V6/V7, avec leurs permissions, restaurés au même chemin absolu.
Ne jamais restaurer le seul ledger ou déplacer une clé pour contourner un refus.
Aucun reset, suppression de ledger ou réparation automatique n'est fourni.
Utiliser `--preview` pour éviter de polluer l'état réel lors du premier test.

Comme V6, V7 fait confiance au compte système et au CLI hôte. Il ne peut pas
prouver physiquement qui a tapé la commande ni résister à un administrateur
contrôlant le code, toutes les clés et les sauvegardes. Ce n'est pas une preuve
bancaire. Ne jamais exposer ces fonctions de clôture comme outil du modèle.

### Vérification logicielle

```sh
git diff --check
pnpm build
pnpm exec vitest run src/__tests__/scout-revenue.test.ts
pnpm exec vitest run src/__tests__/scout-*.test.ts
```

Les tests V7 couvrent montants/budgets/approbations, zéro/reliquat, exactitude des
soldes, idempotence, deux expériences successives, mémoire dérivée, corruption,
liens dangereux, interruptions d'écriture, concurrence, preview et CLI réel sans
Ollama. Aucune validation matérielle V7 n'est revendiquée avant le test Chromebook.

## V8 — External Action Gateway : un ping fixe approuvé

La seule capability V8 est `webhook_ping`. Le runtime prépare un objet strict,
obtient une décision explicite V6, puis peut envoyer **au plus un POST HTTPS par
action**. Aucun appel Ollama, texte LLM, URL/payload/header libre, client HTTP
générique, paiement, achat, compte, publication arbitraire, email ou commande
système n'est ajouté. Le modèle ne peut ni approuver ni exécuter le CLI.

### Configuration et transport

L'opérateur fournit uniquement `SCOUT_V8_WEBHOOK_URL`, conservée dans son
processus. Elle est obligatoire pour les commandes V8, y compris l'approbation.
L'URL doit être HTTPS, port 443 (implicite ou explicite), sans username/password,
query string ni fragment. Son chemin est autorisé ; ne pas y placer de secret
ou de credential. L'URL complète n'est persistée ni dans les artefacts, ni dans
l'historique privé, ni dans les rapports. La liaison utilise le SHA-256 de la
**chaîne exacte** configurée : même un changement de graphie équivalent rend
l'approbation précédente inutilisable pour cette nouvelle configuration.

Les adresses locales, privées, loopback, link-local, réservées et multicast
sont refusées. Préparation, aperçu et approbation ne font aucune résolution DNS.
Juste avant la connexion, le runtime résout à nouveau le nom, exige que toutes
les réponses soient publiques, puis fixe une seule IP pour la connexion sans
seconde résolution. Une adresse IP littérale doit elle aussi être publique.
TLS vérifie le certificat pour la destination ; aucune désactivation n'est
prévue. Aucun proxy, cookie, Authorization, clé API, OAuth ou header opérateur.

Le JSON envoyé est construit exclusivement par le runtime :

```json
{"version":8,"action":"webhook_ping","action_id":"action-UUID_RUNTIME","message":"Scout V8 external action test"}
```

L'identifiant UUID est généré à la préparation et le payload est lié à son
approbation par SHA-256. Taille maximale : 2 KiB. Le transport utilise POST,
`Content-Type: application/json`, `Accept: application/json` et la longueur
calculée du corps. Il ne suit aucune redirection, ne change jamais de méthode
et ne réessaie jamais. Le délai total DNS/POST/réponse est de 10 secondes maximum.
En-têtes de réponse limités à 8 KiB, corps à 16 KiB ; aucun corps reçu n'est
interprété, exécuté ou conservé. Seuls le statut HTTP, la taille et le SHA-256
d'une réponse complète bornée peuvent être enregistrés.

### Procédure Chromebook, avec votre endpoint de test contrôlé

Validation matérielle V8 rapportée par l’opérateur le 6 octobre 2026 : build et
102 tests réussis, premier HTTP 404 consommé sans rejeu, puis HTTP 200 réel
sur un endpoint contrôlé, empreintes du ledger et du résultat V7 inchangées.
Cette validation porte sur V8 au commit `69aad23`, pas sur V9.
Pour un prochain test, fournir vous-mêmes une URL
HTTPS de test jetable/contrôlée, sans authentification et sans effet économique.
Les tests automatisés ci-dessous simulent le réseau ; ils n'envoient aucun POST
Internet. Exécuter depuis le dépôt sur `local-ollama-only` :

```sh
git branch --show-current
pnpm build
pnpm exec vitest run src/__tests__/scout-external.test.ts
pnpm exec vitest run src/__tests__/scout-*.test.ts
```

Dans le même terminal Bash, saisir votre URL (elle n'est pas affichée ni mise
en clair dans l'historique des commandes par cette saisie) :

```sh
read -r -s -p 'URL HTTPS de test contrôlée : ' SCOUT_V8_WEBHOOK_URL
printf '\n'
export SCOUT_V8_WEBHOOK_URL
```

Conserver une empreinte du ledger et, s'il existe, du résultat V7 avant V8.
Cette étape lit les fichiers existants sans les modifier :

```sh
SCOUT_V8_BEFORE=$(mktemp)
sha256sum "$HOME/.automaton/scout-workspace/economic-ledger.json" > "$SCOUT_V8_BEFORE"
if [ -f "$HOME/.automaton/scout-workspace/experiment-result.json" ]; then
  sha256sum "$HOME/.automaton/scout-workspace/experiment-result.json" >> "$SCOUT_V8_BEFORE"
fi
SCOUT_MODE=external node dist/index.js --prepare-webhook-ping
cat "$HOME/.automaton/scout-workspace/external-action-report.txt"
```

La préparation crée `external-action.json`, `external-approval-request.json` et
`external-action-report.txt`, avec état **PRÉPARÉE**, approbation requise et
aucune exécution. Une préparation répétée réutilise l'action courante tant que
sa configuration est identique, qu'elle n'est ni refusée ni déjà tentée.

Copier exactement les deux identifiants affichés. Remplacer les valeurs
d'exemple suivantes : les placeholders ne sont pas des identifiants valides.

```sh
SCOUT_V8_ACTION_ID='action-UUID_EXACT_AFFICHE'
SCOUT_V8_REQUEST_ID='request-UUID_EXACT_AFFICHE'
SCOUT_MODE=external node dist/index.js --preview "$SCOUT_V8_ACTION_ID"
SCOUT_MODE=approval node dist/index.js --approve-external "$SCOUT_V8_REQUEST_ID"
SCOUT_MODE=external node dist/index.js --execute "$SCOUT_V8_ACTION_ID" --approval-request-id "$SCOUT_V8_REQUEST_ID" --preview
```

L'aperçu initial valide les artefacts et montre le payload fixe, le fingerprint
de destination et la demande exacte. L'approbation V6 crée
`external-approval.json` et l'état **APPROUVÉE MAIS NON EXÉCUTÉE**, sans réseau.
L'aperçu d'exécution exige déjà cette approbation et ne consomme pas l'action.
Une décision de refus utilise, à la place de l'approbation :

```sh
SCOUT_MODE=approval node dist/index.js --deny-external "$SCOUT_V8_REQUEST_ID"
```

Les décisions ne sont possibles que sur une demande encore en attente. Pas de
`latest`, `yes`, wildcard, approval-all, ni approbation implicite. Une approval
économique `real_spending` ne vaut jamais pour V8 ; une approval `webhook_ping`
ne vaut ni pour une autre action, ni pour une dépense ou publication.

Après contrôle de votre endpoint et des identifiants, exécuter **une seule fois**
la commande suivante, qui autorise le POST réel :

```sh
SCOUT_MODE=external node dist/index.js --execute "$SCOUT_V8_ACTION_ID" --approval-request-id "$SCOUT_V8_REQUEST_ID"
```

Puis inspecter le journal et vérifier auprès de votre endpoint la réception du
JSON attendu. Ne pas déduire la réception d'un résultat `uncertain` :

```sh
SCOUT_MODE=external node dist/index.js --inspect
cat "$HOME/.automaton/scout-workspace/external-execution.json"
sha256sum -c "$SCOUT_V8_BEFORE"
```

Pour vérifier l'anti-rejeu, répéter la même commande d'exécution : elle doit être
**refusée localement**, sans second POST. Contrôler aussi le compteur côté
endpoint. V8 ne crée aucune réservation, dépense ou recette et ne modifie ni
le ledger, ni `experiment-result.json`. L'état économique peut donc rester
100 EUR initiaux/disponibles, 0 réservé, 0 dépense, 0 revenu, résultat net 0.

### Journal durable et états terminaux

Avant même le DNS, V8 écrit et synchronise une intention `uncertain` avec la
classe `interrupted`. Elle consomme définitivement cette action. Il revalide
ensuite l'historique authentifié, les vues et l'URL configurée avant le réseau.
Les changements de schéma, fingerprint, capability, identifiant, approval ou
ancrage provoquent un refus. Le résultat conserve version, execution_id,
action_id, request_id, approval_id, capability, attempted_at, fingerprints,
status, http_status, response_size, response_sha256 et network_error_class.

| Statut | Sens et suite |
| --- | --- |
| `executed` | Réponse HTTP 2xx complète et bornée ; action consommée |
| `failed` | Échec avant POST, par exemple DNS interdit ; action consommée |
| `failed-after-send` | Réponse HTTP non 2xx, dont redirection refusée ; action consommée |
| `uncertain` | POST potentiellement reçu, délai dépassé, réponse incomplète, limite de réponse ou interruption ; action consommée, investigation humaine requise |

**Aucun de ces états ne permet le rejeu de la même action.** Un serveur peut
avoir reçu le POST malgré une erreur. Aucun retry automatique, même après
redémarrage. Après `uncertain`, la préparation d'une nouvelle action est elle
aussi bloquée. V8 initiale ne fournit pas de commande de réarmement : conserver
les preuves et examiner l'état local et le serveur ; ne pas effacer le journal,
la clé ou le verrou pour forcer un nouvel essai.

Après un résultat non incertain ou un refus, une nouvelle préparation explicite
peut créer un nouvel action_id et une nouvelle demande V6, sans réutiliser
l'ancienne autorisation. Le changement explicite d'URL avant tentative impose
également une nouvelle préparation et une nouvelle approbation. Les anciennes
actions restent dans l'historique ; seule l'action courante est exécutable.

### Intégrité et limites

Les fichiers publics sont des vues exactes contrôlées par le runtime. Le rapport
seul n'autorise jamais l'action. L'historique autoritatif HMAC-SHA256 et sa clé
locale sont conservés hors du workspace modèle, dans le répertoire privé
`.scout-external-<hash-du-chemin-workspace>` voisin de celui-ci : 0700 pour le
répertoire, 0600 pour les fichiers. La clé technique n'est jamais envoyée au
serveur. Limites : 100 actions et 512 KiB, sans purge automatique.

V8 réutilise les lectures confinées, écritures atomiques avec fsync/rename et
le verrou partagé V5/V6/V7. Il refuse symlinks, hardlinks et chemins non sûrs.
Le journal privé est écrit avant les vues ; une interruption entre plusieurs
fichiers laisse une incohérence détectable qui bloque toute nouvelle action,
sans réparation automatique. Clé/état manquant, vue altérée ou verrou orphelin :
arrêt fail-closed. L'outil générique `write_file` refuse les fichiers `external*`
(y compris les temporaires) ; le confinement interdit l'accès à l'état privé.

Comme V6/V7, le CLI et le compte système hôte appartiennent à la frontière de
confiance. V8 ne résiste pas à un administrateur contrôlant code/clé, ni à une
restauration complète d'une ancienne sauvegarde signée. Aucun ancrage matériel
ou distant anti-rollback n'est ajouté. Sauvegarder ensemble workspace et état
privé, avec permissions et chemin absolu, sans restaurer un ancien état pour
relancer une action. La garantie est « au plus une tentative » dans cet état
local intact, pas une garantie de livraison exactement une fois au serveur.

## Scout V9 — Multi-Project Real Experiment Manager

**NO REAL MONEY IS SPENT BY V9**

V9 coordonne localement un premier batch, ses expériences, leurs réservations
comptables, leurs décisions humaines et le cycle de vie de leurs actifs.
Aucun paiement, achat, compte externe, publication, credential financier ou
connexion bancaire n'est ajouté. Aucune inférence Ollama, tâche permanente,
base de données, polling ou action externe automatique. V10/V11 ne sont pas
implémentées. Les montants saisis sont des déclarations comptables humaines,
jamais des instructions de paiement.

### Architecture et plafonds

- `project-manager.ts` : orchestration CLI, audit des références au ledger et
  validation des liaisons V8 sous le verrou partagé V5–V9.
- `project-model.ts` : grammaire stricte, identités, transitions rejouables et
  événements comptables attendus.
- `project-store.ts` : historique authentifié et projections atomiques.
- `asset-lifecycle.ts` : échéances, états d'actif et métriques en cents entiers.
- V5 reste l'unique ledger (`economic-ledger.json`). Son adaptateur V9 réutilise
  exactement les règles de réservation et de rejeu V5. Les clôtures emploient
  les mêmes primitives d'événements autorisés que V7. Aucun second ledger.
- V6 garde ses contrats stricts de demande/décision. Chaque demande V9 inclut
  le project_id, l'experiment_id, le fingerprint du plan, la réservation exacte,
  le plafond et les capabilities. Le fingerprint de ledger vise le préfixe au
  moment de la réservation : l'ajout légitime de B n'invalide pas A, mais tout
  changement de la réservation de A hors V9 est refusé.

| Limite runtime non configurable | Valeur |
| --- | --- |
| `MAX_ACTIVE_PROJECTS` | 2 |
| `MAX_PROJECT_BUDGET_CENTS` | 1000 cents, EUR uniquement |
| `MAX_BATCH_BUDGET_CENTS` | 2000 cents au total |
| `MAX_EXPERIMENT_DURATION_DAYS` | 7 jours, minimum 1 |
| Historique | 256 événements, 1 MiB ; aucune purge automatique |

Cette première V9 accepte **un seul batch explicite et deux projets au total**,
y compris les projets clôturés/annulés. Elle ne recycle pas automatiquement une
place libérée et ne crée pas de batch #2. Les plafonds s'appliquent aux budgets
planifiés cumulés, pas seulement au solde restant. Deux réservations de 1000
cents sur 10000 cents de capital donnent 8000 disponibles et 2000 réservés.
Un troisième projet est refusé même avec du capital disponible.

### Identités, transitions et temps

Le runtime crée les batch_id/project_id/asset_id (UUID), ainsi que les demandes
et décisions V6. L'experiment_id est le SHA-256 du plan canonique incluant son
project_id unique. Chaque mutation d'expérience exige le couple exact
project_id/experiment_id ; les opérations sur un actif existant exigent aussi
son asset_id. Ni `latest`, `current`, `all`, wildcard, sélection implicite du
premier projet, ni approbation globale. Champs inconnus et doublons refusés.

Parcours projet : `planned → reserved → approved → active`, puis
`experiment_closed` si l'actif est conservé, ou `fully_closed` sinon. Un projet
non démarré peut être explicitement `cancelled` : sa réservation est libérée.
Une demande refusée reste attachée au projet réservé et bloque le démarrage ;
il faut annuler explicitement ce projet. Pas de réarmement implicite.

Le démarrage enregistre `started_at` et `experiment_deadline`, calculée à partir
de la durée approuvée. Il ne lance aucun travail extérieur. `--inspect-project`
et `--list-projects` fournissent `timing.activity` (`not_started`, `active`,
`expired`, `closed`) et `closable`. À l'échéance exacte, l'expérience est
**expirée** : création/activation d'actif et action V8 liée sont refusées. La
phase stockée reste `active` jusqu'à la clôture explicite, afin de ne jamais
inventer une transition ni libérer une réservation silencieusement. Il n'y a
pas de scheduler et aucune prolongation automatique. L'horloge système doit
être fiable ; les retours avant les événements déjà enregistrés sont refusés.

Un actif est absent (`null`, affiché `none`) ou passe par `created`, `active`,
`passive_monitoring`, `retired`. `--create-asset` enregistre uniquement une fiche
locale attestée par l'humain ; cette commande ne fabrique ni ne publie un
produit. La clôture exige `--asset-policy keep|retire`. `keep` conserve un actif
existant en suivi passif, même si le test est `failed` ou `inconclusive`.
La classification du test (`successful`, `failed`, `inconclusive`, `cancelled`)
ne décide jamais du potentiel économique futur de l'actif.

### CLI exacte et preview

Mode normal : `SCOUT_MODE=projects`. Les approbations/refus appartiennent
exclusivement à `SCOUT_MODE=approval`. Toutes les mutations acceptent
`--preview` : mêmes validations, mais aucune écriture du ledger, de l'historique
ou des vues ; seul le verrou temporaire est pris puis relâché. Les IDs générés
pendant un aperçu sont hypothétiques : copier ceux de la commande réellement
enregistrée. Chaque commande émet du JSON avec les IDs, états et métriques.

Les commandes suivantes décrivent le parcours manuel. **Ne pas saisir de
résultats fictifs dans le workspace réel** : utiliser le script isolé de la
section suivante pour la validation. `BATCH_ID`, `PROJECT_ID`, `EXPERIMENT_ID`,
`REQUEST_ID` et `ASSET_ID` sont à remplacer par les valeurs exactes affichées.

```sh
SCOUT_MODE=projects node dist/index.js --create-batch --preview
SCOUT_MODE=projects node dist/index.js --create-batch
SCOUT_MODE=projects node dist/index.js --create-project BATCH_ID --name 'Projet A' --hypothesis 'Hypothèse à tester' --budget-cents 1000 --duration-days 7 --preview
SCOUT_MODE=projects node dist/index.js --create-project BATCH_ID --name 'Projet A' --hypothesis 'Hypothèse à tester' --budget-cents 1000 --duration-days 7
SCOUT_MODE=projects node dist/index.js --reserve-project PROJECT_ID --experiment-id EXPERIMENT_ID --preview
SCOUT_MODE=projects node dist/index.js --reserve-project PROJECT_ID --experiment-id EXPERIMENT_ID
SCOUT_MODE=approval node dist/index.js --approve-project PROJECT_ID --experiment-id EXPERIMENT_ID --request-id REQUEST_ID
SCOUT_MODE=projects node dist/index.js --start-project PROJECT_ID --experiment-id EXPERIMENT_ID --request-id REQUEST_ID
SCOUT_MODE=projects node dist/index.js --create-asset PROJECT_ID --experiment-id EXPERIMENT_ID
SCOUT_MODE=projects node dist/index.js --activate-asset PROJECT_ID --experiment-id EXPERIMENT_ID --asset-id ASSET_ID
SCOUT_MODE=projects node dist/index.js --inspect-project PROJECT_ID
SCOUT_MODE=projects node dist/index.js --list-projects
```

La création d'un projet ne réserve pas d'argent. La réservation est distincte,
crée la demande V6, et ne constitue ni une dépense ni une approbation. La commande
`--deny-project PROJECT_ID --experiment-id EXPERIMENT_ID --request-id REQUEST_ID`
en mode approval permet le refus à la place de l'approbation.
`--cancel-project PROJECT_ID --experiment-id EXPERIMENT_ID [--preview]` en mode
projects annule un projet avant démarrage, en libérant sa réservation.

Clôture humaine explicite, avec montants à remplacer par des constatations
réelles uniquement dans le workspace réel :

```sh
SCOUT_MODE=projects node dist/index.js --close-experiment PROJECT_ID --experiment-id EXPERIMENT_ID --request-id REQUEST_ID --expense-cents 600 --revenue-cents 400 --classification inconclusive --asset-policy keep --preview
```

Retirer `--preview` uniquement pour enregistrer cette déclaration. V5 reçoit
les événements expense/release/revenue non nuls, avec références humaines
uniques ; le reliquat est libéré. La réservation de B reste intacte. Une seconde
clôture est refusée, même si les valeurs sont identiques. Les fichiers V7
`experiment-result.json` et `economic-history.json` ne sont jamais réécrits.

Pour une recette passive constatée après clôture, créer une référence de reçu
UUID une seule fois, la conserver et la réutiliser si l'on vérifie un doublon :

```sh
node --input-type=module -e 'import { randomUUID } from "node:crypto"; console.log("receipt-" + randomUUID())'
SCOUT_MODE=projects node dist/index.js --record-passive-revenue PROJECT_ID --experiment-id EXPERIMENT_ID --asset-id ASSET_ID --receipt-id RECEIPT_ID --revenue-cents 1300 --preview
```

Retirer `--preview` pour la déclaration humaine définitive. Un receipt_id déjà
enregistré est refusé dans tout le batch, même pour un autre projet. Le système
ne peut pas reconnaître une même vente déclarée sous deux références nouvelles :
la correspondance vente/reçu reste à la charge de l'humain. Aucun secret ni
identifiant financier ne doit être saisi comme référence ; seul `receipt-UUID`
est accepté. Montants : chiffres décimaux entiers, pas de négatifs, float,
notation scientifique, NaN, Infinity, signe `+` ou zéros ambigus.

```sh
SCOUT_MODE=projects node dist/index.js --retire-asset PROJECT_ID --experiment-id EXPERIMENT_ID --asset-id ASSET_ID --preview
```

Le retrait définitif ferme la fiche d'actif et bloque les recettes suivantes.
Il ne supprime aucun produit sur Internet et ne déclenche aucune dépense.

### Résultat de test et résultat lifetime

Les projections projet/actif calculent les métriques à partir des événements
V9 contrôlés contre les entrées V5. Elles ne constituent pas un second ledger.
Le snapshot de résultat est immuable après clôture.

| Métrique | Exemple demandé |
| --- | --- |
| `experiment_expense_cents` | 600 |
| `experiment_revenue_cents` | 400 |
| Résultat de test à la clôture | −200 |
| `post_experiment_revenue_cents` | 1300 |
| `lifetime_revenue_cents` | 1700 |
| `lifetime_net_result_cents` | +1100 |

Le revenu passif est une nouvelle entrée revenue V5 et une référence de reçu
V9, sans réouverture, nouvelle réservation ou modification du résultat initial.
Les dates, IDs, durée, classification et statut d'actif sont disponibles pour
une analyse future ; aucun apprentissage V11 n'est exécuté.

### Liaison V8 facultative, sans nouveau pouvoir réseau

V8 garde son unique `webhook_ping` fixe et son approbation propre. V9 ne lance
aucune action externe. Pour attribuer un ping à un projet actif non expiré,
préparer d'abord le ping V8, puis le lier **avant son approbation V8** :

```sh
SCOUT_MODE=projects node dist/index.js --link-external-action PROJECT_ID --experiment-id EXPERIMENT_ID --action-id ACTION_ID --request-id V8_REQUEST_ID --preview
SCOUT_MODE=projects node dist/index.js --link-external-action PROJECT_ID --experiment-id EXPERIMENT_ID --action-id ACTION_ID --request-id V8_REQUEST_ID
SCOUT_MODE=approval node dist/index.js --approve-external V8_REQUEST_ID
SCOUT_MODE=external node dist/index.js --execute ACTION_ID --approval-request-id V8_REQUEST_ID --project-id PROJECT_ID --experiment-id EXPERIMENT_ID --preview
```

L'approbation économique du projet ne remplace jamais celle du ping. La liaison
historique authentifiée fixe action_id, request_id, leurs fingerprints,
project_id et experiment_id ; elle ne peut pas être déplacée vers B. Toute
exécution liée sans les IDs de projet, avec ceux de B, après échéance ou clôture
est refusée avant le réseau. Les pings V8 autonomes non liés conservent leur
fonctionnement V8. Aucune modification du payload, URL, limite ou capability
V8 ; aucun POST réel dans la validation V9 ci-dessous.

### Stockage, intégrité et concurrence

Le workspace reste `~/.automaton/scout-workspace`. Les vues runtime sont
`project-batch.json`, `projects.json`, `assets.json` et `project-report.txt`.
Elles sont comparées octet par octet à l'historique authentifié avant toute
opération. L'historique privé `state.json` et la clé `integrity-key` sont hors
du workspace modèle, dans `.scout-projects-<hash-du-chemin-workspace>`, voisin
de celui-ci. Permissions 0700/0600. `write_file` interdit les fichiers de
projet/actif et les temporaires économiques ; confinement et refus des liens
empêchent l'accès aux clés privées.

Chaque événement conserve les préfixes exacts du ledger avant/après et les IDs
d'entrées associées. Leur audit rejoue les transitions et vérifie types,
montants, réservation, description et référence humaine. Les ajouts V5/V7
légitimes sur d'autres expériences sont compatibles ; consommer une réservation
V9 en dehors de V9 provoque un refus à l'audit. Ne pas employer l'API hôte V5
pour modifier les réservations V9.

Toutes les opérations partagent le verrou exclusif V5–V8. En concurrence, une
seule gagne ; les autres échouent sans attendre ni voler le verrou. Un verrou
orphelin exige une inspection humaine. L'intention authentifiée `prepared` est
synchronisée avant toute écriture économique, puis viennent le ledger, les
vues et enfin `complete`. Un échec avant le premier rename laisse l'état
précédent intact. Une panne ultérieure peut laisser une transaction partielle :
V9 s'arrête fail-closed et ne rejoue ni ne répare automatiquement. Conserver
ensemble les preuves, l'historique privé et le ledger pour investigation.

La clé absente n'est jamais régénérée sur un état existant. Comme V6–V8, le
compte système, le code hôte et l'horloge font partie de la frontière de
confiance ; aucun mécanisme ne protège contre un administrateur contrôlant la
clé ou restaurant l'intégralité d'une ancienne sauvegarde signée.

### Validation Chromebook SANS argent réel

V9 au commit `7a83fe5` a été validée matériellement par l'opérateur : build,
109 tests V9, 344 tests V4–V8 et scénario fictif PASS. Cette validation ne porte
pas sur V10. Sur la branche `local-ollama-only`,
après intégration du bundle :

```sh
git branch --show-current
git log -1 --oneline
pnpm build
pnpm exec vitest run src/__tests__/scout-projects.test.ts
pnpm exec vitest run src/__tests__/scout-*.test.ts
node scripts/scout-v9-validation.mjs
```

Le dernier script crée un dossier temporaire neuf et un capital **fictif** de
100 EUR. Il appelle le même parseur et le même runtime que la CLI, avec un
workspace de test isolé ; il ne lit ni ne modifie le workspace économique réel.
Il vérifie successivement : batch explicite, deux projets à 10 EUR, troisième
refusé, deux réservations (80 disponibles/20 réservés), approbation A inutilisable
pour B, démarrage A, actif A conservé, clôture fictive à 600/400, doublon refusé,
recette passive fictive de 1300, doublon de reçu refusé, lifetime +1100, B
inchangé, ledger et historique authentifié valides. Le test d'échéance à sept
jours est couvert par Vitest avec une horloge simulée, sans attendre sept jours.

Résultat attendu : `"result": "PASS"`, avec les chemins des preuves temporaires
et les identifiants. Le dossier reste disponible pour inspection. Aucun vrai
POST, paiement ou modèle n'est appelé. Une nouvelle exécution du script crée
une nouvelle fixture isolée, sans réinitialiser le ledger de production.

## Scout V10 — Experiment Monitoring & Observation Engine

**NO REAL MONEY OR EXTERNAL ACTION IS PERFORMED BY V10**

V10 observe. V10 ne dépense pas, ne clôture pas automatiquement, ne transforme
pas une observation en revenu et ne fait aucun réseau. V10 ne remplace pas V7.
Il lit les projets V9 authentifiés, le ledger V5 et, uniquement sur demande,
un résultat V8 déjà enregistré. Aucun modèle, daemon, scheduler, polling,
paiement, nouvelle capability externe ou moteur d'apprentissage V11.
Les plafonds V9 restent deux projets, 1000 cents chacun, 2000 cents au total,
et sept jours maximum par expérience.

### Architecture et autorité

`monitoring-model.ts` définit les catégories, métriques, dates, checkpoints et
vues déterministes. `experiment-monitor.ts` orchestre les lectures authentifiées,
les contrôles de projet et les rapprochements. `observation-store.ts` conserve
le journal signé et ses projections. Tous réutilisent les primitives de lecture
confinée, écritures atomiques et verrou partagé V5, ainsi que l'audit V9, ses
identités et ses calculs financiers. V10 n'importe aucun écrivain du ledger ni
exécuteur V8. L'adaptateur de lecture historique V8 ne nécessite pas d'URL ni de
résolution DNS.

La définition du projet reste dans V9. Chaque observation fixe le project_id,
l'experiment_id, l'asset_id éventuel, un event_id runtime `observation-UUID`,
recorded_at, effective_at, type, source et data strictement typée. Les nombres
et empreintes des préfixes V9/V5 lus sont également liés à l'événement. Le rejeu
vérifie le contexte qui existait à son enregistrement : une clôture ultérieure
ne rend pas les observations antérieures invalides.

### Types et métriques bornés

| Type | Champs CLI obligatoires | Sens |
| --- | --- | --- |
| `traffic` | `--metric views\|clicks\|visitors --value N` | Compteur observé |
| `inquiry` | `--metric inquiries --value N` | Demandes reçues, pas des ventes |
| `lead` | `--metric leads --value N` | Contacts observés |
| `conversion_signal` | `--metric orders_claimed --value N` | Commandes annoncées, pas des revenus |
| `inventory` | `--metric units_remaining --value N` | Stock déclaré |
| `effort` | `--metric hours_spent_minutes --value N` | Temps observé, en minutes |
| `sale_claim` | `--amount-cents N` | Revenu allégué, non confirmé financièrement |
| `expense_claim` | `--amount-cents N` | Dépense alléguée, non confirmée financièrement |
| `note`, `risk`, `blocker` | `--note 'Texte court'` | Note humaine, jamais interprétée comme commande |
| `asset_status` | `--reported-status available\|unavailable\|unknown` | État signalé, ne change pas le lifecycle V9 |
| `external_action_result` | `--execution-id execution-UUID` | Référence à un résultat V8 déjà authentifié |

Les métriques sont des **relevés de valeur**, pas des incréments à additionner.
Views=20 à J1 puis views=45 à J3 donne 45, jamais 65. La dernière date effective
l'emporte ; en cas d'égalité, le dernier enregistrement l'emporte. Les métriques
de l'expérience et de l'actif passif forment deux séries distinctes.

| Borne runtime | Valeur |
| --- | --- |
| Événements par expérience, suivi passif et rapprochements compris | 128 |
| Événements totaux | 256 |
| Rapprochements totaux | 64 |
| Note | 500 caractères, sans caractères de contrôle |
| Métrique | Entier de 0 à 1 000 000 |
| Claim | Entier de 1 à 1 000 000 cents |
| Historique / rapport | 1 MiB / 64 KiB |
| Dates | ISO UTC exact avec millisecondes, années 2000 à 2099 |

Le plafond d'une claim est une limite de stockage d'un signal ; il ne constitue
jamais un budget autorisé. Les noms de métriques/catégories sont fermés. Floats,
NaN, Infinity, notation scientifique, nombres négatifs, `-0`, signes `+`, zéros
ambigus, champs inconnus et doublons CLI sont refusés.

### CLI et preview

Toutes les commandes utilisent `SCOUT_MODE=monitoring`. Le couple exact
project_id/experiment_id est requis, y compris pour les lectures. Aucun alias
`latest`, `current`, `all`, wildcard ou sélection du premier projet. Les valeurs
en majuscules ci-dessous sont des placeholders à remplacer par les IDs V9.

```sh
SCOUT_MODE=monitoring node dist/index.js --status PROJECT_ID --experiment-id EXPERIMENT_ID
SCOUT_MODE=monitoring node dist/index.js --timeline PROJECT_ID --experiment-id EXPERIMENT_ID
SCOUT_MODE=monitoring node dist/index.js --record-observation PROJECT_ID --experiment-id EXPERIMENT_ID --type traffic --metric views --value 20 --preview
SCOUT_MODE=monitoring node dist/index.js --record-observation PROJECT_ID --experiment-id EXPERIMENT_ID --type traffic --metric views --value 20
SCOUT_MODE=monitoring node dist/index.js --record-observation PROJECT_ID --experiment-id EXPERIMENT_ID --type inquiry --metric inquiries --value 2
SCOUT_MODE=monitoring node dist/index.js --record-observation PROJECT_ID --experiment-id EXPERIMENT_ID --type sale_claim --amount-cents 800 --preview
```

Retirer `--preview` pour enregistrer une observation humaine vérifiée. Cela
n'enregistre aucun revenu/dépense V5. Toutes les écritures V10 supportent
`--preview`, y compris checkpoints, observations passives et rapprochements.
L'aperçu valide et calcule sans créer/modifier historique, clé ou vues. Seul le
verrou temporaire commun est pris puis libéré. Un event_id d'aperçu est
hypothétique ; conserver celui renvoyé après enregistrement effectif.

`--status` affiche un rapport humain séparant explicitement
**CONFIRMED FINANCIAL DATA** et **OBSERVED / UNCONFIRMED SIGNALS**. Les autres
commandes renvoient du JSON avec l'événement, la timeline ciblée, le statut et
le rapport. Aucune somme alléguée n'entre dans les totaux financiers confirmés.

### Horloge, checkpoints et alertes

Les dates runtime viennent de l'horloge locale. Seul le code hôte de test peut
injecter l'horloge ; ni CLI ni variable d'environnement ne permettent de la
remplacer. `--effective-at 'YYYY-MM-DDTHH:mm:ss.sssZ'` peut préciser la date d'une
observation passée. Elle ne peut être future, antérieure au démarrage ou hors
de la fenêtre expérimentale. recorded_at reste la date runtime de saisie.
Les retours avant les événements V9/V10 ou le ledger déjà lus sont refusés.

Checkpoints disponibles : `start`, `day_1`, `day_3`, `day_5`, `deadline`. Ils sont
calculés depuis started_at, jamais depuis la première observation. Pour une
expérience plus courte, seuls les points strictement avant sa deadline sont
ajoutés, puis la deadline exacte ; aucun doublon ou checkpoint après l'échéance.
Le checkpoint s'appelle toujours `deadline`, même à J7.

```sh
SCOUT_MODE=monitoring node dist/index.js --checkpoint PROJECT_ID --experiment-id EXPERIMENT_ID --checkpoint day_1 --preview
SCOUT_MODE=monitoring node dist/index.js --checkpoint PROJECT_ID --experiment-id EXPERIMENT_ID --checkpoint day_1
```

Un checkpoint doit être explicitement nommé et déjà dû. Chaque checkpoint ne
peut être enregistré qu'une fois. Il n'atteste aucune vente, dépense ou réussite.
L'état temporel calculé est `not_started`, `active`, `checkpoint_due`,
`deadline_reached` ou `closed`. À la deadline, l'alerte est :
`DEADLINE_REACHED — HUMAN CLOSE REQUIRED`. Elle ne classe ni ne clôture le test.
Un checkpoint tardif ou une note rétrospective bornée reste possible tant que
V9 n'a pas clôturé ; après clôture, utiliser le suivi passif de l'actif.

Alertes locales : `CHECKPOINT_DUE`, `NO_OBSERVATION_YET`, `DEADLINE_REACHED`,
`PENDING_HUMAN_RESULT`, `ASSET_PASSIVE_MONITORING`, `UNRECONCILED_SALE_CLAIM`,
`UNRECONCILED_EXPENSE_CLAIM`. Aucune alerte n'est une approval ou un déclencheur.

### Rapprochement financier explicite

Une claim à 800 cents laisse les soldes, revenus/dépenses et lifetime inchangés.
La confirmation financière doit d'abord être effectuée séparément avec les
mécanismes existants. Pour les projets V9, les revenus d'expérience entrent au
ledger à la clôture explicite V9, qui réutilise les primitives financières V5/V7.
V10 n'ajoute pas de commande de revenu pendant une expérience encore active.

Après confirmation, copier le ledger_entry_id exact associé au résultat ou au
reçu V9 authentifié et cibler l'observation précise :

```sh
SCOUT_MODE=monitoring node dist/index.js --reconcile-observation PROJECT_ID --experiment-id EXPERIMENT_ID --observation-id OBSERVATION_ID --ledger-entry-id entry-000006 --preview
```

Le numéro d'entrée ci-dessus est un exemple ; utiliser l'entrée réelle exacte.
Retirer `--preview` pour ajouter l'événement de rapprochement. L'observation
initiale et l'écriture financière restent immuables. La vue dérive ensuite
`reconciled: true` du nouvel événement signé. Le ledger n'est jamais réécrit.

V10 exige : même projet/expérience, bon type revenue/expense, montant exactement
égal, écriture confirmée au plus tôt à la date effective de la claim, référence
appartenant au résultat d'expérience ou au reçu passif approprié. Une entrée
financière ne peut rapprocher qu'une claim, et une claim qu'une entrée. Pas de
rapprochement partiel, de plusieurs claims sur une vente globale, ni de sélection
par montant seul. Un JSON V7 isolé ou une recette globale sans lien V9 authentifié
ne prouve pas l'appartenance au projet et est refusé. V7 reste inchangé ; ses
expériences historiques autonomes ne sont pas automatiquement importées en V9.

Le rapprochement d'une ancienne claim reste possible après clôture/retrait de
l'actif s'il existe une preuve financière compatible ; il ne crée aucune
nouvelle observation commerciale et ne rouvre rien.

### Actifs passifs et résultats externes

Après clôture V9 avec actif en `passive_monitoring`, fournir son asset_id exact :

```sh
SCOUT_MODE=monitoring node dist/index.js --asset-observation PROJECT_ID --experiment-id EXPERIMENT_ID --asset-id ASSET_ID --type traffic --metric views --value 60 --preview
```

Types passifs permis : traffic, inquiry, lead, sale_claim, inventory, note, risk,
blocker, asset_status. Pas d'expense_claim ni de coût implicite. La date effective
doit être postérieure ou égale au passage en suivi passif. Une observation
classique sur l'expérience clôturée est refusée ; un actif retiré ou un projet
fully_closed sans actif passif refuse toute nouvelle observation. Une claim
passive se rapproche uniquement d'un revenu passif de cet actif, enregistré
séparément par V9.

```sh
SCOUT_MODE=monitoring node dist/index.js --record-observation PROJECT_ID --experiment-id EXPERIMENT_ID --type external_action_result --execution-id EXECUTION_ID --preview
```

Cette commande lit uniquement un résultat V8 existant et authentifié. L'action
V8 doit déjà être liée au même projet/expérience dans V9 ; une autre action,
un résultat absent ou altéré est refusé. Aucune exécution V8, connexion réseau,
lecture de réponse distante ou interprétation de body. Un résultat ne peut être
observé qu'une fois. L'empreinte de l'exécution et ses IDs restent liés au journal.

### Intégrité, limites et vues

`monitoring-history.json` et `monitoring-report.txt` sont des projections runtime
dans le workspace. L'historique autoritatif HMAC-SHA256 et sa clé locale sont
hors du workspace modèle, dans `.scout-monitoring-<hash-du-chemin-workspace>`,
répertoire voisin privé 0700, fichiers 0600. Aucune régénération silencieuse
si une clé/partie de l'état disparaît. Aucune édition ou suppression d'événement,
aucune purge ni réparation automatique.

Les mutations prennent le même verrou V5–V9, refusent symlinks/hardlinks et
vérifient les sources avant/après écriture. Le journal authentifié est écrit
atomiquement en phase prepared, puis les vues, puis la phase complete. Si le
premier remplacement échoue sur un état déjà établi, l'ancien état reste intact.
Une interruption ultérieure laisse un état incomplet qui bloque les écritures
jusqu'à investigation humaine, sans altérer le ledger ou V9. Aucun verrou
orphelin n'est volé. `write_file` refuse les fichiers `monitoring*` et le
confinement interdit l'accès au store privé.

Le rapport persisté est un **snapshot daté au dernier append V10**. Sa date et
ses états peuvent être anciens après une clôture V9 : `--status` recalcule la
vue actuelle sans réécrire le snapshot. Cela évite une réparation silencieuse
ou des écritures déclenchées par une simple lecture. La timeline conserve
l'ordre d'enregistrement ; effective_at permet de reconstruire la chronologie
observée, y compris les saisies tardives.

L'horloge système, le compte opérateur et le code hôte restent fiables par
hypothèse, comme V6–V9. La signature ne protège pas d'un administrateur
contrôlant les clés ou restaurant tout un ancien état signé. V10 ne déduit
jamais la réalité d'une vente à partir d'une note, d'un compteur ou d'un statut
HTTP. Aucune conclusion économique automatique ni apprentissage V11.

### Procédure Chromebook sans argent réel

**V10 reste à valider matériellement.** Depuis le dépôt intégré sur
`local-ollama-only` :

```sh
git branch --show-current
git log -1 --oneline
pnpm build
pnpm exec vitest run src/__tests__/scout-monitoring.test.ts
pnpm exec vitest run src/__tests__/scout-projects.test.ts src/__tests__/scout-experiment.test.ts src/__tests__/scout-ledger.test.ts src/__tests__/scout-approval.test.ts src/__tests__/scout-revenue.test.ts src/__tests__/scout-external.test.ts
pnpm exec vitest run src/__tests__/scout-*.test.ts
node scripts/scout-v10-validation.mjs
```

Le script crée un dossier temporaire neuf, jamais le workspace économique réel.
Capital fictif 100 EUR, A/B à 10 EUR chacun, deux démarrages explicites. L'horloge
de fixture avance directement à J1 (20 views, 2 inquiries), J3 (45 views,
4 inquiries, claim 800 cents), puis J7. Il vérifie ledger inchangé par les
signaux, alerte de deadline et absence de clôture automatique. Pour conserver
le fonctionnement financier V9 existant, il clôture alors explicitement A avec
800 cents fictifs de revenu, puis rapproche la claim avec cette entrée exacte.
Il contrôle l'absence de double revenu et, à J8, le suivi passif de l'actif,
l'indépendance de B et l'absence de nouvelle réservation/dépense. Aucune attente
réelle de plusieurs jours et aucun POST dans ce scénario.

Résultat attendu : `"result": "PASS"` et
`"notice": "NO REAL MONEY OR EXTERNAL ACTION IS PERFORMED BY V10"`.
Les preuves restent dans le dossier temporaire affiché. La simulation ne lance
aucune expérience réelle et ne modifie aucun état économique de production.
