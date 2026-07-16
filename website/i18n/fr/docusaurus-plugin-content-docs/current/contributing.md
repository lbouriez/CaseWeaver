---
sidebar_position: 5
title: Contribuer à la documentation
---

# Contribuer à la documentation

Le portail est un projet Docusaurus TypeScript indépendant. Travaillez depuis la racine
du dépôt et utilisez ses propres commandes de package :

```powershell
pnpm --dir website install
pnpm --dir website typecheck
pnpm --dir website test
pnpm --dir website build
```

Gardez les pages concises et orientées tâche. Avant d'ajouter une affirmation destinée
aux opérateurs, vérifiez-la par rapport à l'implémentation actuelle, à la validation de
configuration et au contrat de livraison accepté. Marquez le comportement incomplet comme
indisponible plutôt que d'écrire un parcours de clics spéculatif.

Les traductions sont un travail de rédaction volontaire. La structure de langue existe ;
une révision humaine est requise avant la publication d'une page traduite. Après la
modification d'une page anglaise, exécutez
`pnpm --dir website translations:status`. Mettez à jour la page locale, faites-la relire,
puis exécutez `pnpm --dir website translations:manifest` pour enregistrer la révision
anglaise exacte qui a été approuvée. Ces commandes n'appellent jamais un fournisseur d'IA
et ne lisent aucune clé d'API.
