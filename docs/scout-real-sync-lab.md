# SCOUT — Liaison Chromebook / Android

Statut : EXPERIMENTAL
Production : NON MODIFIEE

## Objectif

Transmettre des resultats Scout controles vers Android.

## Protocole

- HTTPS uniquement.
- TLS 1.3 pour la future liaison reelle.
- Reseau local uniquement.
- Service desactive par defaut.
- Activation manuelle explicite.
- Route : GET /v2/research-result
- Aucune route de commande commerciale.
- Aucune execution declenchee depuis Android.
- Taille maximale : 128 Kio.
- Reponses JSON strictement validees.
- Cache-Control: no-store.

## Authentification

- Identifiant distinct pour chaque appareil.
- Secret aleatoire de forte entropie.
- Verification cote serveur.
- Possibilite de revocation.
- Aucune information sensible dans les journaux.
- Aucun secret dans Git.
- Verification du certificat TLS sur Android.
- Interdiction de contourner la validation TLS.

## Donnees

- FICTIONAL_TEST uniquement dans la premiere phase.
- Enveloppe Scout V2 validee.
- Export controle et explicitement approuve.
- Aucun champ autorisant une execution.
- Refus des projections qui perdent des informations.
- Aucune rentabilite supposee ou inventee.
- La provenance des donnees reste distincte
  de l'authentification du transport.

## Tests obligatoires

- Serveur desactive par defaut.
- Refus sans authentification.
- Refus des identifiants incorrects.
- Refus des appareils revoques.
- Refus des methodes autres que GET.
- Refus des routes inconnues.
- Refus des donnees invalides.
- Refus des certificats non fiables.
- Limitation stricte des donnees.
- Conservation des avertissements.
- Consultation hors ligne apres reception.
- Aucune recherche commerciale.
- Aucune depense.
- Aucune modification de Scout stable.

## Deploiement

1. Tests sans ouverture de port.
2. Tests HTTPS sur boucle locale.
3. Verification de la securite Android.
4. Test reel sur Xiaomi apres validation.
5. Aucun acces Internet public.
