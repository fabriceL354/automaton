# Scout I3 — test economics court sur Chromebook

Le test se déroule dans un nouveau laboratoire. Il ne lance pas Scout et ne modifie pas votre V14.6 habituelle. Il utilise cinq sources synthétiques figées et le modèle déjà installé ; aucun téléchargement de modèle, recherche Web ou action économique.

## 1. Ouvrir un laboratoire neuf

Décompresser `SCOUT_V14_6_1_ITERATION_3.zip`. Ouvrir un terminal dans le dossier qui contient `DELIVERY.json`, `SHA256SUMS` et le bundle. Exécuter les blocs un par un et arrêter à la première erreur.

```bash
sha256sum -c SHA256SUMS
git clone --single-branch --branch local-ollama-only SCOUT_V14_6_1_ITERATION_3.bundle "$HOME/scout-v1461-i3-lab"
cd "$HOME/scout-v1461-i3-lab"
git branch --show-current
git status --porcelain
git log -4 --format='%H %s'
git fsck --full
```

Si le dossier existe déjà, le conserver et choisir un nouveau nom. Branche attendue : `local-ollama-only`. État attendu : propre. HEAD doit être le commit indiqué dans `DELIVERY.json`. Son parent doit être **09d2590e670533226bf95a162901e032546b940f**, puis viennent **1998a24e2bbd12d46d5f8f8ef6bd0a3ad9db3287** et **34fdac2cbdf8d582c5e3563538d3adbd246d2d0c**.

Vérifier les fichiers de production :

```bash
git diff --exit-code 34fdac2cbdf8d582c5e3563538d3adbd246d2d0c HEAD -- src/agent src/index.ts src/scout-web packages/cli package.json package-lock.json pnpm-lock.yaml
```

Résultat attendu : aucun diff, code 0. Ne pas lancer `apply_v14_6.py`, `dist/index.js --run` ou un worker.

## 2. Vérifier le laboratoire

Reprendre Node 22 et pnpm 10.28.1 déjà fonctionnels. Aucun paquet supplémentaire n'est ajouté par I3. L'installation suivante prépare seulement les dépendances du nouveau dossier.

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @conway/automaton-cli build
NODE_NO_WARNINGS=1 AUTOMATON_RPC_URL=http://127.0.0.1:1 NODE_OPTIONS="--import=$PWD/scripts/scout-offline-test-guard.mjs" pnpm exec vitest run src/__tests__/scout-economics-experiment.test.ts src/__tests__/scout-candidate-diagnostics-experiment.test.ts src/__tests__/scout-research-progressive-experiment.test.ts src/__tests__/scout-research-autonomy.test.ts src/__tests__/scout-coordination-preview.test.ts --maxWorkers=2 --minWorkers=1
mkdir -p results
node --import tsx experiments/v14-6-1/economics-probe.ts --output=results/ECONOMICS_SCRIPTED.json
```

Le dernier essai utilise des réponses programmées. Il doit indiquer deux appels au total, un par bras, sur `documented`. Ce n'est pas un test de Qwen. Le résultat dans `results` porte une étiquette explicite de simulation. Le décompte exact des tests livrés figure dans `VALIDATION_ITERATION_3.md`.

## 3. Test Qwen initial : deux appels maximum

Fermer les applications consommatrices, brancher le Chromebook et vérifier le modèle existant. Conserver aussi ces versions pour comparer les répétitions :

```bash
ollama --version
ollama list
free -h
SCOUT_NUM_CTX=2048 SCOUT_NUM_PREDICT=256 SCOUT_TIMEOUT_MS=105000 node --import tsx experiments/v14-6-1/economics-probe.ts --ollama --output=results/SCOUT_ECONOMICS_I3_SHORT.json
```

Cette commande ne fait **ni propositions de recherche, ni extraction de candidats, ni phases evidence/risks**. A reproduit l'economics expérimentale actuelle ; B utilise la proposition I3. Même modèle `qwen2.5:1.5b-instruct`, même cas figé, même système, mêmes réglages et même oracle. Un appel par bras, aucun retry. Si A expire ou rencontre une erreur de transport, le test s'arrête avec un seul résultat ; ce n'est pas une comparaison A/B terminée.

Le fichier est écrit après chaque bras. Deux timeouts représenteraient 210 secondes de budget d'appel, mais le programme s'arrête au premier ; la durée murale dépend aussi du système. Ne pas augmenter le contexte, les tokens ou le délai pour obtenir un succès. En cas de pression mémoire visible, interrompre avec Ctrl+C et conserver le fichier déjà écrit. Un fichier incomplet ou une absence de fichier n'est pas un succès.

## 4. Lire le résultat

```bash
python3 - <<'PY'
import json
from pathlib import Path
p = Path('results/SCOUT_ECONOMICS_I3_SHORT.json')
d = json.loads(p.read_text())
for r in d['results']:
    m = r['calls'][0]
    print(r['scenario'], r['variant'], r['status'], r['refusal'])
    print('ms=', m['duration_ms'], 'tokens entrée/sortie=', m['prompt_tokens'], m['output_tokens'])
    print('chargement/prefill/génération ns=', m['load_ns'], m['prompt_eval_ns'], m['eval_ns'])
    print('qualité avant garde=', r['model_quality_before_guard'])
    print('qualité après garde=', r['quality'])
