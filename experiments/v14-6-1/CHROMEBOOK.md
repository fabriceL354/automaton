# SCOUT V14.6.1 — laboratoire isolé sur Chromebook

**Cette livraison n'active pas B dans Scout.** Conserver l'installation V14.6 habituelle. Aucun paiement, achat, compte, publication ou lancement de worker. Les fichiers d'essai ne sont pas des rapports d'autorisation. Prévoir une session courte, puis poursuivre seulement selon les résultats et la mémoire disponible.

## Importer le commit exact sans modifier le dépôt habituel

Décompresser le ZIP hors de `~/automaton`. Depuis le dossier décompressé contenant `SCOUT_V14_6_1_EXPERIMENTAL.bundle` et `SHA256SUMS` :

```bash
sha256sum -c SHA256SUMS
# Le dossier cible doit être nouveau ; git clone refuse s'il existe déjà.
git clone --branch local-ollama-only SCOUT_V14_6_1_EXPERIMENTAL.bundle "$HOME/scout-v1461-lab"
cd "$HOME/scout-v1461-lab"
git branch --show-current
git status --porcelain
git log -2 --format='%H %s'
git rev-parse HEAD^
```

Branche attendue : `local-ollama-only`. État attendu : propre. Parent attendu : `34fdac2cbdf8d582c5e3563538d3adbd246d2d0c`. HEAD doit correspondre à `DELIVERY.json`. Si un résultat diffère, arrêter sans reset. Ce bundle complet conserve aussi les ancêtres et ne dépend pas de la disponibilité de GitHub. `main` n'est pas créée ni modifiée.

Contrôle de l'absence de changement de production :

```bash
git diff HEAD^ HEAD -- src/agent src/index.ts src/scout-web package.json pnpm-lock.yaml
```

Résultat attendu : aucun diff. Ne pas exécuter `apply_v14_6.py` sur cette livraison : la base V14.6 est déjà incluse dans le bundle.

## Vérification logicielle

