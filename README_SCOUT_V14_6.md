# SCOUT V14.6 — Coordination Preview — Correctif expérimental

**État : intégration validée dans le vrai dépôt au départ exact V14.5.**
**Date : 19 octobre 2026**

Dépôt : `fabriceL354/automaton` — **exclusivement** `local-ollama-only`.
Point de départ exact : `02f3194fd417c6363d1f903a2ba89985b7832ec7`.

## Contenu

- `src/agent/coordination-model.ts` : lecture, validation stricte de la recherche V14.5, provenance, coûts/incertitudes, sortie typée ; aucun réseau ni outil économique.
- `src/agent/coordination-preview.ts` : coordination séquentielle, deux appels Ollama **optionnels** maximum, rapport JSON atomique dans le workspace ; aucun outil ni action réelle.
- `src/__tests__/scout-coordination-preview.test.ts` : tests Vitest de contrats, citations, coûts, injections, refus modèle, fichiers symlink/hardlink et CLI.
- `apply_v14_6.py` : intégration conditionnée à la bonne branche et au bon commit, ajoute les 3 fichiers TypeScript, cet installateur, ses tests Python et cette notice, ainsi que des points d'intégration minimaux à `src/index.ts` et `src/agent/local-tools.ts`. **Ne crée aucun commit et ne pousse rien.**
- `scripts/test_apply_v14_6.py` : 21 tests Python sur des dépôts jetables, dont 8 échecs de remplacement, un arrêt brutal, la reprise de restauration, les empreintes/modes et le refus des modifications utilisateur. Cette suite est aussi appelée par Vitest.

## Pourquoi ne pas activer l'orchestrateur Automaton ?

Les anciens workers/harness permettent potentiellement des outils trop puissants. Ce prototype n'importe aucun de ces systèmes, ne crée pas de projet, ne touche pas au ledger/approbations et n'exécute pas de shell pour le modèle.

## Installation et vérification sur le vrai dépôt — par Work ou Chromebook

Après extraction de l'archive, garder `apply_v14_6.py` à côté du dossier `src` fourni.

1. Vérifier le commit et l'état courant du dépôt **sans écraser les fichiers de l'utilisateur**.
2. Depuis un terminal, exécuter (remplacer `/chemin/vers/SCOUT_V14_6` par le dossier extrait) :

   ```bash
   python3 /chemin/vers/SCOUT_V14_6/apply_v14_6.py --check --repo ~/automaton
   ```

3. Si et seulement si le contrôle est OK :

   ```bash
   python3 /chemin/vers/SCOUT_V14_6/apply_v14_6.py --apply --repo ~/automaton
   ```

4. Dans le dépôt :

   ```bash
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/test_apply_v14_6.py
   pnpm build
   pnpm exec vitest run src/__tests__/scout-coordination-preview.test.ts
   pnpm exec vitest run src/__tests__/scout-research-autonomy.test.ts
   NODE_NO_WARNINGS=1 AUTOMATON_RPC_URL=http://127.0.0.1:1 pnpm exec vitest run --maxWorkers=6 --minWorkers=1
   git diff --check
   git status --short
   ```

5. Audit manuel obligatoire du diff, des imports transitifs, des tests de sécurité et du comportement des modes historiques. Ne commiter/pousser sur `local-ollama-only` **qu'après** validation complète ; ne jamais toucher `main`.

## Exécution explicite du preview (après validation des tests)

La recherche doit d'abord avoir produit `~/.automaton/scout-workspace/research.json` depuis `SCOUT_MODE=research`. Pour une première exécution **sans Ollama supplémentaire** :

```bash
SCOUT_MODE=coordination-preview automaton --run
```

La sortie est écrite dans `~/.automaton/scout-workspace/coordination-preview.json`, distinct de `research.json`, des projets, approbations et données comptables.

Pour **un test opt-in** du commentaire local Ollama (2 appels supplémentaires maximum ; 180 secondes pour le preview complet) :

```bash
SCOUT_MODE=coordination-preview SCOUT_COORDINATION_REVIEW=1 automaton --run
```

L'IA ne voit **pas les pages Web ni leurs citations brutes** dans ce preview ; seulement des métadonnées bornées et des blocs déterministes. Ses commentaires sont étiquetés « Avis IA non vérifié » et ne changent jamais la décision de l'hôte.

Un statut `PASS` signifie uniquement « analyse du snapshot exécutée sans incident » : il **ne signifie ni rentabilité ni permission d'exécuter**.

## Validation exécutée dans le vrai dépôt le 19 octobre 2026

Base exacte `02f3194fd417c6363d1f903a2ba89985b7832ec7`, dépôt propre, copie isolée sur `local-ollama-only`. Dépendances déjà présentes ; aucun changement de package.json ou de lockfile.

- Node **22.23.3**, pnpm **10.28.1**, Python 3.
- `--check` puis `--apply` sur le vrai dépôt : PASS, huit fichiers contrôlés.
- Régressions Python : **21/21 PASS**, dont huit échecs de remplacement et un arrêt brutal du processus. Comparaison des empreintes, modes, absences et état Git après restauration.
- `pnpm build` : **PASS**, projet principal et CLI.
- Vitest ciblé : **307/307 PASS** dans deux fichiers : coordination **21/21**, recherche V14.5 **286/286**. La suite Python est aussi exécutée par le nouveau test Vitest.
- Suite complète : **3717/3717 PASS**, **90/90 fichiers**, aucun échec ni test ignoré, code de sortie 0 ; durée 90,26 s. Base V14.5 : 3696 tests ; ajout V14.6 : 21 tests Vitest.
- CLI compilée : `--help` fonctionne, `SCOUT_MODE=coordination-preview ... --approve` est refusé sans bascule vers un autre mode.
- `git diff --check` : PASS.
- Tous les anciens fichiers de tests et modules de protection restent identiques. Seules deux insertions de production touchent l'existant : aiguillage CLI explicite et réservation des fichiers de rapport contre l'écriture par le modèle.
- Aucun ancien worker activé, aucune recherche réelle, aucun Ollama réel, aucune dépense, publication commerciale ou création de compte.

