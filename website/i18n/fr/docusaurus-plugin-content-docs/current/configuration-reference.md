---
sidebar_position: 9
title: Référence de configuration
---

# Référence de configuration

Ce catalogue, vérifié contre les sources, décrit les entrées de déploiement CaseWeaver.
Il documente des variables et chemins de fichiers secrets, pas des champs Admin. Admin
configure des ressources de workspace ; le déploiement définit où et comment le runtime
de confiance fonctionne. N'écrivez jamais ici ou dans un fichier environnement un mot de
passe, jeton, clé privée, URL avec identifiants ou valeur fournisseur.

**Classification :** *configuration publique* peut être dans un fichier opérateur;
*contenu secret* vient uniquement d'un fichier restreint ou du dossier secret serveur;
*local/test* est jetable; *runtime-only* est reconnu par un processus mais non transmis
par Compose production/Portainer officiel.

## Avant de définir une valeur

1. Choisissez une topologie dans [Référence de déploiement](./deployment-reference.md).
2. Copiez l'exemple adapté hors dépôt : `.env.production.example` ou
   `.env.portainer.example`.
3. Placez le contenu secret dans des fichiers opérateur distincts et définissez seulement
   le `CASEWEAVER_*_FILE` correspondant. Ne mettez jamais ce contenu dans Compose,
   commande, URL, runtime config navigateur, diagnostic ou log.
4. En production, exécutez `production-operations.mjs validate` avant le rendu Docker.

## API, base et build local

| Clé | S'applique à | Obligatoire/défaut | Validation et effet | Classification / fourniture | Règle d'automatisation sûre |
| --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | API, worker, scheduler, webhook, standalone, stockage | API : `development` par défaut; valeurs `development`, `test`, `production`. Compose prod fixe `production`. | Active les règles fichiers secrets et interdit le stockage local en production. | Configuration publique. | Laissez la topologie le définir; ne contournez jamais la validation prod. |
| `HOST`, `PORT` | Processus API | `HOST` vaut `0.0.0.0`; `PORT` est requis pour API directe. Compose fixe le port interne. | Port entier `1` à `65535`. | Publique; runtime-only pour Compose prod. | Ne publiez jamais ce port interne directement. |
| `DATABASE_URL` | API/worker/scheduler/webhook/standalone direct | Requis sans loader `DATABASE_URL_FILE`. | URL PostgreSQL obligatoire; prod refuse la valeur directe. | Contenu secret; direct local/test uniquement. | Ne le sérialisez, journalisez ou mettez jamais dans `.env`. |
| `DATABASE_READINESS_TIMEOUT_MS` | API | Requis direct; défaut Compose prod/Portainer `5000`. | Entier `1` à `60000`, attente readiness seulement. | Publique. | Ajustez après mesure, jamais pour masquer un problème de droits DB. |
| `API_WORKSPACE_ID`, `API_PRINCIPAL_ID` | Bootstrap API/standalone | Requis par les exemples production/Portainer. | Contexte d'exécution bootstrap, jamais identité navigateur/droit. | Publique. | Traitez un changement comme une modification d'identité/bootstrap. |
| `POSTGRES_DB`, `POSTGRES_USER`, `CASEWEAVER_RUNTIME_DATABASE_ROLE` | PostgreSQL prod/Portainer | Défauts exemples : `caseweaver`, `caseweaver_migrator`, `caseweaver_runtime`. | Le rôle runtime a DML, pas DDL. | Publique. | Gardez migration/runtime séparés. |
| `CASEWEAVER_BACKEND_IMAGE`, `CASEWEAVER_FRONTEND_IMAGE`, `CASEWEAVER_MIGRATION_IMAGE` | Build/cache local | Backend/frontend utilisent des noms locaux; migration est aussi image production. | Compose local build les targets; prod valide les digests. | Backend/frontend local/test; migration voir images prod. | N'employez pas un tag local en production. |
| `CASEWEAVER_IMAGE_VERSION`, `CASEWEAVER_IMAGE_REVISION`, `CASEWEAVER_IMAGE_SOURCE`, `CASEWEAVER_IMAGE_CREATED` | Labels build local | Défauts metadata locale. | Métadonnées OCI seulement. | Local/test. | Source non secrète, jamais URL avec identifiants. |

## Artefact Admin et origine navigateur

