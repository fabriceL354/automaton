# Scout V2 Web Research

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
si le Web échoue ; la limite de 12 tours finit l’exécution en erreur. Sans entrée
Web, le rapport local reste autorisé. Un ancien rapport ne satisfait pas ce garde.

`write_file` sans `path` écrit exclusivement `rapport.txt`. Le format explicite
`{"tool":"write_file","path":"notes.txt","content":"texte"}` reste accepté pour
les fichiers confinés ; le garde du rapport s’applique aussi à tout chemin normalisé
vers `rapport.txt`. Le prompt compact demande de synthétiser les sources, jamais de
recopier la mission. Les Sources sont ajoutées par le runtime, et l’arrêt reste
immédiat après relecture d’un rapport non vide.

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

`SearchProvider` isole le fournisseur derrière une petite interface.
L’implémentation fournie est DuckDuckGo HTML, par GET, gratuite et sans clé,
compte ou cookie. Elle utilise la version sans JavaScript décrite par le fournisseur :
https://duckduckgo.com/duckduckgo-help-pages/features/non-javascript

Ce service n’est pas une API avec garantie de disponibilité. CAPTCHA, blocage,
changement du HTML, absence de résultat reconnu ou redirection non sûre sont
signalés comme recherche indisponible. Aucun contournement, formulaire,
fournisseur payant ni fallback n’est ajouté. Les résultats sûrs sont limités
et les destinations sont contrôlées de nouveau avant lecture.

Les tests utilisent des réponses HTTP simulées ; la disponibilité réelle du
fournisseur doit être vérifiée sur la machine. Si DuckDuckGo bloque les GET,
utiliser `SCOUT_PUBLIC_URLS` pour lire directement des sources publiques connues.
Le contrôle réel dans cet environnement a échoué sur la résolution DNS de
`html.duckduckgo.com` (`EAI_AGAIN`) ; aucune fiabilité matérielle du moteur n’y
a donc été confirmée. La petite interface permet de remplacer le fournisseur ultérieurement sans
modifier le confinement ni la couche réseau.

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
```

Les tests simulent HTTP, DNS, redirections, SSRF, limites, timeouts, MIME,
recherche, extraction, exfiltration refusée, validation des actions, sources et
parcours mission → recherche → lecture → rapport. Ils ne dépendent pas d’Internet.
