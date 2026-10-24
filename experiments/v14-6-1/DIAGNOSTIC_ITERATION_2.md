# Scout V14.6.1 — itération 2 : diagnostic Qwen réel fourni

## Conclusion

**ITÉRATION.** Le correctif est limité au laboratoire V14.6.1. La mesure matérielle fournie ne permet pas d'identifier rétrospectivement le champ exact rejeté : ni la réponse brute ni des catégories de champs n'avaient été conservées. Cette absence est respectée ; aucun contenu n'est reconstruit ou présenté comme observé. Les prochains essais disposent de diagnostics structurés sans valeurs ni clés arbitraires.

Le défaut de consigne identifié est une ambiguïté réelle : B montrait seulement `{"candidates":[]}` puis décrivait un candidat en prose. Un objet complet avec les trois champs attendus n'était pas montré. Cela rend plausible une réponse de forme différente sur un petit modèle, sans prouver que ce soit la cause historique. Une variante explicite remplace uniquement cette consigne ; la variante originale reste sélectionnable pour comparaison.

## Ce que démontre le fichier matériel

Source : `SCOUT_RESULTATS_QWEN.json`, corpus SHA-256 `f7f1cf9b0773c582127685ba52f78b753146d5ff36a641761ef6235ed9289864`, une répétition A puis B, Qwen 2.5 1,5B, CPU, 2 048 de contexte, 256 tokens de sortie et timeout demandé 105 s. Sources synthétiques, pas de marché réel.

| Mesure | A | B original |
| --- | ---: | ---: |
| Durée totale | 427,932 s | 281,046 s |
| Appels | 4 | 4 |
| Durée candidates | 105,018 s | 94,537 s |
| Diagnostic candidates | TIMEOUT_OR_PARENT_ABORT | SCHEMA_INVALID |
| JSON candidates lisible | non | oui |
| Tokens candidates observés | inconnus | 23 |
| Contrats d'opportunité acceptés | 0 | 0 |
| Statut final | BLOCKED | BLOCKED |

B a aussi subi un timeout de `query_proposal`, puis deux requêtes valides. La différence de durée totale sur cette unique exécution, en ordre A puis B sans échauffement séparé, ne démontre ni accélération reproductible ni amélioration économique. Les 23 tokens de sortie constituent un indice de réponse courte, pas une preuve d'un champ donné, d'une troncature ou d'un défaut de provenance.

## Localisation exacte du rejet et causes possibles

Dans `diagnostics.ts`, `SCHEMA_INVALID` avec `json_valid:true` signifie que `JSON.parse` a réussi et que `parseResearchCandidates(raw, 10)` a levé une exception autre que le message de placeholder reconnu. Le transport avait fourni un contenu ; ce diagnostic ne correspond ni à un timeout B sur candidates ni à une erreur de syntaxe JSON. Aucun marqueur de troncature n'a été relevé pour cet appel ; une troncature n'est pas établie.

| Niveau | Rejet possible dans ce diagnostic historique |
| --- | --- |
| Racine | Valeur non objet, tableau racine, champ `candidates` absent, autre clé, clé supplémentaire, JSON doublement encodé en chaîne |
| Collection | `candidates` n'est pas un tableau, ou contient plus de 3 éléments |
| Élément | Un candidat n'est pas un objet avec exactement `name`, `kind`, `source_index` |
| `kind` | Valeur différente de `QUICK_SERVICE` ou `DURABLE_ASSET`, notamment traduction, minuscules ou les deux valeurs concaténées |
| `name` | Type différent d'une chaîne, vide, plus de 80 unités de chaîne JavaScript, caractère de contrôle/format, texte refusé par `researchText` : URL, balise, vocabulaire sensible/commande ou longue séquence assimilable à un secret |
| `source_index` | Chaîne, identifiant `research-source-N`, null, flottant, entier non sûr, zéro négatif, valeur hors de 0..9 |

Un index **entier valide dans 0..9 mais différent de la source fournie** ne suffit pas à expliquer ce `SCHEMA_INVALID` : il passerait ce parseur et serait rejeté ensuite par l'adaptateur avec `SOURCE_INDEX`. De même, 2 ou 3 candidats passeraient la forme du parseur mais violeraient ensuite la limite d'un candidat par extraction. Le tableau vide est valide et constitue une abstention. Le placeholder exact reconnu aurait normalement été étiqueté `PLACEHOLDER`, sauf si un autre champ invalide avait déclenché une exception avant lui.

La source initiale de B est l'index global 1 (`research-source-2`) : les sources sont présentées de la plus récente à la plus ancienne. Une extraction isolée ne doit pas la renuméroter en 0. `source_index` est un entier global ; `source_id` est un identifiant distinct et n'est pas un champ de candidat. Dans B, les propositions de requêtes ne reçoivent aucune page : `evidence_index` doit rester `null`. Les citations continuent à devoir être des sous-chaînes littérales du bloc transmis et de la page lue ; aucune règle n'est assouplie.

## Correctif expérimental

