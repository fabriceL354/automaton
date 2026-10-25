# Scout V14.6.1 — itération 3 : economics isolée

Verdict : **ITÉRATION**. Le laboratoire est prêt pour des mesures Qwen. Aucun changement n'est intégré à la recherche ou au coordinateur. Le gain de fiabilité et de vitesse sur Qwen réel reste à démontrer.

## Périmètre et références

Branche unique `local-ollama-only`, sans push. Parent exact : `09d2590e670533226bf95a162901e032546b940f`, lui-même enfant de `1998a24e2bbd12d46d5f8f8ef6bd0a3ad9db3287`, enfant de V14.6 `34fdac2cbdf8d582c5e3563538d3adbd246d2d0c`. Reconstruction depuis le bundle de l'archive I2, contrôle `git fsck --full` réussi. Aucun fichier de production, verrou, dépendance, permission ou installateur modifié. Le bundle livré ne contient que la référence de branche expérimentale et ses ancêtres.

Les mesures Chromebook rapportées par l'utilisateur établissent un blocage à `economics` dans un parcours B : environ 405,8 s, six appels, un timeout dans les propositions de recherche, deux extractions de structure valide et un diagnostic `TIMEOUT_OR_PARENT_ABORT` à economics. Aucun contrat Scout ni citation vérifiée, statut `INSUFFICIENT_EVIDENCE`. Les JSON détaillés `SCOUT_B_I2_SHORT.json` et `SCOUT_CANDIDATES_I2_R3.json` n'étaient pas disponibles dans les fichiers retrouvés. Ces données déclarées ne sont pas remplacées par une reconstitution supposée du journal matériel.

## Diagnostic établi dans le code

1. `src/agent/research-controller.ts:localResearchModel` ouvre un appel frais à deux messages pour chaque phase : aucun historique de conversation n'est accumulé. Ollama reçoit `format=json`, `stream=false`, température 0, contexte configurable et `num_predict=min(256, réglage)`. La réponse complète est lue sous la limite de 16 Kio. Le transport de production masque les erreurs derrière une erreur statique ; il ne différencie pas délai, JSON d'enveloppe et erreur du serveur.
2. Le contrôleur borne une recherche à 20 minutes et 20 appels. L'adaptateur progressif conserve ces plafonds, borne chaque entrée à 2 400 caractères et le cumul à 24 000. Il transporte au maximum trois sources pour l'extraction, puis une seule fenêtre contiguë de 250 caractères pour economics d'un candidat. Une information économique ou une contradiction située ailleurs peut donc manquer au modèle.
3. Dans le parcours expérimental I2, le message système compact est remplacé au niveau du transport. Sa garde est : **octets UTF-8 des deux textes + 128 de réserve de formatage + num_predict ≤ num_ctx**. Ce majorant conservateur ne mesure pas les tokens Qwen ; la réserve de formatage n'est pas validée matériellement. Les enveloppes JSON HTTP ne sont pas assimilées aux tokens du modèle.
4. La requête economics répète la mission générale, le candidat, un extrait et un schéma de cinq champs. Ces informations sont renvoyées à chaque phase mais ne deviennent pas un historique transmis. Un long texte mission peut occuper de la place sans apporter de fait économique spécifique.
5. `diagnostics.ts` I2 vérifie les clés et certains textes pour economics ; `contract_shape_valid` ne prouve pas tous les types ni les invariants financiers. Le contrôle complet intervient ensuite dans `parseOpportunityPhases`, après les phases evidence et risks. Un succès de forme à economics n'est pas un contrat Scout final.
6. Les contrôles existants conservent citation littérale, montant cité pour `SOURCE_ESTIMATE`, invariants coût/base, bornes et absence d'autorisation. L'adaptateur I2 ajoute déjà un contrôle de contexte du coût. Ces vérifications sont conservées et ne constituent pas une preuve de vente ou de rentabilité.
7. Le diagnostic historique fusionne délai et annulation. Avec `stream=false`, aucun premier token n'est observable dans le corps avant le retour complet. En cas d'expiration sans enveloppe finale, les compteurs de tokens et durées d'inférence ne sont pas disponibles. Ils doivent rester `null`.

### Ce qui n'est pas établi

La cause du timeout historique reste **indéterminée**. Chargement à froid, vitesse de préremplissage ou de génération sur CPU, contention mémoire, erreur du service, réponse trop longue et annulation parent sont des hypothèses à distinguer, pas des conclusions. Aucune preuve d'OOM, de saturation du contexte ou de blocage interne de Qwen n'est disponible. La durée globale déclarée ne suffit pas à identifier le signal ayant expiré.

