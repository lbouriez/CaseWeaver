---
sidebar_position: 12
title: Persistance, sauvegarde et récupération
---

# Persistance, sauvegarde, mise à niveau et récupération

PostgreSQL/pgvector est le système d'enregistrement : historique configuration, audit,
file/outbox durables, baux, état sources/analyses, recherche et coûts. Le stockage objet
contient pièces jointes/dérivés. Le volume PostgreSQL production survit aux arrêts et
changements de mode normaux ; les volumes local/test jetables n'ont pas cette promesse.

## Sauvegarde et restauration

Avant mise à niveau ou transition topologie, sauvegardez. Le helper arrête le runtime,
copie le préfixe objet vers le bucket backup, écrit un dump PostgreSQL custom et un
manifeste sans secret. Il laisse le runtime arrêté pour inspection.

```powershell
node deploy\docker\production-operations.mjs backup --env-file <operator-env-file> --mode standalone --output <backup-dump-path>
node deploy\docker\production-operations.mjs restore --env-file <operator-env-file> --mode standalone --input <backup-dump-path>
```

La restauration exige une configuration compatible et un préfixe cible propre ou vidé
volontairement. Le helper valide buckets/préfixes, ne supprime aucun objet cible,
restaure PostgreSQL et réapplique migration/grants. Utilisez `start` séparément après succès.
En cas d'échec, conservez dump, manifeste et diagnostics expurgés ; pas de SQL destructif.

## Upgrade et rollback

Vérifiez digest/attestations, sauvegardez, arrêtez/drain l'ancien runtime, exécutez
`migrate` puis démarrez. Les migrations sont forward-only. Le rollback image n'est sûr
que si schéma compatible ; sinon restaurez la sauvegarde testée. Aucun downgrade
destructif automatique n'existe. Mesurez RPO/RTO, protégez/versionnez le bucket backup et
n'utilisez jamais `docker compose down -v` sur des données production.
