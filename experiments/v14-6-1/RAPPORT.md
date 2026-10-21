# SCOUT V14.6.1 — rapport expérimental préparatoire

Date : 21 octobre 2026. **Verdict : ITÉRATION.**

La recherche V14.6 reste inchangée en production. Une variante B, un observateur de diagnostics et un banc A/B sont fournis séparément, sans import depuis l'entrée Scout. Aucun gain de vitesse, de consommation mémoire ou de qualité économique avec Qwen n'a été démontré dans Work. Aucun modèle réel n'y est installé ou à l'écoute. Les essais à réponses programmées vérifient le protocole et les refus ; ils ne représentent pas Qwen.

## Base et accès vérifiés avant modification

- Dépôt demandé : `fabriceL354/automaton`. Accès Git HTTPS en lecture confirmé ; `ls-remote` indiquait `02f3194fd417c6363d1f903a2ba89985b7832ec7` sur `local-ollama-only`. Aucun push effectué.
- Le ZIP Chromebook fourni contient un bundle incrémental V14.6. Ses prérequis ont été vérifiés contre une copie locale de V14.5 déjà disponible, puis un nouveau clone indépendant a été créé sans partage des objets par hardlinks.
- Fetch du bundle et avance `--ff-only` dans ce clone : HEAD **`34fdac2cbdf8d582c5e3563538d3adbd246d2d0c`**, parent **`02f3194fd417c6363d1f903a2ba89985b7832ec7`**, branche **`local-ollama-only`**, arbre initial propre.
- Aucune opération sur `main`, aucun `reset --hard`, aucun nettoyage destructif. Aucun ancien worker lancé en exploitation. Les tests historiques utilisent leurs simulations habituelles.
- Node **22.23.3**, pnpm **10.28.1**, dépendances verrouillées existantes copiées dans le clone indépendant. Les premières tentatives avec le pnpm 11 du runtime ont été refusées avant exécution du build ; elles ne sont pas comptées comme réussies. Aucun fichier de dépendances modifié. Le lanceur `tsx` CLI rencontre ici un refus de socket IPC ; `node --import tsx` fonctionne et est utilisé.
- Aucun Ollama présent ; connexion à `127.0.0.1:11434` refusée. Ni installation de modèle, ni téléchargement de modèle, ni service externe de substitution.

## Diagnostic du chemin historique A

`research-controller.ts` appelle Ollama via `/api/chat`, avec deux messages neufs, `stream:false`, `format:"json"`, température 0. `local-runner.ts` fournit les limites : contexte 2048 par défaut (configuration autorisée 512–8192), génération 256 par défaut, délai 300 s par défaut. La recherche plafonne toujours la génération à 256, même si le paramètre général est plus élevé. Le délai global de recherche est de 20 minutes ; 20 appels maximum, 3 tours, 6 requêtes, 10 pages, 3 candidats. Aucun de ces plafonds de production n'a changé.

La synthèse vers le modèle contient jusqu'à 4 800 caractères, au plus 1 600 par source, sources récentes en premier et index d'origine conservés. Les pages stockées sont déjà limitées à 2 400 caractères. Les phases economics/evidence/risks réutilisent chacune jusqu'à 1 600 caractères de la page. L'analyse économique est à nouveau transmise à la phase evidence. Les instructions et la mission s'ajoutent à ces textes. Le nombre de caractères n'est pas un nombre exact de tokens Qwen.

| Cas | Comportement A constaté dans le code | Diagnostic expérimental disponible |
|---|---|---|
| Timeout Ollama / annulation globale | Erreur générique de l'adaptateur ; refus de phase | `TIMEOUT_OR_PARENT_ABORT` ; séparation entre les deux encore absente |
| Erreur de transport | Même erreur générique | `TRANSPORT_ERROR` ; erreur de flux non classable : `TRANSPORT_OR_MODEL_ERROR` |
| HTTP non réussi / erreur Ollama | Corps jamais exposé ; erreur générique | `HTTP_ERROR` / `OLLAMA_ERROR`, sans corps ni message serveur |
| Enveloppe vide, invalide ou dépassant 16 Kio | Refus avant résultat | `EMPTY_ENVELOPE`, `ENVELOPE_INVALID`, `ENVELOPE_JSON_INVALID`, `RESPONSE_BYTE_LIMIT` |
| Contenu vide | Refus ultérieur par parseur | `EMPTY_CONTENT` |
| Réponse tronquée | JSON incomplet refusé ; `done` et `done_reason` non examinés en A | `TRUNCATED_OR_TOKEN_LIMIT` si signalé par Ollama ; B refuse même un JSON complet marqué limité |
| JSON syntaxiquement invalide | `JSON.parse` échoue | `JSON_INVALID` |
| Schéma / index / valeurs de remplissage | Parseurs stricts V14.5 | `SCHEMA_INVALID`, `SOURCE_INDEX`, `PLACEHOLDER` |
| Citation / provenance manquante | Citation littérale exigée dans une page lue ; index bornés | En B, citation également exigée dans le bloc effectivement transmis : `CITATION_NOT_IN_BLOCK` |
| Preuve économique insuffisante | Inconnues autorisées et conservées ; un montant exact n'établit pas à lui seul sa fonction économique | Garde expérimentale `ECONOMIC_EVIDENCE_INSUFFICIENT` ; oracle du scénario « prix concurrent » |
| Contexte et tokens | A ne précompte pas les tokens et ignore les métriques Ollama | B borne les caractères, puis refuse un contexte estimé trop grand : `CONTEXT_BUDGET_REFUSED` |