Utiliser Node 22 et pnpm 10.28.1 (déjà utilisés pour le projet). Ne pas remplacer une installation fonctionnelle de Node/Ollama pour ce test.

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
python3 -m unittest discover -s scripts -p test_apply_v14_6.py
NODE_NO_WARNINGS=1 AUTOMATON_RPC_URL=http://127.0.0.1:1 pnpm exec vitest run src/__tests__/scout-research-progressive-experiment.test.ts src/__tests__/scout-research-autonomy.test.ts src/__tests__/scout-coordination-preview.test.ts src/__tests__/scout-pilot-safety.test.ts src/__tests__/scout-pilot-dry-run.test.ts --maxWorkers=2 --minWorkers=1
```

Attendus : builds PASS, Python 21/21, ciblés 448/448. Un dépassement de délai est un échec à relever ; ne pas élargir les délais ou modifier les assertions. Suite complète facultative selon charge, en conservant les mêmes workers :

```bash
NODE_NO_WARNINGS=1 AUTOMATON_RPC_URL=http://127.0.0.1:1 pnpm exec vitest run --maxWorkers=2 --minWorkers=1
```

Attendu logiciel : 3 772 tests ; ce résultat n'a pas été exécuté sur Chromebook par Work. En cas de timeout, conserver le nom, l'heure, la durée et l'état mémoire. Les deux incidents historiques ne sont pas considérés comme expliqués.

## Vérifier le protocole sans modèle

```bash
mkdir -p results
node --import tsx experiments/v14-6-1/benchmark.ts --repetitions=3 --output=results/scripted.json
```

Il s'agit de 36 parcours à réponses programmées et sources synthétiques. Ce n'est pas un benchmark de Qwen. Aucun modèle, Internet réel ou dossier personnel ne sont nécessaires.

## Première mesure Qwen réelle — petit cas uniquement

Vérifier qu'Ollama est déjà actif et que le modèle existe, sans le télécharger :

```bash
ollama --version
ollama list
free -h
```

Fermer les applications consommatrices, garder le Chromebook alimenté et relever les autres charges. Le banc contacte uniquement `127.0.0.1:11434` et le modèle fixé `qwen2.5:1.5b-instruct`. Il ne charge pas la configuration privée Scout. Ne pas exécuter plusieurs bancs en parallèle.

```bash
SCOUT_NUM_CTX=2048 SCOUT_NUM_PREDICT=256 SCOUT_TIMEOUT_MS=105000 node --import tsx experiments/v14-6-1/benchmark.ts --ollama --scenario=short --repetitions=1 --output=results/qwen-short-r1.json
```

Le délai 105 s est un **paramètre de protocole pour cet essai**, identique pour A/B ; il ne modifie pas le délai de production. Chaque bras garde sa limite globale 20 minutes et les 20 appels maximum. Les résultats sont enregistrés après chaque bras ; ne pas fermer le processus pendant l'écriture. Les champs `real_model_executed:true` signifient que le mode réel a été demandé et que les tentatives sont observées ; en cas de transport refusé, ils ne prouvent pas une génération réussie. Vérifier les lignes `calls`, les diagnostics et les tokens disponibles.

Si ce premier parcours tient en mémoire et produit des diagnostics exploitables, réaliser les répétitions appariées :

```bash
SCOUT_NUM_CTX=2048 SCOUT_NUM_PREDICT=256 SCOUT_TIMEOUT_MS=105000 node --import tsx experiments/v14-6-1/benchmark.ts --ollama --scenario=short --repetitions=3 --output=results/qwen-short-r3.json
```

Ensuite seulement, choisir un autre scénario par son nom dans `corpus.ts` (`unknown-economics`, `competitor-price-trap`, `forged-citation`, `page-injection`, `long-context-fault`), avec les mêmes paramètres. Le seuil de faute artificiel n'existe que dans le répondeur programmé ; le modèle réel reçoit les textes figés et peut réussir ou échouer autrement. Le cas long sert aussi à mesurer les informations perdues avant B. Ne pas multiplier les relances d'un essai bloqué. Pour interrompre : Ctrl+C ; aucun résultat interrompu ne doit être compté comme succès.

Le banc ne lit pas les captures, dossiers ou recherches personnelles et ne consulte pas Internet. Ne pas utiliser un rapport de recherche existant comme corpus sans une nouvelle procédure de confidentialité et de fixation des sources.

## Lecture et critères de décision

Comparer A/B par scénario et par répétition, en séparant premier appel froid et appels chauds à partir des lignes par phase. Vérifier :

- latence totale et par phase, appels réels, tokens disponibles et coût CPU du préremplissage/génération ; RAM/OOM à relever dans une note séparée ;
- JSON valides puis contrats acceptés et citations exactes, sans les confondre ;
- `review_candidates` : montant réellement lié au coût du projet, demande encore inconnue, compte/frais/distribution et risque conservés ;
- refus justifiés, faux positifs et propositions d'actions interdites après lecture humaine ;
- `coordinator_model_calls:0`, aucun `BLOCKED` transformé en `PASS`, aucun drapeau d'autorisation.

Le compteur `shape_valid` ne valide que les champs et quelques textes ; il ne remplace pas les contrats Scout. `economically_exploitable:null` est intentionnel : les sources synthétiques ne démontrent aucun marché réel. Les mesures de propositions interdites avec Ollama restent `null` jusqu'à une évaluation humaine ; zéro ne serait pas justifié. Un refus de budget de contexte ne se corrige pas en augmentant automatiquement `num_ctx` : relever le refus et conserver les paramètres appariés.

Pour envisager une intégration, demander un gain reproductible sur le temps total ou les contrats utiles sans hausse disproportionnée des appels, avec zéro régression de sécurité et sans transformer les inconnues en faits. Trois répétitions donnent une indication, pas une preuve statistique générale. Aucun `PASS` de recherche n'autorise un pilote réel. Variante C strict JSON non requise.

## Retour arrière vérifiable

Comme le dépôt habituel n'est pas modifié et B n'est pas activée, le retour immédiat consiste à quitter le laboratoire et reprendre `~/automaton` après contrôle de sa branche et de HEAD. Rien à désinstaller, aucune donnée métier à restaurer.

Pour retrouver le même contenu que la base tout en conservant l'historique, créer un nouveau clone puis annuler uniquement le commit expérimental :

```bash
git clone --single-branch --branch local-ollama-only "$HOME/scout-v1461-lab" "$HOME/scout-v146-base"
git -C "$HOME/scout-v146-base" log -1 --format='%H %s'
# Vérifier que le commit affiché correspond à DELIVERY.json avant de continuer.
git -C "$HOME/scout-v146-base" revert --no-edit HEAD
git -C "$HOME/scout-v146-base" diff --exit-code 34fdac2cbdf8d582c5e3563538d3adbd246d2d0c --
```

Le revert ne concerne que les ajouts expérimentaux dans ce nouveau clone `local-ollama-only`. Le dernier contrôle doit sortir avec code 0 et aucun diff : le contenu versionné est alors identique à V14.6, avec un historique explicite de l'annulation. Si le clone contient d'autres commits ou modifications, arrêter au lieu de les écraser. Aucun push, aucun nettoyage, aucun `reset --hard`.
