# Scout V14.5 — Qualité minimale des réponses publiques

Point de départ: `130db156a4d928b7f330bcf8137bfd0efcfefd1c` ; branche **`local-ollama-only`**, jamais `main`.

La notice du correctif fourni signale des réponses de benchmark copiant les exemples de texte (`short`, `short uncertainty`). Le contrat V14.4 acceptait ces réponses peu exploitables. Les résultats historiques ne sont ni réécrits ni réévalués par ce correctif.

## Changements
- `researchText` refuse uniquement des valeurs de remplissage entières déjà observées dans le benchmark ou dans les exemples de requête. La validation stricte des sources, coûts, risques, textes et budgets existants reste inchangée.
- Les invites des phases `candidates`, `economics`, `evidence` et `risks` indiquent les limites de longueur et demandent des justifications liées aux faits, sans remplacer une inconnue par une certitude. Les prix et avis des concurrents ne constituent pas nos coûts de création ou nos ventes.
- Adaptation contrôlée du patch fourni : les exemples `short` de `tool_request` sont aussi remplacés, car ses champs utilisent le même validateur. Aucun changement de droit, de catégorie de données ou de capacité.
- Tests de non-régression sur les champs de remplissage, les noms, les outils, les coûts et la demande inconnus, les citations exactes, les bornes 80/160/180/240, les champs stricts, les textes dangereux et le comportement non exécutable du pipeline. Un mot `short` dans une description informative reste autorisé.

## Limites
Un contrat accepté n'est pas une preuve de qualité économique ou de ventes. Le rejet cible les valeurs entières connues du patch, pas toutes les formulations vagues possibles. Les nouvelles consignes ne sont pas une validation sémantique automatique. Aucun résultat historique n'est modifié. Le mode `think:false` n'est **pas** ajouté aux requêtes de production ; un test inspecte le corps Ollama simulé. Les plafonds de 10 EUR par projet et 20 EUR au total, les règles de preuve et les verrous V12–V14.4 restent inchangés.

## Commandes de validation
```bash
git diff --check
pnpm build
pnpm exec vitest run src/__tests__/scout-research-autonomy.test.ts --maxWorkers=2 --minWorkers=1
NODE_NO_WARNINGS=1 AUTOMATON_RPC_URL=http://127.0.0.1:1 pnpm exec vitest run --maxWorkers=6 --minWorkers=1
```

Utiliser pnpm 10.28.1, comme indiqué dans `package.json`, avec Node 22. Dans l'environnement Work utilisé pour cette validation, `NODE_NO_WARNINGS=1` évite qu'un avertissement du proxy Node contamine les sorties des processus enfants que les tests relisent en JSON. Le test historique `discover_agents turns are retained in context` contacte sinon un registre blockchain public et a dépassé son délai de 180 secondes. Le réglage RPC existant ci-dessus pointe vers un port local indisponible, garde le cas d'indisponibilité réseau et évite cet accès externe. Ce test a été vérifié isolément avec ce réglage. Aucune assertion ni protection Scout n'est modifiée. Utiliser `pnpm exec vitest run` pour cibler un fichier : la forme `pnpm test -- ...` a lancé ici toute la suite.

La validation matérielle Chromebook et un nouvel essai économique avec Ollama réel restent séparés. Aucun modèle réel n'est appelé par les tests de recherche ajoutés. Le correctif n'ajoute aucune vente, dépense, publication, action externe, wallet, compte, autorisation financière ou commande de lancement.

## Validation exécutée le 17 octobre 2026

- Base exacte et worktree initial propre confirmés avant application, puis SHA distant revérifié avant livraison.
- Archive entièrement inspectée avant exécution ; `--check` et remplacements du script compatibles avec la base réelle.
- `pnpm build` : PASS (projet principal et CLI) sous Node 22.23.3 / pnpm 10.28.1.
- Recherche ciblée : **286/286 PASS**, dont 58 cas de régression V14.5. Les tests de recherche préexistants restent identiques octet pour octet.
- Suite complète avec les réglages ci-dessus : **3696/3696 PASS**, **89/89 fichiers**, aucun échec ni test ignoré ; code de sortie 0, durée 216,54 secondes.
- Sécurité ciblée : **744/744 PASS**, 12 fichiers : `scout-pilot-safety`, `scout-pilot-preparation`, `scout-pilot-readiness`, `scout-operational-planning`, `scout-economic-handover`, `scout-seller-account`, `scout-documentary`, `tools-security`, `authority-rules`, `injection-defense`, `policy-engine`, `command-injection` (suffixe `.test.ts`). Commande : `NODE_NO_WARNINGS=1 pnpm exec vitest run` suivie des 12 chemins dans `src/__tests__/`, puis `--maxWorkers=2 --minWorkers=1`.
- Les premiers essais ont exposé les avertissements parasites et le délai réseau décrits ci-dessus. Ils ne sont pas comptés comme réussis. L'installation native initiale sous Node 24 a également échoué ; le passage à Node 22 a permis sa reconstruction sans changer les dépendances du dépôt.
- Aucun benchmark historique modifié ; aucun test Chromebook, Qwen réel ou essai de vente exécuté.
- `git diff --check` : PASS. Seuls `research-model.ts`, `research-controller.ts`, `scout-research-autonomy.test.ts` et cette note changent. Les modules de protection et les contrats V12–V14.4 restent inchangés.