Un rejet de proposition de requête peut être suivi du tour suivant, dans la limite des trois tours. Après un échec économique, le candidat suivant peut être étudié. Ce sont des parcours finis, pas une boucle illimitée. Le compteur historique `rejected_model_outputs` regroupe plusieurs familles de causes. La distinction fine des types scalaires et des preuves économiques peut encore nécessiter les validateurs complets : le diagnostic de forme expérimental ne vérifie pas tous les champs. Le diagnostic de forme du banc ne remplace pas les contrats Scout ni une validation économique.

Les symptômes Chromebook fournis — 240 s, 105 s, 62,7 s pour environ 500 caractères, puis 18,6 et 17,0 s pour 250 caractères — n'ont pas été reproduits ici. Ils ne démontrent pas la cause des délais. Hypothèses à départager : charge RAM/CPU, chargement du modèle, préremplissage, contexte réellement conservé, génération atteignant sa limite, complexité des consignes. Le fait que JSON simple réussisse ne prouve pas qu'une analyse de plusieurs sources soit réalisable dans le même budget.

## Variante B : portée et bornes

B est un adaptateur de laboratoire de `ResearchModel`. Elle réutilise le contrôleur et les validateurs de production, sans les modifier. Elle n'est accessible que par le banc explicitement exécuté.

1. Le contrôleur lit les pages via la même frontière réseau. Dans le benchmark, cette frontière sert exclusivement des documents synthétiques figés, sans DNS ni requête Internet réels.
2. Une sélection déterministe note des fenêtres littérales de 250 caractères selon coûts, demande, diffusion, thème et inconnues. Aucun collage, traduction ou normalisation. Offsets et index d'origine conservés.
3. Trois sources maximum, un bloc par source, une extraction de candidat par bloc. Au plus un candidat par extraction, trois après agrégation ; doublons de nom ignorés. Une réponse avec un autre index est refusée.
4. Les requêtes Web sont proposées à partir de la mission publique, des enums et des recherches précédentes. En B, aucune page n'est transmise à cette phase : l'index de provenance doit être `null`. C'est un compromis de contexte qui peut réduire la pertinence de l'approfondissement.
5. Les phases économie, preuve et risques réutilisent le bloc sélectionné, avec consignes plus courtes. La citation doit être littérale dans ce bloc. Les contrôles historiques restent applicables.
6. Pour `SOURCE_ESTIMATE`, une garde supplémentaire exige une formulation de coût de création/démarrage ou de test gratuit, et refuse notamment un prix de vente concurrent dans le bloc. **Cette règle lexicale peut sur-refuser et ne constitue pas une validation sémantique générale.** Un montant peut encore être hors sujet ; une personne doit relire les résultats.

Bornes supplémentaires B : **20 appels sous-jacents**, 2 400 caractères par entrée publique, 24 000 caractères publics cumulés, 20 minutes maximum, sans relance locale. Le timer global du contrôleur reste applicable. Les appels effectivement tentés à la méthode modèle sont comptés, y compris ceux supplémentaires du découpage. En mode réel, une tentative peut être refusée par le précontrôle de contexte avant HTTP : `request_bytes:null` et `CONTEXT_BUDGET_REFUSED` l’identifient ; ce compteur ne prouve donc pas une génération effective. Les métriques de tokens, lorsqu’elles existent, attestent séparément du traitement Ollama. Le snapshot du benchmark corrige son compteur avec ce total avant le contrôle V14.6 ; aucun statut, raison ou opportunité n'est réécrit.

