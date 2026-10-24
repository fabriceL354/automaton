# Validation logicielle — V14.6.1 itération 2

Environnement : Node **22.23.3**, pnpm **10.28.1**, Vitest **2.1.9**. Dépendances existantes réutilisées à partir d'une installation locale ; aucun ajout ni modification des verrous. Aucun modèle Ollama disponible. Les chiffres ci-dessous concernent l'environnement de travail, pas le Chromebook.

| Vérification | Résultat |
| --- | --- |
| Build principal `pnpm build` | PASS, inclut la CLI |
| Build CLI explicite | PASS |
| TypeScript strict des entrées du laboratoire | PASS |
| Nouveaux cas de diagnostic | 51/51 PASS |
| Recherche + laboratoire + coordination, ciblés | 413/413 PASS |
| Ciblés étendus avec garde réseau hors ligne | 499/499 PASS, 6 fichiers, 111,72 s |
| Restauration/installateur Python | 21/21 PASS |
| Suite complète | 3 823/3 823 PASS, 92 fichiers, aucun test ignoré |
| Comparaison simulée original/explicite | 36 parcours chacun ; résultats et appels identiques |
| Probe candidates simulée | 6/6 extractions acceptées ; 1 appel chacune ; aucune validation économique |
| CLI `--variant=B` et choix de consigne | PASS, une seule variante et étiquettes de simulation vérifiées |
| Diff des fichiers de production par rapport à V14.6 | Vide |
| Branche | `local-ollama-only`, parent exact `1998a24e2bbd12d46d5f8f8ef6bd0a3ad9db3287` |
| Qwen réel après correctif | NON EXÉCUTÉ |

La suite complète réussie a duré **320,66 s**. Les journaux des tests contiennent parfois des erreurs attendues de bases volontairement incomplètes, injections ou répondeurs simulés ; elles ne constituent pas des échecs de test. Aucun service Scout ni ancien worker n'est démarré par la livraison. Les valeurs financières des fixtures ne sont jamais des opérations financières réelles.

Commandes principales, sans modification des délais de test :

```bash
pnpm build
pnpm --filter @conway/automaton-cli build
pnpm exec tsc --noEmit --strict --skipLibCheck --esModuleInterop --module NodeNext --moduleResolution NodeNext --target ES2022 experiments/v14-6-1/benchmark.ts experiments/v14-6-1/candidate-probe.ts
python3 -m unittest discover -s scripts -p test_apply_v14_6.py
NODE_NO_WARNINGS=1 AUTOMATON_RPC_URL=http://127.0.0.1:1 pnpm exec vitest run --maxWorkers=2 --minWorkers=1
node --import tsx experiments/v14-6-1/benchmark.ts --candidate-prompt=original --repetitions=3 --output=results/ab-original-scripted.json
node --import tsx experiments/v14-6-1/benchmark.ts --candidate-prompt=explicit --repetitions=3 --output=results/ab-explicit-scripted.json
node --import tsx experiments/v14-6-1/candidate-probe.ts --repetitions=3 --output=results/candidate-probe-scripted.json
```

Les essais Ollama d'enveloppe dans les tests unitaires substituent le transport. Ils ne démontrent ni une génération Qwen, ni sa vitesse. Le test réel fourni par l'utilisateur reste la seule mesure matérielle analysée. La validation économique reste **NON DÉMONTRÉE**.
