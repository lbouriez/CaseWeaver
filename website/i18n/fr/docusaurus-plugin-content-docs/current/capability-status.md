---
sidebar_position: 15
title: Statut des capacités
---

# Ce qui est pris en charge aujourd'hui

Cette page distingue les instructions livrées du travail prévu. Le control plane en
exécution reste l'autorité : il annonce si une surface est gérée, en lecture seule ou
indisponible pour l'espace de travail et le rôle connectés.

| Capacité | Statut | Parcours opérateur |
| --- | --- | --- |
| Portail documentaire statique | Disponible | Ce site ; aucune dépendance API ou secret. |
| Stack d'évaluation locale | Disponible | `compose.local.yml`, loopback et jetable. |
| Auto-hébergement production | Disponible | Images à digest et helper d'opérations. |
| Sessions mot de passe/OIDC | Disponible | Configuration de déploiement ; cookies API. |
| Source Git/Markdown | Disponible | Brouillon, test borné, source, planification, synchronisation. |
| Jitbit connaissance/cas/destination | Disponible là où le serveur annonce la surface | [Guide Jitbit](./jitbit.md). |
| Inventaire IA, bindings, prix, budgets | Disponible | Rafraîchissement serveur et test protégé. |
| Analyse avec dépôt | Disponible là où les flux gérés sont annoncés | Zones Console dédiées. |
| MCP et chat avec preuves | Reporté | Aucun parcours de configuration publié. |

## Limites importantes

La console ne fabrique pas de CRUD si le contrat API manque. Source, collection,
planification, profil d'analyse, profil de publication et destination sont des
enregistrements différents. Certaines données opérationnelles restent volontairement en
lecture seule. Une surface indisponible exige une release compatible et un rôle autorisé,
pas une requête navigateur modifiée.