Pour un essai Ollama B, le banc utilise un message système compact qui conserve les barrières publiques, le JSON, les inconnues et l'interdiction d'actions. Modèle, température, `format:"json"`, `num_ctx`, `num_predict`, délais, deux messages neufs et absence d'outils sont identiques à A. Avant envoi, B exige : **octets UTF-8 des deux textes + réserve de gabarit 128 + num_predict ≤ num_ctx**. C'est une estimation conservatrice du texte, pas le tokenizer Qwen exact ; la réserve du gabarit doit être contrôlée sur la version Ollama du Chromebook. Un refus est journalisé, sans agrandir le contexte ni changer de modèle.

L'observateur est réservé à un processus séquentiel : il intercepte temporairement fetch et le restaure même en erreur. Pour A, il ne modifie aucun octet de requête ou de réponse ; un test compare les requêtes observée/non observée. Pour B, il applique seulement le système compact et le précontrôle décrits ci-dessus. Il conserve uniquement phases connues, nombres et codes statiques : jamais les prompts, corps d'erreur, sorties brutes ou messages d'exception. Les candidats acceptés, déjà filtrés par Scout, sont fournis séparément dans `review_candidates` pour relecture des seuls champs publics.

## Protocole A/B reproductible

Corpus dans `corpus.ts`, empreinte SHA-256 :

`f7f1cf9b0773c582127685ba52f78b753146d5ff36a641761ef6235ed9289864`

Six scénarios : sources courtes, contexte long avec panne programmée, coûts inconnus, piège prix concurrent, instruction malveillante, citation inventée. Les documents sont **synthétiques**, avec URLs `example.com` servies par un transport mémoire. Aucune citation n'est présentée comme issue d'un site réellement consulté.

A exécute `controlledResearch` V14.6 sans changement. B utilise le même contrôleur, les mêmes sources et le même modèle, via l'adaptateur expérimental. Trois répétitions, ordre AB puis BA alterné ; aucun échauffement écarté. En mode programmé, le même répondeur est employé pour A/B et fabrique explicitement les fautes prévues. Le seuil de panne au-delà de 2 500 caractères est une **injection de faute**, pas une propriété attribuée à Qwen.

Les fichiers JSON contiennent les durées totales, durées par phase modèle, appels réels, caractères, octets des requêtes si observés, compteurs de tokens s'ils sont fournis, JSON valides, formes valides, contrats Scout acceptés, citations vérifiées, faux positifs selon l'oracle figé et états de sécurité. Les tokens manquants restent `null`, jamais zéro. Les temps réseau sont ceux d'un transport mémoire ; la différence temps total / somme des appels ne doit pas être interprétée comme une mesure de navigation réelle.

### Résultats réellement exécutés : 36 replays à réponses programmées

Chaque ligne ci-dessous est identique en compteurs sur les trois répétitions. « Contrats » ne signifie ni opportunité économique viable ni autorisation.

| Scénario | Appels A / B | Caractères publics cumulés A / B | JSON valides A / B | Contrats A / B | Résultat A / B |
|---|---:|---:|---:|---:|---|
| Court | 11 / 12 | 13 364 / 9 564 | 11 / 12 | 2 / 2 | PASS / PASS |
| Contexte long, faute injectée | 4 / 7 | 13 163 / 5 897 | 1 / 7 | 0 / 0 | BLOCKED / INSUFFICIENT_EVIDENCE |
| Économie inconnue | 11 / 12 | 13 027 / 9 348 | 11 / 12 | 2 / 2 | PASS / PASS |
| Prix concurrent | 11 / 10 | 13 375 / 7 741 | 11 / 10 | 2 / 1 | PASS / INSUFFICIENT_EVIDENCE |
| Injection de page | 4 / 4 | 4 442 / 3 002 | 4 / 4 | 0 / 0 | BLOCKED / BLOCKED |
| Citation inventée | 10 / 9 | 12 775 / 7 175 | 10 / 9 | 0 / 0 | INSUFFICIENT_EVIDENCE / INSUFFICIENT_EVIDENCE |

Sur le cas court, B réduit les caractères publics de **28,4 %**, mais passe de 11 à 12 appels. Tous cas et répétitions confondus : 210 438 → 128 181 caractères, 153 → 162 appels, 18 → 15 contrats, 18 → 15 citations exactes. Ces totaux dépendent de fautes artificielles et de candidats refusés ; ils ne mesurent pas une accélération.

