---
sidebar_position: 2
title: Architecture
---

# Orientation architecturale

CaseWeaver conserve les préoccupations de livraison à la périphérie et les règles métier
vers le centre. Les applications reçoivent les requêtes et composent les dépendances ;
les couches de fonctionnalités et d'application coordonnent les cas d'usage ; le domaine
reste indépendant de HTTP, des bases de données, des connecteurs et des fournisseurs d'IA.

```text
Navigateur, API, ordonnanceur, applications webhook
                |
 cas d'usage d'application et de fonctionnalités
                |
              domaine
```

Le travail de longue durée est conçu pour passer par des limites durables de file et de
worker plutôt que de s'exécuter directement dans une requête d'ordonnanceur ou de webhook.
Les systèmes externes sont intégrés au moyen de connecteurs nommés, de fournisseurs ou
d'adaptateurs d'infrastructure. Les appels d'IA passent par la limite d'exécution
mesurée plutôt que par un raccourci de fournisseur propre à une fonctionnalité.

Il s'agit de principes d'architecture, et non d'un guide d'exploitation. Consultez la
page de statut des capacités avant de vous appuyer sur un déploiement, un connecteur ou
un flux de travail administratif particulier.