| Clé | S'applique à | Obligatoire/défaut | Validation et effet | Classification / fourniture | Règle d'automatisation sûre |
| --- | --- | --- | --- | --- | --- |
| `CASEWEAVER_ADMIN_API_BASE_URL` | Image Admin / artefact Pages | Requis par `compose.admin.yml`; `/` same-origin, sinon origine HTTPS sans identifiants (HTTP loopback dev seulement). | Génère `runtime-config.json`; ce n'est pas une décision d'autorisation API. | Publique. | Origine seule, sans chemin, query, fragment, username, password ni token. |
| `CASEWEAVER_ADMIN_UI_TITLE` | Image Admin / Pages | Défaut `CaseWeaver Control Room`. | Texte sûr limité écrit dans runtime config. | Publique. | Texte d'affichage seulement. |
| `CASEWEAVER_ADMIN_PORT` | `compose.admin.yml` | Défaut `8082`. | Bind Admin-only sur loopback. | Local/test. | Ne le considérez pas comme frontière production. |
| `CASEWEAVER_LOCAL_PORT` | `compose.local.yml` | Défaut `8080`. | Seul port local publié et origine UI locale. | Local/test. | Loopback uniquement, redémarrer après changement. |
| `CASEWEAVER_ADMIN_PAGES_API_ORIGIN`, `CASEWEAVER_ADMIN_PAGES_ACCOUNT_ID`, `CASEWEAVER_ADMIN_PAGES_PROJECT`, `CASEWEAVER_ADMIN_PAGES_API_TOKEN` | Workflow publication Pages, pas Compose | Requis seulement si le propriétaire active Pages. | Produit un artefact Admin statique externe; token secret environnement protégé. | Trois variables GitHub publiques; `CASEWEAVER_ADMIN_PAGES_API_TOKEN` contenu secret GitHub. | Voir [Automatisation GitHub](https://github.com/lbouriez/CaseWeaver/blob/main/.github/README.md#admin-console--verified-cloudflare-pages-artifact); jamais de token dans Docker/Admin. |

## Authentification, cookies, OIDC et proxies

| Clé | S'applique à | Obligatoire/défaut | Validation et effet | Classification / fourniture | Règle d'automatisation sûre |
| --- | --- | --- | --- | --- | --- |
| `ADMIN_ALLOWED_ORIGINS` | Toute API interactive | Requis. Local fournit deux origines loopback; prod/Portainer une origine HTTPS exacte. | Liste d'origines exactes, sans wildcard, chemin, identifiant, query, fragment ni doublon. | Publique. | Valeur égale à l'origine Admin déployée, jamais une redirect URL. |
| `ADMIN_SESSION_COOKIE_SAME_SITE` | API/standalone | Défaut `lax`; `none` seulement production. | Contrôle cookie session API `HttpOnly` host-only. | Publique. | `none` seulement pour Admin HTTPS externe documenté; CSRF/origine restent stricts. |
| `ADMIN_DISABLE_LOGIN_AUTHENTICATION`, `ADMIN_ENABLE_PASSWORD_AUTHENTICATION` | API/standalone | Disable API `false`, exemples prod `true`; enable suit dev/test. | Ne peuvent pas activer mot de passe simultanément. | Publique. | Préférez OIDC; mot de passe = break-glass restreint. |
| `ADMIN_LOGIN`, `ADMIN_PASSWORD` | Login local/processus direct | Valeurs développement/test jetables; prod exige valeurs non défaut si activé. | API ne retourne jamais ces valeurs. | Contenu secret; prod : `CASEWEAVER_ADMIN_LOGIN_FILE`, `CASEWEAVER_ADMIN_PASSWORD_FILE`. | Jamais source, fichier env, URL ni navigateur. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CALLBACK_URL`, `OIDC_EPHEMERAL_KEY_ID`, `OIDC_EPHEMERAL_ENCRYPTION_KEY` | OIDC Authorization Code + PKCE API | Les cinq sont tout-ou-rien; callback HTTPS public hors loopback finit par `/v1/auth/callback`. | Issuer/callback HTTPS, key ID identifiant, clé 32 octets. | Publique sauf `OIDC_EPHEMERAL_ENCRYPTION_KEY`, secret via `CASEWEAVER_OIDC_EPHEMERAL_ENCRYPTION_KEY_FILE`. | Enregistrez callback API chez l'IdP, jamais l'URL Pages UI. |
| `OIDC_CLIENT_SECRET` | Client OIDC confidentiel | Optionnel selon client/fournisseur. | Chargé API seulement. | Secret via `CASEWEAVER_OIDC_CLIENT_SECRET_FILE`. | Jamais navigateur/artefact statique/formulaire. |
| `ADMIN_BOOTSTRAP_OIDC_SUBJECT`, `ADMIN_BOOTSTRAP_DISPLAY_NAME` | Première installation OIDC | Paire optionnelle, ensemble et seulement OIDC. | Crée le premier mapping admin. | Publique. | Retirez après création; utilisez un subject stable, pas un email mutable. |
| `TRUSTED_PROXY_CIDRS` | API/standalone derrière edge | Vide si aucun proxy; helper prod exige égalité avec `CASEWEAVER_APPLICATION_SUBNET`. | Liste IP/CIDR, `/0` rejeté. | Publique. | Seulement le subnet edge interne fixe. |
| `AI_CATALOG_LITELLM_COMMIT_SHA` | Refresh catalogue IA de confiance | Optionnel. | Pin le source catalogue serveur à un commit de confiance de 40 caractères. | Publique. | Enrichit prix/capacités seulement, ne rend jamais un modèle exécutable. |

## Images production, réseaux et cycle de vie

| Clé | S'applique à | Obligatoire/défaut | Validation et effet | Classification / fourniture | Règle d'automatisation sûre |
| --- | --- | --- | --- | --- | --- |
| `CASEWEAVER_RELEASE_VERSION` | Production/Portainer | Requis. | Identité telemetry/release. | Publique. | Provenance = release record vérifié. |
| `CASEWEAVER_POSTGRES_IMAGE`, `CASEWEAVER_MIGRATION_IMAGE`, `CASEWEAVER_API_IMAGE`, `CASEWEAVER_ADMIN_IMAGE`, `CASEWEAVER_WORKER_IMAGE`, `CASEWEAVER_SCHEDULER_IMAGE`, `CASEWEAVER_WEBHOOK_IMAGE`, `CASEWEAVER_STANDALONE_IMAGE`, `CASEWEAVER_ATTACHMENT_PROCESSOR_IMAGE`, `CASEWEAVER_EDGE_IMAGE`, `CASEWEAVER_S3_OPERATIONS_IMAGE` | Compose production | Tous requis par helper prod. Portainer emploie seulement ses services. | Chaque valeur est `image@sha256:<digest>` linux/amd64 immuable. | Publique. | Prenez toutes les valeurs du même release record, vérifiez provenance/SBOM. |
| `CASEWEAVER_APPLICATION_SUBNET`, `CASEWEAVER_EGRESS_SUBNET` | Réseaux internes prod/Portainer | Valeurs par défaut selon topologie. | Subnet application = `TRUSTED_PROXY_CIDRS` en validation production. | Publique. | Plages privées non chevauchantes. |
| `CASEWEAVER_EDGE_HTTP_BINDING`, `CASEWEAVER_EDGE_HTTPS_BINDING`, `CASEWEAVER_EDGE_PUBLIC_HTTPS_PORT` | Edge prod/Portainer | Requis production. | Edge TLS seul publie les ports. | Publique. | Aucun bind API/PostgreSQL direct. |
| `CASEWEAVER_EDGE_API_UPSTREAM`, `CASEWEAVER_EDGE_WEBHOOK_UPSTREAM` | `compose.production.yml` | Requis avec profil. | Doivent correspondre exactement à `standalone` ou `distributed`. | Publique. | Pas de hostname Docker arbitraire. |
| `CASEWEAVER_APPLICATION_SECRETS_DIRECTORY` | Runtime/worker/standalone prod/Portainer | Requis validation prod. | Dossier read-only; noms fichiers = identifiants environnement sûrs. | Dossier contenu secret, chemin public. | Monter seulement dans processus résolvant connecteurs/fournisseurs/dépôts, jamais Admin. |
| `CASEWEAVER_DEPLOYMENT_TEST_MODE` | Fixtures acceptation déploiement | Aucun défaut production. | Autorise temporairement images fixture en test. | Local/test. | Jamais une vraie installation. |

## Chemins de fichiers secrets Docker

Chaque clé est présente dans le contrat fixe Compose production/Portainer. Une capacité
optionnelle désactivée garde un fichier vide et restreint; les fichiers PostgreSQL,
URLs migration/runtime, stockage et TLS requis sont non vides.

| Clé | S'applique à | Obligatoire/défaut | Validation et effet | Classification / fourniture | Règle d'automatisation sûre |
| --- | --- | --- | --- | --- | --- |
| `CASEWEAVER_POSTGRES_PASSWORD_FILE`, `CASEWEAVER_RUNTIME_DATABASE_PASSWORD_FILE` | Bootstrap PostgreSQL | Fichiers réguliers non vides requis. | Sépare owner/bootstrap et mot de passe runtime DML. | Chemin public / contenu secret. | Fichiers distincts, rotation indépendante. |
| `CASEWEAVER_MIGRATION_DATABASE_URL_FILE`, `CASEWEAVER_RUNTIME_DATABASE_URL_FILE` | Jobs migration et runtime | Fichiers réguliers non vides requis. | URL migration seulement jobs; URL runtime seulement services. | Chemin public / contenu secret. | Ne les échangez ni réutilisez; aucune URL en environnement Compose. |
| `CASEWEAVER_OIDC_CLIENT_SECRET_FILE`, `CASEWEAVER_OIDC_EPHEMERAL_ENCRYPTION_KEY_FILE` | OIDC API/standalone | Chemins requis, contenu vide seulement OIDC désactivé. | Entrypoint charge dans processus de confiance. | Chemin public / contenu secret. | Inaccessible frontend/scheduler/webhook. |
| `CASEWEAVER_ADMIN_LOGIN_FILE`, `CASEWEAVER_ADMIN_PASSWORD_FILE` | Login mot de passe prod optionnel | Chemins requis, vide si login désactivé. | Valeurs non défaut seulement break-glass délibéré. | Chemin public / contenu secret. | Retirez/rotatez après usage. |
| `CASEWEAVER_OBJECT_STORAGE_KEY_DERIVATION_SECRET_FILE`, `CASEWEAVER_OBJECT_STORAGE_S3_ACCESS_KEY_ID_FILE`, `CASEWEAVER_OBJECT_STORAGE_S3_SECRET_ACCESS_KEY_FILE` | Stockage et opérations backup | Fichiers requis non vides pour S3 production. | Secrets seulement worker/standalone/opérations. | Chemin public / contenu secret. | Identité stockage moindre privilège, jamais dans registre secret Admin. |
| `CASEWEAVER_TRUSTED_CA_FILE` | TLS sortant | Chemin requis; vide si racines publiques suffisantes. | CA extra montée côté runtime. | Chemin public / contenu secret si CA privée. | Bundle CA, ni certificat client ni asset navigateur. |
| `CASEWEAVER_TLS_CERTIFICATE_FILE`, `CASEWEAVER_TLS_PRIVATE_KEY_FILE` | Edge public | Fichiers réguliers non vides requis. | Service material root/no-network copie vers tmpfs edge non-root. | Chemin public / contenu secret (clé). | Renouvellement volontaire et recréation material/edge. |

## Stockage, Git, dépôt et pièces jointes

| Clé | S'applique à | Obligatoire/défaut | Validation et effet | Classification / fourniture | Règle d'automatisation sûre |
| --- | --- | --- | --- | --- | --- |
| `OBJECT_STORAGE_KIND`, `OBJECT_STORAGE_BACKEND_ID`, `OBJECT_STORAGE_KEY_PREFIX` | Stockage worker/standalone | Production exige `OBJECT_STORAGE_KIND=s3`; préfixe `caseweaver`. | Backend ID/préfixe validés. | Publique. | Backend ID/préfixe distinct par environnement; jamais local en production. |
| `OBJECT_STORAGE_KEY_DERIVATION_SECRET` | Stockage local/processus direct | Requis runtime stockage. | Direct interdit bootstrap production. | Secret via `CASEWEAVER_OBJECT_STORAGE_KEY_DERIVATION_SECRET_FILE` en prod. | Serveur uniquement, rotation planifiée. |
| `OBJECT_STORAGE_LOCAL_ROOT` | Stockage local/direct | Chemin absolu requis seulement local hors production. | Stockage local rejeté avec `NODE_ENV=production`. | Local/test. | Jamais stockage objet durable production. |
| `OBJECT_STORAGE_S3_ENDPOINT`, `OBJECT_STORAGE_S3_REGION`, `OBJECT_STORAGE_S3_BUCKET`, `OBJECT_STORAGE_S3_FORCE_PATH_STYLE`, `OBJECT_STORAGE_S3_MULTIPART_PART_SIZE_BYTES` | Runtime S3-compatible | Région/bucket requis; endpoint optionnel prod, requis Portainer; path style `false`. | Endpoint sans identifiants; multipart borné. | Publique. | TLS selon besoin et identifiants dans fichiers secrets. |
| `OBJECT_STORAGE_S3_ENCRYPTION`, `OBJECT_STORAGE_S3_KMS_KEY_ID` | Runtime S3 | Chiffrement `AES256`; KMS requis selon mode. | Combinaisons invalides refusées. | Publique. | Politique chiffrement approuvée; ID KMS n'est pas secret. |
| `OBJECT_STORAGE_S3_BACKUP_BUCKET`, `OBJECT_STORAGE_S3_BACKUP_PREFIX` | Helper backup/restore | Requis helper prod; préfixe défaut exemple. | Destination backup validée/manifest non secret. | Publique. | Bucket séparé protégé et versionné. |
| `WORKER_GIT_TEMPORARY_DIRECTORY`, `WORKER_GIT_REMOTE_CACHE_DIRECTORY` | Git worker/standalone | Defaults chemins temporaires privés Compose. | Chemins absolus si fournis. | Publique. | Stockage temporaire privé, jamais dossier développeur partagé. |
| `CASEWEAVER_GIT_TRUSTED_LOCAL_ROOTS_JSON`, `CASEWEAVER_DOCUMENTATION_REPOSITORY`, `CASEWEAVER_OPENROUTER_KEY` | Overlay documentation local | Overlay requiert worktree et fixe JSON racines; valeur fournisseur optionnelle backend-only. | Worktree read-only au chemin fixe. | Local/test; `CASEWEAVER_OPENROUTER_KEY` contenu secret hôte. | Ni chemin ni valeur dans Admin; Admin sélectionne seulement référence `env:` opaque. |
| `WORKER_ATTACHMENT_RUNTIME_SOCKET_PATH`, `WORKER_ATTACHMENT_RUNTIME_JOBS_DIRECTORY` | Worker/processeur pièces jointes | Compose fixe les deux chemins UDS privés. | Doivent exister ensemble si traitement activé. | Publique; runtime-only hors Compose officiel. | Volume privé worker/standalone + sidecar sans réseau. |
| `WORKER_ATTACHMENT_RUNTIME_TIMEOUT_MS`, `WORKER_ATTACHMENT_RUNTIME_MAXIMUM_MEMORY_BYTES`, `WORKER_ATTACHMENT_RUNTIME_MAXIMUM_INPUT_BYTES`, `WORKER_ATTACHMENT_RUNTIME_MAXIMUM_OUTPUT_BYTES`, `WORKER_ATTACHMENT_RUNTIME_MAXIMUM_FILES`, `WORKER_ATTACHMENT_RUNTIME_MAXIMUM_EXPANDED_BYTES`, `WORKER_ATTACHMENT_RUNTIME_MAXIMUM_EXTRACTED_FILE_BYTES`, `WORKER_ATTACHMENT_RUNTIME_MAXIMUM_ARCHIVE_DEPTH`, `WORKER_ATTACHMENT_RUNTIME_MAXIMUM_COMPRESSION_RATIO` | Sidecar pièces jointes | Compose fournit valeurs sûres. | Plafonds stricts durée/mémoire/archive/fichiers/profondeur/sortie. | Publique. | Diminuez d'abord les limites pour pièces jointes non fiables; gardez sidecar isolé. |
| `WORKER_ATTACHMENT_EVIDENCE_MAXIMUM_BYTES`, `WORKER_ATTACHMENT_EVIDENCE_MAXIMUM_CHARACTERS` | Lecture evidence worker | Défauts bornés, non transmis Compose officiel. | Limite evidence dérivée conservée. | Runtime-only. | Modifier seulement runtime custom après revue rétention/evidence. |
| `ADMIN_REPOSITORY_ANALYSIS_GIT_TEMPORARY_DIRECTORY`, `ADMIN_REPOSITORY_ANALYSIS_GIT_REMOTE_CACHE_DIRECTORY`, `ADMIN_REPOSITORY_ANALYSIS_MOUNTS_JSON`, `ADMIN_REPOSITORY_ANALYSIS_SANDBOX_POLICIES_JSON`, `ADMIN_REPOSITORY_ANALYSIS_ATTACHMENT_PROCESSOR_POLICIES_JSON` | Runtime authoring analyse dépôt API | Entrées déploiement optionnelles, non transmises Compose. | JSON validé serveur et déploiement-owned. | Runtime-only. | Aucun chemin/montage/policy/remote/locator secret dans Admin. |
| `WORKER_REPOSITORY_AGENT_SOURCES_JSON`, `WORKER_REPOSITORY_AGENT_MOUNTS_JSON`, `WORKER_REPOSITORY_AGENT_SANDBOX_IMAGE`, `WORKER_REPOSITORY_AGENT_DOCKER_SOCKET_PATH` | Runtime agent dépôt worker | Frontière optionnelle; image sandbox digest-pinned. | Monte seulement sources/alias de confiance vers analyse isolée. | Runtime-only. | Ni credentials hérités, réseau ou socket Docker sans restriction. |

## Scheduler, webhook, observabilité et tests

| Clé | S'applique à | Obligatoire/défaut | Validation et effet | Classification / fourniture | Règle d'automatisation sûre |
| --- | --- | --- | --- | --- | --- |
| `SCHEDULER_POLL_INTERVAL_MS`, `SCHEDULER_BATCH_LIMIT`, `SCHEDULER_LEASE_MS` | Scheduler | Défauts `1000`, `25`, `30000`; Compose les utilise implicitement. | Entiers bornés pour polling/leasing, pas l'exécution connecteur. | Runtime-only. | Ajustement avec métriques queue/tests recovery, jamais contournement budget worker. |
| `WEBHOOK_HOST`, `WEBHOOK_PORT`, `WEBHOOK_MAXIMUM_BODY_BYTES` | Webhook | Compose distribué fixe host/port. | Bind ingress vérifié et limite taille corps. | Publique; host/port runtime-only Compose prod. | Publication seulement via edge TLS et signatures conservées. |
| `WORKER_OUTBOX_RELAY_BATCH_SIZE`, `WORKER_OUTBOX_RELAY_POLL_INTERVAL_MS`, `WORKER_TEAM_SIZE` | Worker | Défauts bornés, non transmis Compose. | Contrôle concurrence relay/consumer. | Runtime-only. | Scale après observation leases PostgreSQL, budgets et idempotence. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_METRIC_EXPORT_INTERVAL_MS`, `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION`, `OTEL_SDK_DISABLED`, `OTEL_TRACE_SAMPLE_RATIO` | Tous runtimes | Sans endpoint ou SDK désactivé : pas collector; métrique `30000`, trace `0.05`. | Endpoint sans identifiants; noms/ratios bornés. | Publique. | Telemetry expurgée vers collector de confiance, jamais identifiants dans URL. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Exporter OTEL | Optionnel. | Headers bornés. | Contenu secret si auth collector; runtime-only Compose. | Injection par mécanisme secret confiance, jamais fichier env commité. |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `SENTRY_ERROR_SAMPLE_RATIO`, `SENTRY_FLUSH_TIMEOUT_MS` | Sink Sentry optionnel | Sans DSN désactivé; sample erreur `1`, flush `1000`. | DSN HTTPS contient matériel secret; autres valeurs validées. | `SENTRY_DSN` secret; autres publiques; runtime-only Compose. | Events expurgés, jamais DSN dans navigateur/docs. |
| `CASEWEAVER_TEST_DB_PORT`, `PG_BOSS_INTEGRATION` | Tests hôte | Port défaut `54329`; flag queue seulement tests nommés. | Infrastructure test jetable. | Local/test. | Vérifiez que DB cible est jetable. |
| `CASEWEAVER_E2E_PORT`, `CASEWEAVER_E2E_KEEP_STACK`, `CASEWEAVER_E2E_OPENAI_COMPATIBLE_KEY`, `CASEWEAVER_E2E_PROVIDER_PORT` | Fixtures acceptation | Port UI `18080`; fournisseur synthétique test seulement. | Crée topologie Compose unique jetable. | Local/test. | Jamais fournisseur réel ni hors `pnpm test:e2e:compose`. |

## Variables volontairement hors Admin

Admin peut enregistrer une **référence opaque** vers une valeur serveur existante, pas
lire/modifier/lister les variables de déploiement. Une variable contrôle frontière
infrastructure/runtime; une ressource Admin est workspace-scoped, autorisée,
versionnée/immuable si nécessaire et auditée. Un ID de registre secret est du metadata,
ni locator ni valeur secrète. Pour les flux Console, voir
[Carte de connaissance opérateur](./operator-knowledge-map.md); pour topologie et
récupération, revenir à [Référence de déploiement](./deployment-reference.md).