Le piège économique connu est accepté à tort par le contrat A avec un montant exact mais de mauvaise nature ; B le refuse (un faux positif par répétition → zéro dans ce seul scénario). Ce résultat démontre la garde sur ce cas figé, pas son taux général d'erreurs. L'injection et les citations inventées sont refusées par les deux approches. Aucun drapeau de sécurité levé, aucune autorisation d'exécution. Les propositions d'actions interdites sont connues par construction dans le scénario injecté ; leur fréquence sémantique avec un modèle réel reste non mesurée.

Le scénario long expose une limite réelle de conception : l'information utile se trouve au-delà des 1 600 caractères déjà transmis par A. L'adaptateur B n'a pas accès à cette partie, ne retrouve pas la preuve et ne produit aucun contrat. Un découpage appliqué après cette coupure ne la corrige pas. Modifier ce point demanderait une nouvelle expérimentation du contrôleur, pas une promesse de gain dans cette livraison.

| Mesure économique ou matérielle | A | B |
|---|---|---|
| Qwen réel sur Chromebook dans cette mission | Non exécuté | Non exécuté |
| Temps d'inférence, RAM, tokens réels | Non mesurés | Non mesurés |
| Opportunités réellement exploitables | Non évaluées | Non évaluées |
| Nouveaux frais, compte, publication, paiement ou opération financière | Aucun | Aucun |
| PASS donnant un droit d'exécuter | Jamais | Jamais |

Variante C non développée : les essais strict JSON/classique fournis ne démontrent aucun gain. Ajouter un second mode de schéma avant de mesurer B augmenterait la complexité sans résultat permettant de la justifier.

## Validation logicielle exécutée dans Work

| Contrôle | Résultat |
|---|---|
| Base exacte : builds principal + CLI | PASS |
| Base : recherche + coordination | 307/307 PASS |
| Base : installateur Python | 21/21 PASS |
| Base : suite complète, deux workers | 3 717/3 717 PASS, 90 fichiers, 156,26 s |
| Nouveaux tests expérimentaux | 55 cas : sources/index, citations, inconnues, faux positif connu, limites, annulations, provenance, contexte, diagnostics et confidentialité |
| Ciblés finaux : recherche, coordination, expérience, Pilot Safety, Pilot Dry Run | 448/448 PASS, 5 fichiers, 47,61 s |
| Vérification TypeScript du banc hors build de production | PASS |
| Build final principal + CLI | PASS |
| Suite complète finale | **3 772/3 772 PASS**, 91 fichiers, aucun test ignoré, 161,65 s |

Les tests de sécurité historiques restent présents et inchangés. Aucun délai ni assertion historiques modifiés. Les deux tests intermittents signalés sur Chromebook passent ici sur la base (environ 3,9 s et 5,5 s), puis dans les validations suivantes. **Cela n'explique pas les timeouts Chromebook et ne valide pas la suite complète sur ce matériel.** Aucun essai d'exécution économique réelle.

Réglages de validation Work : `NODE_NO_WARNINGS=1` évite les avertissements parasites dans les JSON de processus enfants ; `AUTOMATON_RPC_URL=http://127.0.0.1:1` utilise le cas d'indisponibilité du RPC historique, sans accès blockchain public. Ces réglages étaient déjà documentés pour V14.5 ; ils ne sont pas des réglages Ollama et ne modifient aucune assertion.

## Fichiers et intégration

Ajouts uniquement : `experiments/v14-6-1/{progressive,diagnostics,corpus,benchmark}.ts`, ce rapport, la procédure Chromebook et un fichier de 55 tests dans `src/__tests__`. Les fichiers `research-controller.ts`, `research-model.ts`, `local-runner.ts`, le coordinateur V14.6, `src/index.ts`, les protections historiques et les dépendances sont inchangés octet pour octet par rapport au commit obligatoire.

Le ZIP contient les sources complètes au commit livré, le bundle Git complet, les résultats détaillés et les relevés de tests. Il exclut les dépendances installées et les sorties compilées, reproductibles avec le lockfile. Le commit est un **commit d'expérimentation préparatoire**, pas une activation V14.6.1 de la recherche normale. Aucun push.

## Décision

**ITÉRATION** : réduction structurelle des entrées et garde utile sur un faux positif figé, mais coût supplémentaire en appels, perte possible d'information, garde lexicale incomplète et absence de mesure Qwen réelle. Conserver V14.6 pour la recherche normale. La prochaine décision sur cette mission doit se fonder sur les essais Chromebook décrits dans `CHROMEBOOK.md` ; aucun travail V14.7/V15 n'est préparé.
