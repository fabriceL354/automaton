# Scout V14.6.1 — itération 2 : validation Qwen ciblée

Ce laboratoire est indépendant de l'installation habituelle. La V14.6 reste en production. Les essais ne lancent ni Scout, ni worker, ni action économique. Ils utilisent uniquement le corpus synthétique figé et, avec `--ollama`, le modèle déjà installé sur `127.0.0.1:11434`. Ne pas télécharger de modèle pour cette validation.

## 1. Ouvrir le nouveau laboratoire

Décompresser `SCOUT_V14_6_1_ITERATION_2.zip`. Dans le gestionnaire de fichiers, ouvrir un terminal dans le dossier décompressé contenant le bundle, `DELIVERY.json` et `SHA256SUMS`. Ce dossier n'est pas `~/automaton`.

```bash
sha256sum -c SHA256SUMS
git clone --single-branch --branch local-ollama-only SCOUT_V14_6_1_ITERATION_2.bundle "$HOME/scout-v1461-i2-lab"
cd "$HOME/scout-v1461-i2-lab"
git branch --show-current
git status --porcelain
git log -3 --format='%H %s'
```

Arrêter si une commande échoue. Si le dossier cible existe, le conserver et choisir un autre nom : ne pas l'écraser. Branche attendue : `local-ollama-only`, état propre. HEAD doit correspondre à `DELIVERY.json` ; parent exact : `1998a24e2bbd12d46d5f8f8ef6bd0a3ad9db3287` ; grand-parent : `34fdac2cbdf8d582c5e3563538d3adbd246d2d0c`. Aucune branche `main` n'est importée.

Vérifier l'absence de modification de production :

```bash
git diff --exit-code 34fdac2cbdf8d582c5e3563538d3adbd246d2d0c HEAD -- src/agent src/index.ts src/scout-web packages/cli package.json package-lock.json pnpm-lock.yaml
```

Résultat attendu : aucun diff, code 0. Ne pas exécuter l'installateur V14.6 sur ce laboratoire.

## 2. Préparer et vérifier le code

