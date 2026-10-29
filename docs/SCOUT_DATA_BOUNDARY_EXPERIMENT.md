# Scout — barrière expérimentale import / export

29 octobre 2026. Base exacte : Android V2
`a70340fa090b239d18800a3221005d9b72e037ef`.
Branche isolée : `scout-data-boundary-experiment-20261029`.
Les six documents du kit d’audit du même jour sont la référence de cette étape.
Aucun assemblage hybride/économique, aucune modification du contrôleur de
recherche, des règles économiques, du fournisseur Qwen ou des branches livrées.

## Frontière de projection

`assertResearchProjectionBoundary` est appelé avant toute projection d’un résultat
complet dans l’import fichier et la revue/export V2. Le projecteur partagé
`toMobileResearchPreview` applique aussi cette barrière avant son retour anticipé
non-PASS, pour ne pas transformer une analyse marquée en aperçu vide.

Toute présence propre de `economic_guard` ou `experimental_model_provider` est
refusée avec `EXPERIMENTAL_RESEARCH_PROJECTION_REFUSED`, même si la valeur est
`false`, `null`, une chaîne, un objet malformé ou une analyse documentaire sans
opportunités. L’approbation d’un ancien export ne contourne pas cette vérification.
Le garde économique et le simulateur OpenAI ne sont ni importés ni exécutés.

Les clés non représentées par les contrats historiques sont refusées à la racine,
sur une opportunité, sur une source/citation ou dans un mini-test. Une nouvelle
provenance, un avertissement structuré ou une catégorie de coûts ne peut donc pas
être supprimé implicitement. Leur affichage futur nécessitera un contrat versionné,
pas l’assouplissement du protocole V2.

Les champs historiques explicitement connus restent autorisés. Les champs hôte
`private_state`, requêtes, métriques, outils et attention ne sont pas exportés ni
utilisés comme autorité de validation. Leur présence ne prouve rien et ils ne sont
pas transmis à Android. Cette barrière n’est pas un parseur intégral de toutes les
structures internes du moteur : elle contrôle la frontière d’affichage. Les
validations existantes des données consommées, citations, montants, sécurité et
autorisation restent appliquées par les points d’entrée. Les six indicateurs
de sécurité doivent être présents et exactement false dans un résultat complet.

## JSON ambigu et données inconnues

`parseResearchBoundaryJson` conserve la grammaire de JSON.parse et refuse ensuite
les clés dupliquées dans chaque objet, y compris les clés Unicode échappées et les
objets imbriqués. Les clés identiques dans deux objets différents restent légales.
Ce contrôle intervient sur le texte d’origine avant la sérialisation des aperçus
imbriqués dans les imports courts, fichiers complets et enveloppes V1/V2.

Les limites de taille existantes restent aux entrées. Aucun champ manquant n’est
complété par une valeur de confiance. Un coût explicite `null` associé à UNKNOWN
reste inconnu ; zéro est une valeur numérique distincte, soumise aux contrôles
de base du coût/citation. Un coût ou sa base absents sont refusés. Aucun montant
de bénéfice n’est créé, et un coût zéro ne démontre aucune rentabilité.

## Provenance et avertissements

Les enveloppes V1/V2 conservent leur forme et tous leurs champs : V1 reste
FICTIONAL_DEMO/UNAUTHENTICATED ; V2 conserve data_origin FICTIONAL_TEST ou
PUBLIC_RESEARCH, son moteur, révision, horodatage et UNAUTHENTICATED. La provenance
V2 est déclarative, pas authentifiée et pas une attestation de modèle réel.
Un champ obligatoire manquant n’est pas reconstitué depuis le nom d’un modèle,
une URL ou la forme d’un résultat.

Les anciens aperçus courts et fichiers de recherche ne renseignent pas le
fournisseur ni la provenance réelle. L’écran indique cette absence ; il n’invente
ni Qwen, ni OpenAI, ni « résultat réel ». Les avertissements de citation non
authentifiée et d’absence d’autorisation sont conservés. Les cartes affichent
en plus l’avertissement commun : aperçu partiel, coûts/revenus non validés,
frais et risques à examiner, coût nul distinct d’un bénéfice, rentabilité non
établie. Les avertissements structurés nouveaux non représentables sont protégés
par un refus, pas transformés en une liste vide.

Le format historique reste un aperçu partiel, pas une restitution de tous les
textes `summary`, `fees` et `risks` du moteur. Ceux-ci restent dans le résultat
hôte original. L’avertissement générique ne prétend pas reproduire ces détails
ou les analyses renforcées. Aucun nouveau champ n’est ajouté aux cartes ou à V2.
Un marqueur supprimé avant réception par un tiers ne peut pas être reconstruit ;
les données non marquées restent non authentifiées, jamais certifiées réelles.

## Refus et conservation

Les deux actions de l’écran utilisent `reviewResearchImport`. La validation
réussie seule remplace l’aperçu. Un refus conserve le même objet précédent et
affiche un message statique, sans diagnostic ou contenu privé. L’ouverture puis
l’annulation du sélecteur n’efface plus l’aperçu ; le texte en cours de saisie
n’est plus effacé par une tentative de fichier. Le texte ne peut pas remplacer
l’aperçu pendant qu’une sélection de fichier est en cours.

Les imports fichier/texte demeurent temporaires ; ils n’écrivent pas dans le
cache sync. Le récepteur et son magasin revalident avant écriture. Les tests
supplémentaires vérifient le refus avant sauvegarde, la conservation des octets
du singleton V1/V2 et des données manuelles après fermeture/réouverture.

Même `scout-reception.db`, table `latest_research`, ligne `id=1`, mêmes codecs
V1/V2 et pas de migration SQLite. Le stockage manuel reste séparé. La session
continue d’utiliser une démo V2 en mémoire ; le transport réel reste désactivé
par défaut et n’est pas implémenté. Les contrôles de moteur/révision/fraîcheur
et la consultation hors connexion restent inchangés.

## Validation et limites

Les nouveaux tests `scout-data-boundary*.test.ts` couvrent refus de marqueurs,
clés inconnues, coûts null/zéro, champs absents, JSON dupliqué, provenance
déclarée, ancien import et conservation SQLite sur fichier. La campagne de
régression, les compilations, le lint et l’export Hermes figurent avec leurs
résultats exacts dans le kit de livraison.

Les fixtures de simulation sont des objets de données : aucun fournisseur
hybride, garde économique activé, vrai Qwen/OpenAI ou recherche réelle n’est
exécuté. Le graphe mobile de la barrière reste sans API Node ni réseau.
L’export Hermes n’est pas un APK ; rendu tactile, sélection native, annulation
réelle, SQLite Expo et démarrage autonome hors connexion restent à confirmer
sur matériel. Le refus des résultats non-PASS contenant encore des hypothèses
est une incompatibilité historique conservée, pas corrigée en fabriquant PASS.

Pour revenir au comportement précédent, ouvrir une autre copie à `a70340f`.
Les données V1/V2 restent lisibles par Android V2. Aucun retour au code V1 sur
la même base après une écriture V2, aucun reset/clean ou effacement Expo.
