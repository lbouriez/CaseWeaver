---
sidebar_position: 11
title: Vue d'ensemble des opérations
---

# Vue d'ensemble des opérations

Utilisez [Auto-hébergement](./self-hosting.md) pour l'installation,
[Persistance et récupération](./persistence-recovery.md) pour la sécurité des données,
et [Dépannage](./troubleshooting.md) pour un premier contrôle borné.

Un opérateur peut consulter jobs, dead letters, coûts, rétention, confidentialité,
diagnostics et audit append-only seulement selon les permissions de son espace. Les
lectures/téléchargements sensibles échouent fermés si l'audit requis ne peut pas être
persisté.

La production utilise une base privée, une seule edge TLS publique, les assets Admin,
des rôles base migration/runtime distincts, une migration explicite et un seul mode
runtime. `compose.test.yml`, `compose.admin.yml` et une image locale ne sont pas une
installation de production.
