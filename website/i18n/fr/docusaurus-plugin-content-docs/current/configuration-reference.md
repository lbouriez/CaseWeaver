---
sidebar_position: 9
title: Référence de configuration
---

# Référence de configuration

Toutes les valeurs sont des entrées déploiement, non des champs Admin. Les secrets
production viennent du chemin `*_FILE` correspondant ; ne copiez jamais leur contenu
dans fichier environnement, URL, navigateur ou guide.

| Clé/groupe | Consommateur, règle et forme valide | Classification et fourniture |
| --- | --- | --- |
| `NODE_ENV`, `HOST`, `PORT`, `DATABASE_READINESS_TIMEOUT_MS` | Runtime API. `HOST` vaut par défaut `0.0.0.0`; port et délai sont requis. Compose prod fixe le port interne. | Configuration runtime/déploiement publique. |
| `DATABASE_URL` | Connexion PostgreSQL API, CLI et runtime, obligatoire. En production elle vient uniquement du fichier correspondant. | Secret ; fichiers runtime/migration dédiés. |
| `API_WORKSPACE_ID`, `API_PRINCIPAL_ID`, `CLI_WORKSPACE_ID`, `CLI_PRINCIPAL_ID` | Identité autorisée API/CLI obligatoire, jamais un secret. | Déploiement ou environnement CLI public. |
| `ADMIN_ALLOWED_ORIGINS` | Liste obligatoire d'origines navigateur exactes ; HTTPS sauf loopback dev explicite. | Configuration publique. |
| `ADMIN_ENABLE_PASSWORD_AUTHENTICATION` | Mot de passe prod désactivé par défaut. `true` seulement pour accès break-glass avec identifiants uniques ; incompatible avec OIDC seul. | Configuration prod publique. |
| `ADMIN_LOGIN`, `ADMIN_PASSWORD` | Dev/test : `admin` / `admin`; prod : valeurs uniques seulement avec mot de passe explicitement activé. | Secrets ; `CASEWEAVER_ADMIN_LOGIN_FILE` et `CASEWEAVER_ADMIN_PASSWORD_FILE`. |
| `ADMIN_DISABLE_LOGIN_AUTHENTICATION` | API : `false` par défaut ; Compose prod : `true`. `true` impose OIDC complet. | Configuration publique. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CALLBACK_URL`, `OIDC_EPHEMERAL_KEY_ID` | Authorization Code + PKCE géré par API. Ces quatre valeurs et la clé doivent toutes être présentes ; callback HTTPS hors localhost et terminé par `/v1/auth/callback`. | Configuration publique. |
| `OIDC_CLIENT_SECRET`, `OIDC_EPHEMERAL_ENCRYPTION_KEY` | Secrets OIDC optionnels ; clé de chiffrement base64/base64url valide de 32 octets lorsque OIDC est activé. | Secrets ; fichiers OIDC correspondants. |
| `ADMIN_BOOTSTRAP_OIDC_SUBJECT`, `ADMIN_BOOTSTRAP_DISPLAY_NAME` | Bootstrap du premier administrateur, par paire et à retirer après mapping. | Configuration publique. |
| `TRUSTED_PROXY_CIDRS` | Seulement les CIDRs proxy fiables exacts ; les autres headers forwarded sont ignorés. | Configuration publique. |
| `WEBHOOK_HOST`, `WEBHOOK_PORT`, `WEBHOOK_MAXIMUM_BODY_BYTES` | Bind/limite corps webhook ; seule l'edge publie la route en prod. | Runtime/déploiement public. |
| `POSTGRES_DB`, `POSTGRES_USER`, `CASEWEAVER_RUNTIME_DATABASE_ROLE` | Noms base/rôle migration/rôle runtime privé ; runtime sans DDL. | Configuration prod publique. |
| `CASEWEAVER_RELEASE_VERSION`, `CASEWEAVER_POSTGRES_IMAGE`, `CASEWEAVER_MIGRATION_IMAGE`, `CASEWEAVER_API_IMAGE`, `CASEWEAVER_ADMIN_IMAGE`, `CASEWEAVER_WORKER_IMAGE`, `CASEWEAVER_SCHEDULER_IMAGE`, `CASEWEAVER_WEBHOOK_IMAGE`, `CASEWEAVER_STANDALONE_IMAGE`, `CASEWEAVER_ATTACHMENT_PROCESSOR_IMAGE`, `CASEWEAVER_EDGE_IMAGE`, `CASEWEAVER_S3_OPERATIONS_IMAGE` | Version release et toutes les images, obligatoirement identités digest-pinned. | Environnement opérateur public. |
| `CASEWEAVER_APPLICATION_SUBNET`, `CASEWEAVER_EGRESS_SUBNET`, `CASEWEAVER_EDGE_HTTP_BINDING`, `CASEWEAVER_EDGE_HTTPS_BINDING`, `CASEWEAVER_EDGE_PUBLIC_HTTPS_PORT`, `CASEWEAVER_EDGE_API_UPSTREAM`, `CASEWEAVER_EDGE_WEBHOOK_UPSTREAM` | Réseaux privés, bindings edge TLS et upstreams par mode ; le helper refuse un mode incohérent. | Configuration prod publique. |
| `CASEWEAVER_POSTGRES_PASSWORD_FILE`, `CASEWEAVER_RUNTIME_DATABASE_PASSWORD_FILE`, `CASEWEAVER_MIGRATION_DATABASE_URL_FILE`, `CASEWEAVER_RUNTIME_DATABASE_URL_FILE` | Identifiants PostgreSQL et URLs migration/runtime obligatoires. | Chemins fichiers secrets opérateur. |
| `CASEWEAVER_OIDC_CLIENT_SECRET_FILE`, `CASEWEAVER_OIDC_EPHEMERAL_ENCRYPTION_KEY_FILE`, `CASEWEAVER_ADMIN_LOGIN_FILE`, `CASEWEAVER_ADMIN_PASSWORD_FILE` | Secrets OIDC et login ; capacité optionnelle désactivée : fichier vide imposé par Compose. | Chemins fichiers secrets opérateur. |
| `CASEWEAVER_OBJECT_STORAGE_KEY_DERIVATION_SECRET_FILE`, `CASEWEAVER_OBJECT_STORAGE_S3_ACCESS_KEY_ID_FILE`, `CASEWEAVER_OBJECT_STORAGE_S3_SECRET_ACCESS_KEY_FILE`, `CASEWEAVER_TRUSTED_CA_FILE`, `CASEWEAVER_TLS_CERTIFICATE_FILE`, `CASEWEAVER_TLS_PRIVATE_KEY_FILE` | Stockage, CA privée et TLS ; fichiers stockage/TLS requis non vides. | Chemins fichiers secrets opérateur. |
| `CASEWEAVER_APPLICATION_SECRETS_DIRECTORY` | Dossier lecture seule de fichiers safe-named pour valeurs connecteur/fournisseur côté serveur. | Dossier secret opérateur. |
| `OBJECT_STORAGE_KIND`, `OBJECT_STORAGE_BACKEND_ID`, `OBJECT_STORAGE_KEY_PREFIX`, `OBJECT_STORAGE_S3_ENDPOINT`, `OBJECT_STORAGE_S3_REGION`, `OBJECT_STORAGE_S3_BUCKET`, `OBJECT_STORAGE_S3_BACKUP_BUCKET`, `OBJECT_STORAGE_S3_BACKUP_PREFIX`, `OBJECT_STORAGE_S3_FORCE_PATH_STYLE`, `OBJECT_STORAGE_S3_ENCRYPTION`, `OBJECT_STORAGE_S3_KMS_KEY_ID` | Stockage S3 compatible chiffré et politique backup séparée. | Configuration publique ; secrets dans les fichiers stockage. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_METRIC_EXPORT_INTERVAL_MS`, `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION`, `OTEL_SDK_DISABLED` | Endpoint, cadence, identité/version et désactivation OpenTelemetry. | Déploiement public ; endpoint sans identifiants. |
| `AI_CATALOG_LITELLM_COMMIT_SHA` | Pin facultatif de source catalogue de confiance à 40 caractères. | Configuration publique. |
| `CASEWEAVER_LOCAL_PORT`, `CASEWEAVER_ADMIN_PORT`, `CASEWEAVER_TEST_DB_PORT`, `CASEWEAVER_E2E_PORT`, `CASEWEAVER_BACKEND_IMAGE`, `CASEWEAVER_FRONTEND_IMAGE`, `CASEWEAVER_IMAGE_VERSION`, `CASEWEAVER_IMAGE_REVISION`, `CASEWEAVER_IMAGE_SOURCE`, `CASEWEAVER_IMAGE_CREATED` | Ports bridge/test/E2E et métadonnées image locale, jamais installation production. | Développement/test uniquement. |
| `CASEWEAVER_DOCUMENTATION_REPOSITORY`, `CASEWEAVER_OPENROUTER_KEY` | Mount Docusaurus local et valeur fournisseur seulement côté serveur dans l'overlay local. Admin reçoit au plus une référence opaque `env:`. | Environnement hôte développement, jamais navigateur. |
| `PG_BOSS_INTEGRATION` | Prérequis uniquement du test intégration qui le demande. | Test jetable. |

L'exemple Compose production est la référence vérifiée pour ports, images, fichiers,
modes et stockage. Exécutez `validate` avant Docker. `compose.local.yml` et
`compose.test.yml` sont volontairement différents et ne se mélangent pas aux secrets/
données de production.