PY
realpath results/SCOUT_ECONOMICS_I3_SHORT.json
```

`ECONOMICS_CONTRACT_ACCEPTED` valide le contrat de cette phase seulement. Vérifier `quality` et `model_quality_before_guard`. Des valeurs `null` pour les tokens/durées signifient information indisponible, pas zéro. `CALL_TIMEOUT` ne prouve ni un manque de RAM ni un blocage interne du modèle. Les hypothèses de supervision et de compte restent des hypothèses.

`scout_final_contracts_accepted=0`, `verified_live_citations=0`, `execution_authorized=false` et `economic_profitability_demonstrated=false` sont attendus même si les deux bras sont acceptés. Ce corpus ne contient aucune preuve commerciale réelle. Transmettre d'abord le seul fichier **SCOUT_ECONOMICS_I3_SHORT.json** ; aucun prompt ou réponse brute n'est nécessaire.

## 5. Extension après examen du test court

Si les deux bras ont terminé et que la mémoire reste stable, inverser l'ordre avec trois répétitions :

```bash
SCOUT_NUM_CTX=2048 SCOUT_NUM_PREDICT=256 SCOUT_TIMEOUT_MS=105000 node --import tsx experiments/v14-6-1/economics-probe.ts --ollama --repetitions=3 --output=results/SCOUT_ECONOMICS_I3_SHORT_R3.json
```

Six appels maximum, ordre AB/BA/AB, aucun échauffement exclu. Un échec de transport/délai interrompt la suite. Pour les cinq scénarios, procéder ensuite explicitement :

```bash
SCOUT_NUM_CTX=2048 SCOUT_NUM_PREDICT=256 SCOUT_TIMEOUT_MS=105000 node --import tsx experiments/v14-6-1/economics-probe.ts --ollama --scenario=all --output=results/SCOUT_ECONOMICS_I3_ALL.json
```

Dix appels maximum pour ce dernier test. Les plafonds globaux de 20 appels, 24 000 caractères cumulés et 20 minutes restent appliqués par invocation. `--scenario=all --repetitions=3` est donc refusé avant tout appel ; répéter séparément un scénario si nécessaire. Ne pas lancer plusieurs benchmarks simultanément. Sans `--ollama`, tout résultat est programmé. `--scripted-faults` est réservé aux tests programmés et refusé avec Ollama.

## 6. Retour arrière vérifiable

Pour retrouver votre V14.6 habituelle, quitter le dossier de laboratoire et revenir à votre dossier habituel : rien n'y a été installé ou modifié.

Pour vérifier aussi la réversibilité Git de I3, faire le contrôle suivant dans une **copie neuve** du laboratoire. Ne pas l'exécuter dans le dépôt de production :

```bash
cd "$HOME/scout-v1461-i3-lab"
git clone --local --single-branch --branch local-ollama-only . "$HOME/scout-v1461-i3-restore-check"
cd "$HOME/scout-v1461-i3-restore-check"
git status --porcelain
git log -1 --format='%H %P'
```

Arrêter si l'état n'est pas propre ou si le parent n'est pas `09d2590e670533226bf95a162901e032546b940f`. HEAD doit être celui de `DELIVERY.json`. Dans cette copie de contrôle uniquement :

```bash
scout_i3_commit=$(git rev-parse HEAD)
git -c user.name=ScoutLab -c user.email=scout-lab@local.invalid revert --no-edit "$scout_i3_commit"
git diff --exit-code 09d2590e670533226bf95a162901e032546b940f HEAD
git status --porcelain
```

Résultat attendu : arbre identique à I2 et état propre. La branche reste `local-ollama-only`. Le laboratoire initial et votre production restent disponibles. Aucun push n'est demandé ou effectué.
