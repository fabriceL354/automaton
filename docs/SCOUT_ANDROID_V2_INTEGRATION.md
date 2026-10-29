# Scout Android V2 — intégration expérimentale du 29 octobre 2026

Base Android conservée : `8e462e439ef4e7b5b48c189b2c7a8a361a2d28a4`.
Le prototype V2 récupéré est conservé séparément dans le commit
`737dbce613f02e293434da0a13b99d165dec6ef8` : aucune réécriture des quatre commits Android.

## Parcours intégré

`ScoutSyncSection` utilise `createScoutSyncSession`, le récepteur V2 existant et
un fournisseur de démonstration explicitement injecté, uniquement en mémoire.
Le bouton « Recevoir une démonstration V2 » génère une enveloppe fictive et
affiche sa version, sa révision, son horodatage déclaré et les cartes existantes.
Il ne lance pas le moteur Scout et ne récupère aucune donnée distante.

Le transport d'une session sans injection est désactivé. Le fournisseur de
démonstration ne contient ni URL de connexion, ni appel HTTP, ni jeton, ni
authentification réelle. La validation de fraîcheur, du moteur, des révisions
et des conflits reste dans le récepteur V2 ; aucun contournement n'est ajouté.

## SQLite et compatibilité

- Même fichier natif `scout-reception.db`, même table `latest_research`, même
  ligne `id=1`. Aucun second cache V2 et aucune copie des opportunités manuelles.
- Une ligne V1 est revalidée avec son parseur d'origine et affichée sans
  réécriture. Elle est remplacée seulement après réception et sauvegarde V2
  réussies. Il s'agit d'une évolution du codec ; aucun ALTER/DROP ni changement
  de schéma n'est nécessaire.
- Le dispatch par version est strict. Une enveloppe V2 invalide n'est jamais
  réinterprétée comme V1. Les lignes relues depuis le disque sont revalidées.
- Une réouverture hors connexion ne rejette pas le résultat pour son seul âge.
  L'âge n'autorise aucune nouvelle réception ni exécution.
- Une erreur de transport, de validation ou d'écriture conserve le dernier
  résultat valide. Un cache corrompu reste refusé, sans effacement automatique.
- Un ancien binaire V1 ne sait pas afficher une ligne V2. Un retour au code V1
  n'effectue aucune conversion destructive ; conserver la base, puis revenir
  au code V2 pour la relire. Ne jamais effacer les données Expo Go pour dépanner.

Les références V1 et leurs tests restent disponibles. Le nouveau parcours UI
écrit V2 seulement, pour éviter qu'une démonstration V1 ne remplace une révision V2.

## Validation et limites

Les nouveaux tests `scout-mobile-v2-integration.test.ts` exercent le même service
que l'écran avec SQLite réel (`better-sqlite3`) : lecture V1, migration à V2,
fermeture/réouverture, singleton, erreurs d'écriture, corruption, mauvaises
versions, doubles réceptions, moteur différent et révisions refusées.
Ils ne simulent pas un téléphone ou le pont natif Expo SQLite.

Les résultats exacts, commandes et logs figurent dans le kit de reprise.
Le bundling Hermes est distinct d'un APK. Les essais tactiles, le sélecteur de
fichier, SQLite Expo natif et les fermetures/réouvertures sur appareil restent
à réaliser. Expo Go peut dépendre de Metro pour recharger le code : un démarrage
autonome à froid hors connexion devra être confirmé avec un APK embarquant le JS.

Les sources et citations restent déclarées, non authentifiées ; aucune
autorisation commerciale, dépense ou exécution n'est accordée. Le contrôle
atomique entre plusieurs instances, les transports réels, l'appairage, les
secrets et leur annulation liée au cycle de vie restent hors périmètre.
Les prototypes économiques et OpenAI n'ont pas été intégrés ou modifiés.
