---
sidebar_position: 16
title: Contribuer
---

# Contribuer à CaseWeaver

Lisez `AGENTS.md`, le guide `.features` pertinent, le README du dossier et le livrable
avant de modifier. Les dépendances pointent vers l'intérieur : applications/adaptateurs
dépendent des fonctionnalités, qui dépendent du domaine. Le domaine ne dépend jamais de
HTTP, PostgreSQL, d'un connecteur ou fournisseur IA.

## Site documentaire

```powershell
pnpm --dir website install
pnpm --dir website typecheck
pnpm --dir website test
pnpm --dir website build
```

L'anglais est canonique. Le français est de la documentation rédigée, jamais une
traduction navigateur. Après une modification anglaise, exécutez
`pnpm --dir website translations:plan -- --dry-run`. Après validation humaine des pages
françaises, exécutez `pnpm --dir website translations:manifest`. Le manifeste enregistre
uniquement le hash anglais ; il ne traduit rien et n'appelle aucun fournisseur IA.

## Changements produit

Préférez les tests unitaires ciblés pour les invariants, les contrats pour les familles
d'adaptateurs, PostgreSQL réel pour la persistance et un petit ensemble E2E critique.
Les tests IA live sont opt-in et plafonnés ; ils passent par
`@caseweaver/ai-execution`. N'ajoutez jamais secret, URL avec identifiants, chaîne de
connexion production ou contournement navigateur à la documentation.