Utiliser l'installation Node/pnpm déjà fonctionnelle ; Node 22 et pnpm 10.28.1 sont recommandés pour reproduire les vérifications. Aucun nouveau paquet n'est ajouté par ce correctif.

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @conway/automaton-cli build
NODE_NO_WARNINGS=1 AUTOMATON_RPC_URL=http://127.0.0.1:1 pnpm exec vitest run src/__tests__/scout-candidate-diagnostics-experiment.test.ts src/__tests__/scout-research-progressive-experiment.test.ts src/__tests__/scout-research-autonomy.test.ts src/__tests__/scout-coordination-preview.test.ts --maxWorkers=2 --minWorkers=1
mkdir -p results
node --import tsx experiments/v14-6-1/candidate-probe.ts --repetitions=1 --output=results/candidates-scripted.json
```

Les quatre fichiers ciblés contiennent 413 tests. Le dernier essai utilise des réponses programmées : il vérifie le protocole, pas Qwen. En cas d'échec, conserver le diagnostic ; ne pas augmenter les délais ou changer les assertions.

## 3. Test Qwen court : seulement candidates

Vérifier le modèle existant, fermer les applications consommatrices, alimenter le Chromebook et relever la mémoire disponible. Ne pas exécuter plusieurs bancs simultanément.

```bash
ollama --version
ollama list
free -h
SCOUT_NUM_CTX=2048 SCOUT_NUM_PREDICT=256 SCOUT_TIMEOUT_MS=105000 node --import tsx experiments/v14-6-1/candidate-probe.ts --ollama --repetitions=1 --output=results/SCOUT_CANDIDATES_I2_R1.json
```

Deux appels au maximum : un avec la consigne B originale et un avec la consigne explicite, chacun sur la même première source du cas court (index global **1**, `research-source-2`). L'extrait, la mission, le système compact, le modèle, le mode JSON et les paramètres restent identiques entre les deux bras. Aucun appel `query_proposal` n'est nécessaire. Prévoir environ 3 min 30 s si les deux appels atteignent chacun le timeout de 105 s, hors surcharge système ; ce n'est pas une garantie de durée murale.

Le JSON est enregistré après chaque bras. `EXTRACTION_ACCEPTED` signifie uniquement que le contrat d'extraction est accepté. Vérifier `candidate_count` : zéro signifie abstention, pas découverte d'une opportunité. `economic_validation` reste `NOT_PERFORMED`. Les lignes `calls` contiennent `diagnostic`, `field_issues`, les durées et les tokens disponibles, sans réponse brute ni prompt. Un `SCHEMA_INVALID` sera accompagné, par exemple, de `{"field":"source_index","category":"TYPE"}` ; la valeur fautive n'est jamais enregistrée.

Si les deux bras terminent sans incident mémoire, répéter de façon appariée :

```bash
SCOUT_NUM_CTX=2048 SCOUT_NUM_PREDICT=256 SCOUT_TIMEOUT_MS=105000 node --import tsx experiments/v14-6-1/candidate-probe.ts --ollama --repetitions=3 --output=results/SCOUT_CANDIDATES_I2_R3.json
```

Six appels maximum, ordre original/explicite puis explicite/original puis original/explicite. Aucun échauffement n'est exclu ; distinguer le premier appel froid des suivants. Ne pas comparer la durée de ce test à la durée de l'ancien parcours complet.

## 4. Ensuite seulement : parcours complet

Commencer par B avec la consigne explicite, mêmes paramètres que le fichier matériel fourni :

```bash
SCOUT_NUM_CTX=2048 SCOUT_NUM_PREDICT=256 SCOUT_TIMEOUT_MS=105000 node --import tsx experiments/v14-6-1/benchmark.ts --ollama --variant=B --candidate-prompt=explicit --scenario=short --repetitions=1 --output=results/SCOUT_B_I2_SHORT.json
```

Pour reproduire B avec son ancienne consigne, remplacer `explicit` par `original` et choisir un autre fichier de sortie. Sans `--variant`, A puis B sont exécutés, avec inversion d'ordre sur les répétitions paires. A conserve ses requêtes de production. Pour une comparaison A/B complète répétée :

```bash
SCOUT_NUM_CTX=2048 SCOUT_NUM_PREDICT=256 SCOUT_TIMEOUT_MS=105000 node --import tsx experiments/v14-6-1/benchmark.ts --ollama --candidate-prompt=explicit --scenario=short --repetitions=3 --output=results/SCOUT_AB_I2_SHORT_R3.json
```

Plafonds inchangés par bras : 20 appels, 20 minutes, 2 400 caractères par entrée B, 24 000 caractères cumulés, 250 caractères par extrait, 3 sources au maximum. Garde de contexte B conservée : octets UTF-8 du texte + 128 de réserve de formatage + `num_predict` ≤ `num_ctx`. Ce majorant n'est pas le tokenizer de Qwen ; des textes plus coûteux peuvent être refusés. Un refus ne justifie pas d'augmenter le contexte ou le timeout.

Comparer séparément : JSON lisibles, schémas, provenance, contrats Scout acceptés et citations exactes. Le nombre d'appels peut augmenter lorsqu'un bras auparavant bloqué progresse vers les phases suivantes ; cela ne constitue pas une régression automatique ni un gain démontré. Un corpus synthétique ne prouve jamais une opportunité exploitable : `economically_exploitable` reste `null`, `execution_authorized_count` doit rester 0 et `coordinator_model_calls` doit rester 0.

Si interruption : Ctrl+C. Un fichier incomplet ne compte pas comme succès. Ne pas multiplier les relances d'un test bloqué.

## 5. Retrouver les fichiers et quitter le laboratoire

Les résultats sont dans le dossier Linux `scout-v1461-i2-lab/results` et non dans Téléchargements. Pour afficher leur chemin exact dans le terminal :

```bash
pwd
ls -l results
realpath results/SCOUT_CANDIDATES_I2_R1.json
```

Transmettre d'abord `SCOUT_CANDIDATES_I2_R1.json`. Aucun export de réponse brute n'est nécessaire.

Pour reprendre la V14.6 habituelle, quitter simplement ce laboratoire et revenir au dépôt habituel après vérification de sa branche et de HEAD. Aucun installateur n'a été appliqué, aucun changement de production n'est à annuler.
