---
sidebar_position: 10
title: Auto-hébergement
---

# Auto-héberger une installation production

**Disponibilité :** pris en charge avec les images linux/amd64 à digest de la release.
N'exposez jamais une image Compose locale ou le mot de passe de développement.

## Préparer et valider

Créez un dossier opérateur hors checkout. Copiez `deploy/docker/.env.production.example`,
remplissez la configuration publique et stockez chaque secret dans son fichier restreint.
Le fichier environnement ne contient ni mot de passe, jeton, clé privée ni URL base avec
identifiants. Les valeurs connecteur/fournisseur sont des fichiers safe-named dans
`CASEWEAVER_APPLICATION_SECRETS_DIRECTORY`, montés seulement dans les processus serveur.

Utilisez chaque identité `image@sha256:...` du release record. Vérifiez provenance et
attestation SPDX, puis utilisez le helper :

```powershell
node deploy\docker\production-operations.mjs validate --env-file <operator-env-file>
node deploy\docker\production-operations.mjs migrate --env-file <operator-env-file> --mode standalone
node deploy\docker\production-operations.mjs start --env-file <operator-env-file> --mode standalone
```

La migration est explicite et forward-only : Prisma et file précèdent le runtime, puis le
rôle runtime séparé. N'accordez jamais DDL aux identifiants API/worker pour rendre
readiness verte.

## Edge, authentification et modes

Seule l'edge Nginx TLS publie des ports. Elle sert Admin same-origin et proxy
API/health/webhook. Définissez une origine HTTPS exacte dans `ADMIN_ALLOWED_ORIGINS`,
gardez certificat/clé dans fichiers secrets et restreignez `TRUSTED_PROXY_CIDRS` au
sous-réseau edge interne. OIDC est le choix production normal ; le mot de passe est une
option break-glass explicite, via fichiers non par défaut et accès restreint.

Choisissez un seul mode. `standalone` partage un processus backend pour
API/webhook/ordonnanceur/worker/relais. Le processeur de pièces jointes reste un sidecar
Unix-socket séparé, sans réseau, dans les deux modes. `distributed` sépare les modules
backend mais garde file/données PostgreSQL et ce sidecar. Pour changer de mode :
sauvegarde, arrêt, migration, upstreams edge, démarrage. Ce n'est pas sans interruption.
Vérifiez les deux endpoints HTTPS health et utilisez logs expurgés ou export diagnostic sûr.

La configuration OIDC est décrite dans [Accès et secrets](./access-and-secrets.md).
Le contrôle se fait via `https://<public-origin>/health/live` et `/health/ready`.