## Expérience proposée

Nouveaux fichiers uniquement. `economics-probe.ts` n'appelle ni recherche Web, ni extraction, ni coordinateur, ni worker. Il ne crée pas de projet, compte, paiement, publication, transaction ou contrat exécutable. Un appel economics par bras ; aucun retry, réparation JSON, fractionnement ou appel de synthèse.

**A** reconstruit exactement les octets du message utilisateur de l'economics progressive I2. Un test capture l'adaptateur d'origine et compare les textes sur les cinq scénarios. Un autre compare les enveloppes Ollama complètes, y compris le système compact. A est la référence expérimentale I2, pas la requête brute V14.6 hors adaptateur.

**B** remplace la mission générale par l'idée précise et transmet des phrases économiques littérales avec index de source et position. Le sélecteur déterministe conserve toutes les phrases reconnues comme économiques, y compris inconnues, frais, droits, prix, demande et contradictions. Il supprime uniquement les phrases exactement identiques. Il ne fusionne pas des fragments en citation et ne réécrit pas les chiffres. Les sources originales restent dans la fixture ; les positions sont vérifiées par comparaison exacte. Une entrée trop grande est refusée, sans supprimer discrètement des contraintes pour passer le budget.

La sortie reste le schéma strict de cinq champs. Le laboratoire vérifie immédiatement types, bornes, placeholders, clés exactes, confidentialité et relation coût/base. Un contrôle supplémentaire de B rejette des coûts non étayés, un conflit non signalé, des contraintes contredites et certaines affirmations commerciales manifestement non étayées. Il ne transforme jamais un prix de vente en coût initial. Une réponse inconnue peut être correcte ; elle ne valide pas la faisabilité économique.

Le reconnaisseur de faits est volontairement étroit : il reconnaît des formulations françaises explicites du coût initial total, de la supervision et du compte. Des formulations différentes, frais inconnus ou chiffres contradictoires maintiennent le coût inconnu. Il n'est pas un extracteur sémantique universel et peut refuser une bonne analyse ou manquer une ambiguïté. Les règles lexicales sur les résumés ne garantissent pas l'absence de toute hallucination. Ces limites interdisent l'intégration à ce stade.

Le schéma historique n'a pas de valeur `UNKNOWN` pour supervision et compte. Faute de preuve, B impose **15 min/jour comme hypothèse de laboratoire** et `account_required=true` comme hypothèse prudente. Le résultat porte explicitement ces réserves. Ce ne sont ni des faits vérifiés, ni des prédictions de travail réel. Étendre le schéma de production sort du correctif minimal présent.

### Données et décision économique

Les cinq cas figés sont : pilote chiffré à 8 EUR avec prix envisagé de 5 EUR ; idée avec coûts inconnus ; prix concurrent/avis/promesse de revenu trompeurs ; page demandant paiement/publication sans droits vérifiés ; sources indiquant 8 et 18 EUR avec frais inconnus. Tous sont synthétiques. Même le cas documenté contient des intentions, aucune vente observée et aucune rentabilité établie.

La phase economics historique ne possède pas de champs séparés de marge, revenu, preuve de vente ou décision de rentabilité. Le laboratoire améliore l'exposition des preuves et le contrôle des coûts ; il ne prétend pas résoudre toute l'analyse économique dans ce contrat. Les prix, intentions, revenus hypothétiques et contraintes restent explicitement distingués dans les passages et la consigne. Aucun montant de revenu prévisionnel n'est présenté comme un résultat réel.

L'oracle figé est distinct du reconnaisseur B et identique pour A et B. Il contrôle coût, contraintes et présence lexicale d'incertitude. Il accepte aussi un refus explicite dans le résumé de A : un schéma accepté décrivant un refus n'est pas automatiquement un faux positif commercial. Les évaluations du modèle avant garde et les résultats après garde sont conservés séparément. La qualité sémantique générale n'est pas certifiée par cet oracle.

## Mesures de taille avant/après

Audit exact de sérialisation via le constructeur existant et un transport mémoire programmé. **Aucun appel à Qwen**. Réglages 2048/256/105000, système identique. Les valeurs suivantes sont des octets d'enveloppe HTTP, pas des tokens ni des délais d'inférence.