`field_issues` contient uniquement des couples de constantes `field/category`. Champs possibles : `root`, `candidates`, `candidate`, `name`, `kind`, `source_index`, `evidence_index`. Catégories : type, champ manquant, clés supplémentaires, nombre d'éléments, nom vide/trop long, caractères de contrôle, texte public refusé, placeholder, enum, entier, plage, zéro négatif, source non fournie et cardinalité d'extraction. Plusieurs catégories peuvent être relevées simultanément, dédupliquées ; l'inspection est bornée aux quatre premiers éléments d'une collection invalide. Les décisions restent celles des validateurs existants, y compris lorsque cette collecte bornée ne décrit pas chaque élément.

Les noms de clés arbitraires, valeurs invalides, prompts, textes de sources, réponses brutes et messages d'exception ne sont jamais ajoutés aux diagnostics. Les compteurs de tokens et les durées restent numériques. Le contexte des index provient de la structure d'entrée construite par l'hôte, pas des affirmations du modèle. Le même diagnostic fonctionne avec un répondeur simulé et avec les enveloppes Ollama ; les tests d'enveloppe utilisent un transport simulé et ne sont pas présentés comme Qwen réel.

`contract_shape_valid` décrit uniquement le parseur. `PROVENANCE_INVALID` et `EXTRACTION_CONTRACT_INVALID` distinguent les refus suivants de la simple forme JSON ; ces libellés n'accordent aucune autorisation et ne remplacent pas les contrôles de l'adaptateur.

La consigne `explicit` montre un objet complet, impose un candidat au maximum, un nom concret de 1 à 80 caractères, une valeur enum unique et l'index entier réellement fourni. Elle interdit les clés supplémentaires et rappelle de remplacer l'exemple. `original` reproduit la consigne précédente octet pour octet. Le système compact et les autres phases ne changent pas. La variante A garde les requêtes de production.

Le banc `candidate-probe.ts` compare ces deux consignes sur une seule source synthétique avec un appel par bras ; trois répétitions alternent l'ordre et produisent six appels au maximum. Une extraction acceptée n'est pas une validation économique ; le nombre de candidats est enregistré séparément, sans leur contenu. Le banc complet permet aussi `--variant=B` et `--candidate-prompt=original|explicit`. Le mode réel demandé est distingué d'une réponse effective observée dans le banc complet.

## Mesures et limites

Les deux formulations ont été rejouées sur les six scénarios synthétiques, trois répétitions, A/B : **36 parcours par formulation**, mêmes résultats de contrat, citations, appels et verrous économiques. C'est un contrôle de non-régression avec réponses programmées, pas une mesure de Qwen.

Sur le cas court B simulé : 12 appels et 2 contrats acceptés avec chaque consigne ; les caractères d'entrée cumulés passent de 9 564 à 10 080 (+516, environ 5,4 %). La formulation explicite ne revendique donc aucun gain de taille ou de vitesse. Les 2 contrats portent sur des données synthétiques ; ils ne prouvent aucune opportunité réelle. La preuve de demande reste inconnue, le test de prix de concurrent continue à être refusé et aucune exécution n'est autorisée.

Le contrôle de contexte a détecté un dépassement pendant le développement avec un extrait de 250 caractères accentués. La consigne a été raccourcie, sans relever les plafonds. La version finale teste ce cas dans le garde inchangé ; des textes encore plus coûteux en octets peuvent toujours être refusés. Aucun tokenizer ou paquet externe n'a été ajouté.

**Aucun essai Qwen réel de cette itération n'a été exécuté ici.** Ollama n'est pas installé/exposé sur le point local vérifié. Le seul résultat matériel Qwen analysé est celui fourni par l'utilisateur. Le test ciblé Chromebook et le parcours complet restent nécessaires avant d'évaluer la fiabilité, la latence ou l'utilité économique.

Les résultats logiciels finaux, versions de runtime et contrôles d'intégrité sont consignés dans `VALIDATION_ITERATION_2.md` et les fichiers `verification` de la livraison. La première version de la consigne et des tests a été corrigée avant les vérifications finales ; aucun échec initial n'est compté comme succès final.

## Portée et décision

Base V14.6 : `34fdac2cbdf8d582c5e3563538d3adbd246d2d0c`. Parent expérimental exact : `1998a24e2bbd12d46d5f8f8ef6bd0a3ad9db3287`. Modifications exclusivement sur `local-ollama-only`, dans le laboratoire et ses tests. Aucun fichier de production, verrou de dépendances ou contrôle économique n'est modifié. Aucun paiement, compte, publication, transfert ou worker n'est déclenché. Aucun push n'est effectué.

Les plafonds restent 20 appels/20 minutes par bras, 2 400 caractères par entrée B, 24 000 au total, 250 par extrait, 3 sources et 16 Kio d'enveloppe/réponse. Les paramètres matériels 2 048/256/105 s sont reproduits dans les instructions et ne changent pas les valeurs de production. Il n'y a ni correction automatique des réponses, ni coercition des types, ni nouvelle tentative après extraction invalide.

**Décision : ITÉRATION pour le projet.** La validation technique permet le test ciblé isolé si les vérifications finales passent. L'amélioration Qwen et l'amélioration économique restent non démontrées. Aucune intégration à la production ni validation de pilote financier n'est autorisée par cette livraison.
