# Scout V1 locale

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
SCOUT_MODEL=qwen2.5:3b-instruct node dist/index.js --run
```

Les actions utilisent le format JSON structuré d'Ollama, puis sont validées et
exécutées par le runtime. Cela évite de dépendre du support natif des tools par
le petit modèle. Aucun texte du modèle n'est interprété comme une commande shell.

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
Un ancien rapport ne suffit pas. Maximum : 12 tours, 120 secondes par requête.
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
réseau. Ils ne mesurent pas la qualité du vrai modèle sur le matériel utilisateur.
