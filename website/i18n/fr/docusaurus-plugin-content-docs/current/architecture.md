---
sidebar_position: 14
title: Architecture
---

# Architecture et flux de travail

CaseWeaver garde le comportement fournisseur à la périphérie. Les connecteurs traduisent
les systèmes externes, les fournisseurs d'IA passent par l'exécution mesurée, et le
domaine ne branche pas sur un fournisseur ou modèle.

```text
Admin / API / webhook / ordonnanceur
                |
 cas d'usage d'application et fonctionnalités
                |
              domaine
                |
PostgreSQL + pgvector / file / stockage / adaptateurs
```

## Travail durable

1. Une synchronisation, un webhook vérifié, une planification ou une commande manuelle
   est validé à l'entrée.
2. La commande et son outbox sont validés avec l'état dans PostgreSQL.
3. Un relais livre l'enveloppe à la file PostgreSQL durable.
4. Un worker détient un bail, résout la version immuable exacte et exécute le travail
   borné de connecteur, stockage, recherche ou IA.
5. Résultats, preuves, coût, audit et publication sont conservés. La reprise utilise
   l'enregistrement durable, pas un appel navigateur rejoué.

Le mode **standalone** héberge API, webhook, ordonnanceur, worker et relais dans un
processus. Le mode **distributed** les sépare. Les deux utilisent la même file, les mêmes
baux, handlers, données PostgreSQL et versions immuables : standalone n'est pas un
raccourci en mémoire.

## Preuves, stockage et IA

PostgreSQL conserve configuration, audit, travail, recherche plein texte et pgvector.
Le stockage objet contient les pièces jointes et dérivés bornés. Une analyse conserve la
source/version/preuve sélectionnée ; une modification ultérieure ne peut pas rebinder
silencieusement un travail déjà en file.

Chaque appel modèle traverse `@caseweaver/ai-execution`, qui enregistre usage/coût,
applique binding et budget immuables, et échoue sûrement si le prix est inconnu plutôt
que de le considérer nul.

Consultez [Tests](./testing.md) pour les contrôles de ces limites et
[Contribuer](./contributing.md) avant d'ajouter un adaptateur.
