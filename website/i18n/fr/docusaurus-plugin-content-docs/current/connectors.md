---
sidebar_position: 4
title: Matrice des connecteurs
---

# Matrice des capacités connecteur

**Disponibilité :** le registre est dynamique : un connecteur apparaît seulement si le
backend enregistre son descripteur et les champs/exemples sont fournis par le serveur.

| Connecteur | Source connaissance | Source cas | Pièces jointes | Destination analyse | Secret | Guide |
| --- | --- | --- | --- | --- | --- | --- |
| Git / Markdown | Oui | Non | Oui | Non | Jeton Git distant privé optionnel | [Guide](./git-markdown.md) |
| Jitbit | Oui | Oui | Oui | Oui, note interne approuvée seulement | API token obligatoire | [Guide](./jitbit.md) |

## Chaîne de configuration

1. Enregistrez une référence de secret si nécessaire.
2. Créez un brouillon connecteur et lancez son test non destructif borné.
3. Relisez et activez la version immuable.
4. Créez une **collection**, puis une **source de connaissance** et éventuellement une
   **planification**. Les filtres sont une politique de version de source.
5. Pour les cas, créez séparément intake, recette/profil et publication/destination
   seulement là où l'API annonce les flux gérés.

Un test réussi ne synchronise pas de contenu et n'autorise aucune publication. Une source
ne rend pas une destination utilisable. Une surface indisponible exige un déploiement
compatible et un rôle autorisé, jamais une requête navigateur inventée.