Un premier essai de build a échoué à cause d'un pnpm global différent et de node_modules reliés par symlink. Une copie locale des dépendances et le pnpm 10.28.1 exact ont résolu le problème d'environnement sans changement du dépôt. Cet essai n'est pas compté comme réussi.

## Risques et limites à confirmer

- SHA-256 de l'entrée garantit seulement le suivi des octets lus, **pas l'authenticité de la source Web** ni l'absence d'altération antérieure du snapshot.
- Une citation exacte prouve sa présence dans le texte enregistré, **pas que le fait économique concerne le projet**. Les coûts restent explicitement non prouvés.
- `safePath` + `O_NOFOLLOW` + vérification inode limitent les détournements de fichier ; un audit de race sur le workspace doit rester dans le protocole de test complet.
- Le modèle local 1,5B peut produire des commentaires non valides ; le preview retourne alors `BLOCKED` et aucun résultat exploitable.
- Pas de benchmark d'amélioration réalisé. L'adoption pour V15 dépend d'un gain mesurable, sur les **mêmes** recherches V14.5 figées, à modèle et paramètres constants.

## Retour arrière

- **Immédiat** : ne pas activer `SCOUT_MODE=coordination-preview` ; `SCOUT_MODE=research` continue à utiliser le code historique.
- **Code non commité** : après inspection des changements et sauvegarde de tout travail utilisateur, retirer les 3 nouveaux fichiers et inverser uniquement les deux insertions de `index.ts` et `local-tools.ts`. Ne jamais exécuter `git reset --hard` ni nettoyer les fichiers non suivis.
- **Après commit** : revert ciblé du commit V14.6 seulement, après vérification des changements ultérieurs, sans toucher `main`.

## Mesure comparative à réaliser

1. Figer un corpus de snapshots `research.json` (empreintes SHA-256) ; mêmes fichiers pour le preview et la baseline.
2. Exécuter 3 répétitions en mode déterministe et en mode Ollama optionnel ; mesurer temps additionnel, appels, taux de blocage et avis pertinents.
3. Noter séparément la validation économique des preuves/coûts, les faux positifs, les erreurs graves et la sécurité.
4. Décider GO/ITÉRATION/NO-GO ; ne pas déclarer une progression d'autonomie économique avant une validation reproductible.


## Corrections demandées et installation transactionnelle

`parseCoordinationOutput()` refuse désormais PASS si aucune opportunité structurellement valide n'est REVIEW_REQUIRED avec au moins une référence de source et un fait. Les rapports vides BLOCKED et INSUFFICIENT_EVIDENCE restent acceptés. Huit régressions couvrent les rapports vides, malformés, rejetés, incomplets et le rapport valide. Les types ResearchOpportunity et ResearchEvidence sont importés de leur module de définition réel research-model.ts.

L'installateur exige un dépôt propre, sans fichiers non suivis. Extraire le ZIP **hors du dépôt**. Il vérifie la branche, le commit exact, les collisions, les liens, tous les fichiers et les ancres avant installation. Il ne change aucune dépendance.

Avant la première écriture, l'installateur prépare toutes les nouvelles versions et sauvegarde durablement les originaux dans le répertoire Git `scout-v14-6-transaction`. Le manifeste conserve pour chacun des huit chemins l'empreinte SHA-256 et le mode de fichier, ou son absence initiale. Les remplacements sont atomiques fichier par fichier, pas globalement ; ne pas lancer de compilation ni d'autre éditeur pendant l'installation.

Une exception déclenche la restauration automatique des huit chemins et la vérification des empreintes, modes et absences. En cas d'arrêt brutal ou d'échec de restauration, le journal est conservé. Avant toute nouvelle édition, utiliser l'installateur du **ZIP extérieur** :

```bash
python3 /chemin/vers/SCOUT_V14_6/apply_v14_6.py --recover --repo ~/automaton
```

Cette commande vérifie tous les chemins et toutes les sauvegardes **avant** de restaurer. Elle refuse d'écraser un fichier modifié après installation ; en pareil cas, conserver le journal et sauvegarder les changements utilisateur avant intervention manuelle. Ne pas retirer le journal en cas d'échec. Une préparation interrompue avant l'écriture du manifeste ne peut avoir changé les fichiers du dépôt ; conserver le répertoire Git pour inspection au lieu de forcer une reprise.

Le journal reste disponible après une installation réussie pour permettre un retour arrière vérifiable **avant commit**. Il est extérieur à l'arbre suivi. Après commit, `--recover` refuse le nouveau HEAD ; utiliser un revert ciblé du commit, jamais reset --hard. Ne supprimer l'ancien journal qu'après livraison vérifiée ; il n'accorde aucun droit d'exécution à Scout.

Environnement de validation : Node 22 et pnpm 10.28.1, comme V14.5. `NODE_NO_WARNINGS=1` évite que les avertissements du proxy Work contaminent les sorties JSON de sous-processus. `AUTOMATON_RPC_URL=http://127.0.0.1:1` garde le cas d'indisponibilité RPC dans les tests historiques sans contacter la blockchain. Aucune assertion n'est supprimée ni aucun test ignoré. Les tests n'exécutent pas de workers réels.
