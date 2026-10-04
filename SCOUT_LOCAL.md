# Scout V1.1 locale

Cette branche exécute Scout uniquement avec Ollama local. `--run` ne démarre
ni portefeuille, ni Conway, ni paiement, ni heartbeat, ni agent secondaire.
Il n'y a pas de logique de crédits ou de survie dans ce parcours.

## Démarrage

Prérequis : Node.js 20+, pnpm 10.28.1 et Ollama lancé sur cette machine.

```sh
pnpm install --frozen-lockfile
pnpm build
ollama pull qwen2.5:1.5b-instruct
mkdir -p ~/.automaton/scout-workspace
```

Créer `~/.automaton/scout-workspace/MISSION.txt`, par exemple :

```text
Lis MISSION.txt. Rédige en français un court rapport sur tes capacités locales
et tes limites. Enregistre-le dans rapport.txt avec write_file.
N'effectue aucune action externe.
```

```sh
node dist/index.js --run
```

La mission existante est automatiquement lue au démarrage, sans modification.
Scout dispose uniquement de `list_files`, `read_file` et `write_file`. Les chemins
sont relatifs à son workspace. Les liens symboliques, liens physiques multiples,
chemins hors du workspace et fichiers de plus de 128 Kio sont refusés.
`MISSION.txt` est protégé contre l'écriture par Scout.

Le modèle par défaut est `qwen2.5:1.5b-instruct`. Une configuration existante
Qwen 2.5 est conservée ; un ancien choix Gemma/cloud est remplacé par ce défaut.
Pour choisir explicitement un autre modèle **déjà installé localement** :

```sh
ollama pull qwen2.5:0.5b-instruct
SCOUT_MODEL=qwen2.5:0.5b-instruct node dist/index.js --run
```

## Réglages pour une petite machine CPU

Les valeurs par défaut réduisent le contexte et la longueur de génération pour
une machine CPU avec environ 3 Go de RAM. Le modèle principal reste
`qwen2.5:1.5b-instruct` ; le choix rapide `qwen2.5:0.5b-instruct` reste explicite,
sans changement automatique de modèle en cas d’erreur.

| Variable | Défaut | Plage autorisée | Effet |
| --- | ---: | ---: | --- |
| `SCOUT_NUM_CTX` | 2048 | 512 à 8192 | Taille du contexte Ollama en tokens |
| `SCOUT_NUM_PREDICT` | 256 | 64 à 2048 | Maximum de tokens générés par requête, JSON compris |
| `SCOUT_TIMEOUT_MS` | 300000 | 1000 à 1800000 | Délai maximum par requête en millisecondes |

```sh
SCOUT_NUM_CTX=2048 SCOUT_NUM_PREDICT=256 SCOUT_TIMEOUT_MS=300000 node dist/index.js --run
```

Une variable absente utilise le défaut. Une variable définie doit contenir un
entier décimal dans la plage indiquée, sans espaces, signe, décimales, exposant
ou zéro initial. Une valeur vide ou invalide arrête Scout avant tout appel
Ollama ; aucune correction silencieuse n’est appliquée.

Garder les missions, fichiers consultés et rapports courts avec ces défauts.
Le contexte inclut le prompt, la mission et l’historique ; les 256 tokens de
sortie incluent l’enveloppe JSON de l’action. Augmenter les limites pour une
mission plus longue consomme davantage de mémoire et de temps. Ces réglages
ne garantissent pas que le modèle tiendra dans 3 Go : cela dépend aussi de
sa quantification, d’Ollama et de la mémoire utilisée par le système.

Les requêtes utilisent `format: "json"` d’Ollama, sans JSON Schema contraint.
Ce choix suit le test matériel fourni : le modèle 1.5B répondait avec le mode
JSON simple, alors que le schema contraint dépassait le timeout. Le plafond
par défaut de 256 tokens favorise les rapports courts ; `SCOUT_NUM_PREDICT=128`
reste possible pour une mission très courte.

Avant toute exécution d’une action du modèle, le runtime exige un unique objet
JSON avec exactement trois propriétés `tool`, `path`, `content`, toutes de type
chaîne. Aucun champ supplémentaire, outil inconnu, objet imbriqué, tableau,
valeur null ou conversion automatique n’est accepté.

```json
{"tool":"list_files","path":"","content":""}
```

```json
{"tool":"read_file","path":"MISSION.txt","content":""}
```

```json
{"tool":"write_file","path":"rapport.txt","content":"La réponse complète à la mission."}
```

`list_files` exige deux arguments vides ; `read_file` exige un chemin relatif
non vide et un contenu vide ; `write_file` exige un chemin relatif non vide et
un contenu texte. Les chemins absolus, avec caractère nul ou sortant du
workspace sont rejetés avant exécution. Les outils vérifient ensuite le
confinement et les liens comme auparavant. Une action invalide n’exécute aucun
outil ; Scout reçoit une consigne de correction dans la limite des 12 tours.
Les outils natifs du modèle ne sont pas utilisés. Aucun texte du modèle n’est
interprété comme une commande shell.

`OLLAMA_BASE_URL` ou `ollamaBaseUrl` dans `~/.automaton/automaton.json` peut
choisir le port local. Seules les IP loopback `127.0.0.1` et `::1` sont autorisées ;
`localhost` est normalisé en `127.0.0.1`. Les redirections HTTP sont refusées.
Ne pas configurer Ollama en proxy vers un service distant et ne pas utiliser de
modèle cloud : ce runtime suppose un serveur Ollama local de confiance.

Scout termine immédiatement après une écriture réussie de `rapport.txt` :
le runtime relit le fichier via son outil confiné et vérifie qu’il est non vide.
Aucune action `finish` ni nouvel appel au modèle n’est nécessaire. Le prompt
demande que le fichier contienne la réponse complète à `MISSION.txt`, plutôt
qu’un simple message annonçant que le rapport est prêt.
Un ancien rapport ne suffit pas. Maximum : 12 tours ; timeout par requête de
300 secondes par défaut, réglable avec `SCOUT_TIMEOUT_MS`.
Une erreur Ollama n'entraîne aucun repli vers un autre fournisseur. Si le modèle
est absent, l'installer avec `ollama pull` puis relancer Scout.

Les commandes historiques de provisionnement, configuration et wallet sont
bloquées dans cette branche. `--help` et `--version` restent disponibles.
Le runtime ne lance pas de boucle de fond après le rapport. Relancer `--run`
pour une nouvelle mission. Le workspace doit rester privé et ne pas être modifié
concurremment par un autre processus pendant l'exécution.

## Vérifications

```sh
git diff --check
pnpm build
pnpm exec vitest run src/__tests__/scout-local.test.ts
```

Les tests utilisent un Ollama simulé : ils vérifient le parcours mission → outils
→ rapport, le confinement, l'absence de réussite fictive et l'absence de repli
réseau, les actions JSON invalides et les arguments interdits, ainsi que les défauts, bornes et valeurs invalides des réglages CPU.
Ils ne mesurent pas la qualité du vrai modèle sur le matériel utilisateur.
