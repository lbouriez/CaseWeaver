---
sidebar_position: 14
title: Dépannage et terminologie
---

# Dépannage

Commencez par une observation sûre et bornée. Ne contournez pas OIDC, ne désactivez pas
l'autorisation, ne mettez pas de secret dans diagnostics, ne supprimez pas un volume prod
et n'exécutez pas de SQL destructif pour faire disparaître un symptôme.

| Symptôme | Premier contrôle sûr | Récupération sûre |
| --- | --- | --- |
| Console ne se connecte pas | `ADMIN_ALLOWED_ORIGINS`, méthode connexion, edge health. | Corrigez le déploiement ; cookies/tokens ne sont pas un contournement. |
| Callback OIDC échoue | Origine HTTPS, client, callback, certificat, CIDR proxy. | Corrigez contrat identité/déploiement. |
| Test connecteur échoue | Descripteur, cycle référence, endpoint HTTPS, reachability runtime. | Corrigez puis relancez le test borné. |
| Git local rejeté | Chemins canoniques, racine, permissions, overlay lecture seule. | Corrigez l'overlay revu, pas les racines. |
| Modèle fournisseur absent | Activez fournisseur puis rafraîchissez inventaire. | Ne liez pas un modèle global ni ID manuel. |
| Test IA bloqué | Rôle binding, composants prix, budget, preview serveur. | Complétez config sûre ; prix inconnu n'est pas zéro. |
| Publication incertaine | Receipt/statut et marqueur destination. | Réconciliez `outcome_unknown` avant écriture. |
| Readiness production échoue | PostgreSQL privé, migration, grants rôle, upstreams. | Conservez logs expurgés ; pas de DDL runtime. |
| Backup/restore échoue | Runtime arrêté, dump/manifeste conservés. | Validez bucket/préfixe/S3/PostgreSQL ; helper ne supprime pas cible. |

## Termes

**Version immuable** : snapshot de configuration choisi par un run. **Concurrence
optimiste** : empêche d'écraser une modification récente. **Outbox** : enregistrement qui
valide état et travail en file ensemble. **Bail** : propriété temporaire d'un job durable.
**Outcome unknown** : une écriture externe a peut-être eu lieu et doit être réconciliée.

Chaque action opérateur a acteur, espace, permission, cible, résultat et audit détenus
par serveur. L'audit omet secrets, prompts, URL avec identifiants, réponses fournisseur et
locators stockage.
