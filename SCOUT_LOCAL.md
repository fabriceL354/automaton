# Scout V6 Approval Gate (local-only)

Scout utilise Ollama local pour l’inférence et un workspace confiné pour ses
fichiers. V2 ajoute uniquement des lectures Web publiques HTTPS. Aucun Conway,
wallet, paiement, compte, authentification, publication, shell accessible au
modèle, JavaScript exécuté, navigateur interactif ou binaire téléchargé/exécuté.
Les requêtes Web sont exclusivement GET : aucun POST/PUT/PATCH/DELETE, formulaire
soumis, cookie, jeton, corps de requête ou référent.
L’API Ollama locale conserve son POST d’inférence ; ce POST ne va jamais au Web.

## Démarrer

Prérequis : Node.js 20+, pnpm 10.28.1. Les modes local/opportunity/experiment
nécessitent aussi Ollama lancé localement et un modèle installé. Les modes
ledger/approval ne nécessitent ni Ollama, ni mission, ni réseau.

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