| Scénario | A enveloppe | B enveloppe | Réduction | Sources A/B |
| --- | ---: | ---: | ---: | ---: |
| Documenté | 1 465 | 1 318 | 10,0 % | 1 / 1 |
| Coûts inconnus | 1 414 | 1 258 | 11,0 % | 1 / 1 |
| Chiffres trompeurs | 1 431 | 1 285 | 10,2 % | 1 / 1 |
| Refus | 1 434 | 1 227 | 14,4 % | 1 / 1 |
| Contradictions | 1 329 | 1 317 | 0,9 % | 1 / 2 |

Dans le cas documenté, le message utilisateur passe de 956 à 812 caractères (972 à 828 octets). Dans le cas contradictoire, B conserve 215 caractères de preuve contre 115 pour A, tout en réduisant légèrement l'enveloppe totale. Les détails complets sont dans `results/economics-wire-audit.json`. Il n'est pas établi qu'une réduction de ces tailles diminue les tokens ou le temps de Qwen.

## Réponses programmées : résultats et limites

Trois répétitions appariées AB/BA/AB par scénario, cinq invocations indépendantes de six appels chacune, soit 15 appels par bras et par série agrégée. Les plafonds par invocation restent 20 appels, 24 000 caractères cumulés et 20 minutes. Une invocation demandant les cinq cas avec trois répétitions serait refusée avant tout appel. La même réponse programmée est utilisée pour les deux bras d'un cas ; elle ne dépend pas de la consigne. Les durées quasi nulles sont celles du répondeur de test et ne mesurent aucune performance de modèle.

| Série | A | B |
| --- | --- | --- |
| Réponses prudentes | 15 schémas acceptés, dont 3 résumés de refus ; 12 évaluations utiles à l'oracle | 12 schémas acceptés, 3 refus de la garde ; 12 évaluations utiles |
| Réponse trompeuse programmée sur prix concurrent | 3 faux coûts acceptés à l'oracle | 3 réponses rejetées, sans réponse correcte de remplacement |
| Cas de refus, par série | 3 refus exprimés dans le résumé | 3 refus explicites de traitement |
| Appels supplémentaires B | Sans objet | 0 |

La garde évite le coût inventé prévu par le test. Elle ne démontre pas que Qwen raisonne mieux, ni qu'il produira davantage d'analyses utiles. Les trois rejets du cas trompeur sont également comptés comme évaluations non produites. A et B restent à zéro contrat Scout final et zéro citation Web réelle vérifiée : les appels evidence/risks et la coordination ne sont pas exécutés par ce probe. Aucune information synthétique n'est convertie en opportunité réelle.

## Diagnostics sûrs ajoutés

Les résultats ne contiennent ni prompt, réponse brute, résumé libre du modèle, corps d'erreur, secret ni donnée personnelle. Sont conservés : tailles en caractères/octets, nombre de sources et passages, offsets validés sous forme de booléen, compteurs d'appels, résultat du contrat et de l'oracle, durées murales, réception des en-têtes et lecture du corps, `prompt_eval_count`, `eval_count`, durées Ollama de chargement/préremplissage/génération/total et débits calculés si disponibles. Les valeurs de durée Ollama sont en nanosecondes. Les données absentes restent nulles.

Taxonomie : `EMPTY_CONTENT`, `JSON_INVALID`, `SCHEMA_INVALID`, coût/contrainte non étayé, contradiction omise, enveloppe invalide, limite de réponse, erreur HTTP/Ollama, réponse tronquée, refus de contexte, `CALL_TIMEOUT`, `PARENT_ABORTED` et annulation de transport non classée. Ces diagnostics établissent l'étape de l'échec, pas une cause matérielle telle qu'un OOM. Des tests injectent ces erreurs sans les attribuer au cas historique.

## Décision

**Validation du code :** voir `VALIDATION_ITERATION_3.md` et `VALIDATION.json` de livraison.

**Qwen réel :** non exécuté ici ; aucun Ollama joignable sur le port local lors du contrôle. Le probe initial Chromebook est limité à deux appels maximum, s'arrête plus tôt en cas de problème de transport/délai et enregistre après chaque bras.

**Qualité économique :** garde de non-régression validée sur fixtures ; raisonnement Qwen, utilité sémantique et potentiel commercial non démontrés. Comparer explicitement les résultats avant garde et après garde ; un rejet correct n'est pas une bonne évaluation produite.

**Utilisation autonome :** **NO-GO**. Aucun changement n'est intégré. Passer à une itération matérielle ciblée ; ne pas lancer V14.7, V15, plugins ou commercialisation.

**ITÉRATION**
