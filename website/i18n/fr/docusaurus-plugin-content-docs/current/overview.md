---
sidebar_position: 1
title: Présentation
---

# Documentation CaseWeaver

CaseWeaver est conçu comme un système durable d'opérations sur les dossiers, attentif
aux preuves. Sa documentation doit distinguer une capacité livrée, un travail disponible
uniquement pour une évaluation de développement et un travail planifié.

Cette première version du portail fournit le vocabulaire commun, une orientation
architecturale et la limite de statut des capacités. Elle ne remplace pas encore les
guides opérateurs vérifiés qui dépendent des contrats de runtime, d'administration et
d'auto-hébergement acceptés.

## À lire en premier

1. Consultez [l'architecture](./architecture.md) pour les principes durables de
   traitement et de sécurité.
2. Vérifiez le [statut des capacités](./capability-status.md) avant de considérer qu'un
   chemin de configuration est pris en charge.
3. Lisez le [statut des opérations](./operations.md) avant de planifier un déploiement
   auto-hébergé.

## Principes de documentation

- Les clients navigateurs ne reçoivent jamais de secrets opérationnels, de jetons de
  fournisseur ou d'identifiants de base de données.
- Les données de dossiers, les preuves, les versions de configuration et le travail
  durable conservent des limites explicites de propriété et d'audit.
- Les instructions publiques indiquent les prérequis, les résultats sûrs attendus et le
  moment où une capacité n'est pas encore prise en charge.
