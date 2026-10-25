# Validation logicielle — Scout V14.6.1 itération 3

Environnement : Node **22.23.3**, pnpm **10.28.1**, Vitest **2.1.9**. Dépendances déjà installées réutilisées, aucun ajout ni changement de verrou. Réseau externe bloqué pendant les tests par `scripts/scout-offline-test-guard.mjs`. Aucun service Ollama joignable : **aucune validation Qwen matérielle**.

| Vérification finale | Résultat |
| --- | --- |
| Build principal, y compris CLI | PASS |
| Build CLI explicite | PASS |
| TypeScript strict du probe, de l'audit et du nouveau fichier de tests | PASS |
| Nouveaux tests economics | **83/83 PASS** |
| Recherche I2 + economics + coordination (5 fichiers du guide) | **496 tests**, inclus dans les ciblés étendus et la suite complète |
| Ciblés étendus : recherche, coordination, Web et sécurité | **756/756 PASS**, 7 fichiers, 3,59 s |
| Suite complète finale | **3 906/3 906 PASS**, 93 fichiers, aucun test ignoré, 149,07 s |
| Tests Python d'installation/restauration V14.6 | **21/21 PASS** |
| Réponses programmées prudentes | 5 invocations de 6 appels, 15 appels par bras |
| Réponses programmées avec faute économique | 5 invocations de 6 appels, coût concurrent fautif rejeté par B |
| Audit de sérialisation A/B | 10 enveloppes, transport programmé, aucune inférence |
| CLI courte par défaut | 2 appels au maximum ; test de non-régression inclus |
| Plan de 30 appels en une invocation | Refusé avant inférence ; test de non-régression inclus |
| Retrait inverse du correctif dans copie jetable | PASS, arbre I2 exact retrouvé |
| Revert du commit final depuis le bundle | Résultat et empreintes dans `VALIDATION.json` de livraison |
| Diff des fichiers de production par rapport à V14.6 | Vide |
| Intégration à Scout ou au coordinateur | Aucune |
| Push GitHub | Aucun |

Les 83 nouveaux tests vérifient notamment les octets de A contre I2, les types et invariants, les citations et indices, les coûts inconnus, les prix concurrents, les contradictions, les contraintes et hypothèses, la confidentialité, les enveloppes Ollama, les délais/annulations, les limites d'appels et l'absence d'autorisation. Aucun test existant n'est modifié ou affaibli.

Commandes de validation reproductibles après installation des dépendances :

```bash
pnpm build
pnpm --filter @conway/automaton-cli build
pnpm exec tsc --noEmit --strict --skipLibCheck --esModuleInterop --module NodeNext --moduleResolution NodeNext --target ES2022 experiments/v14-6-1/economics-probe.ts experiments/v14-6-1/economics-wire-audit.ts src/__tests__/scout-economics-experiment.test.ts
python3 -m unittest discover -s scripts -p test_apply_v14_6.py
NODE_NO_WARNINGS=1 AUTOMATON_RPC_URL=http://127.0.0.1:1 NODE_OPTIONS="--import=$PWD/scripts/scout-offline-test-guard.mjs" pnpm exec vitest run --maxWorkers=2 --minWorkers=1
```

Pour reproduire la série programmée, exécuter séparément les cinq identifiants `documented`, `unknown-costs`, `misleading`, `refusal`, `contradictory` :

```bash
node --import tsx experiments/v14-6-1/economics-probe.ts --scenario=documented --repetitions=3 --output=results/economics-scripted-documented.json
node --import tsx experiments/v14-6-1/economics-probe.ts --scenario=documented --repetitions=3 --scripted-faults --output=results/economics-faults-documented.json
node --import tsx experiments/v14-6-1/economics-wire-audit.ts --output=results/economics-wire-audit.json
```

Changer l'identifiant et le nom de fichier pour chaque cas. Ne pas utiliser `--scenario=all --repetitions=3` : le budget de 20 appels le refuse. Les agrégats livrés rassemblent les cinq fichiers indépendants. Les chronométrages et tokens d'inférence sont absents de l'audit de sérialisation, jamais fabriqués.

**Code : validé. Qwen réel : non validé. Raisonnement économique général : non démontré. Autonomie : NO-GO. Verdict : ITÉRATION.**
