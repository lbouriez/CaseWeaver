---
title: Référence de déploiement
---

# Référence de déploiement

CaseWeaver fournit plusieurs fichiers Compose car chacun a une frontière de confiance et
d'exploitation différente. Ce ne sont pas des recettes d'installation interchangeables.
Cette page décrit les topologies ; [Référence de configuration](./configuration-reference.md)
est le catalogue canonique des variables et [Auto-hébergement](./self-hosting.md) est le
runbook production court.

## Choisir la bonne topologie

| Fichier Compose | Utilisateur et commande | Services durables et état | Frontière publiée | Ne pas l'utiliser pour |
| --- | --- | --- | --- | --- |
| `compose.local.yml` | Développeur ou évaluateur. `docker compose -f deploy\docker\compose.local.yml up --build --wait` | PostgreSQL/pgvector, un backend standalone et Admin. Les migrations sont des jobs courts. Le volume PostgreSQL survit à `down`; `down -v` le supprime. | Seul le frontend Admin lie le loopback `CASEWEAVER_LOCAL_PORT` (défaut `8080`). | Une installation publique, conservée ou production. |
| `compose.local.documentation.yml` | Overlay optionnel pour évaluer une source Git/Docusaurus locale ; à ajouter après `compose.local.yml`. | Ajoute un montage read-only au backend standalone existant, sans nouveau service. | Le navigateur ne voit jamais le chemin hôte ni le montage. | Un montage Git générique, des identifiants distants ou une source production. |
| `compose.e2e.yml` | Automatisation du dépôt : `pnpm test:e2e:compose`; le runner le superpose à Compose local. | CA privée temporaire, fournisseur OpenAI-compatible déterministe et dépôt Git seedé, puis nettoyage du projet/volumes. | UI loopback temporaire, défaut `CASEWEAVER_E2E_PORT` (`18080`). | Validation manuelle, clé fournisseur réelle ou déploiement. |
| `compose.test.yml` | Tests d'intégration PostgreSQL lancés sur l'hôte. `docker compose -f deploy\docker\compose.test.yml up -d --wait` | PostgreSQL/pgvector seulement ; les tests tournent sur l'hôte. `down -v` supprime le volume jetable. | PostgreSQL loopback `CASEWEAVER_TEST_DB_PORT` (défaut `54329`). | API, Admin, worker ou base partagée. |
| `compose.admin.yml` | Pont Admin statique pour une API déjà disponible ailleurs. | Image Admin seulement, sans base, file, connecteur, fournisseur ni secret applicatif. | Port Admin loopback `CASEWEAVER_ADMIN_PORT` (défaut `8082`). | TLS, authentification, backend ou stack autonome. |
| `compose.production.yml` | Auto-hébergement production avec images publiées par digest. Employer `production-operations.mjs`. | PostgreSQL durable, edge/TLS, Admin, processeur de pièces jointes sans réseau, migrations explicites, objets S3 externes et un seul profil runtime. | Seul l'edge TLS lie HTTP/HTTPS ; PostgreSQL et application sont privés. | Tags mutables, identifiants DB runtime directs ou deux profils simultanés. |
| `compose.portainer.yml` | Backend Docker Standalone/Portainer avec Admin hébergé séparément, par exemple Pages. | PostgreSQL durable, backend standalone, processeur sans réseau, migrations explicites et edge API-only. Les objets restent dans S3 externe. | L'edge expose seulement `/v1/`, `/health/`, `/webhooks/`; `/` renvoie `404`. | Admin intégré, profil distribué, build depuis checkout ou helper production. |

## Carte des sources

Utilisez cette carte lorsqu'une automatisation doit vérifier une affirmation avant de
proposer une configuration. Les pages Markdown expliquent le contrat ; ces chemins sont
les sources d'implémentation.

| Sujet | Source principale | Autorité |
| --- | --- | --- |
| Services local, test, bridge Admin, E2E, production et Portainer | `deploy/docker/compose.local.yml`, `compose.test.yml`, `compose.admin.yml`, `compose.e2e.yml`, `compose.production.yml`, `compose.portainer.yml` | Graphe services, profils, montages, exposition réseau et interpolations. |
| Valeurs production/Portainer publiques | `deploy/docker/.env.production.example`, `deploy/docker/.env.portainer.example` | Clés opérateur et forme des chemins secrets. |
| Opérations production | `deploy/docker/production-operations.mjs` | Validation, migration, start, backup, restore, échecs sûrs. |
| Cookies, OIDC, origines et proxy | `apps/api/src/config.ts` | Valeurs, défauts, validations croisées. |
| Artefact runtime Admin | `deploy/docker/admin-runtime-config.sh`, `apps/admin/scripts/write-pages-runtime-config.mjs` | Origines API permises et `runtime-config`. |
| Worker, pièces jointes, stockage, scheduler et telemetry | `apps/worker/src/production-bootstrap.ts`, `infrastructure/attachment-runtime/src/attachment-processor-main.ts`, `infrastructure/object-storage/src/config.ts`, `apps/scheduler/src/production-bootstrap.ts`, `packages/observability/src/otel.ts` | Formes, limites et entrées runtime-only. |

## Évaluation locale : `compose.local.yml`

C'est le chemin minimum pour essayer le produit. Le processus standalone héberge API,
ingress webhook vérifié, ordonnanceur, worker durable et relais outbox comme modules
séparés dans un seul processus. Il ne remplace pas la file PostgreSQL par un dispatch
en mémoire.

```powershell
docker compose -f deploy\docker\compose.local.yml up --build --wait
curl.exe --fail http://localhost:8080/health/live
curl.exe --fail http://localhost:8080/health/ready
```

Ouvrez `http://localhost:8080`. Les identifiants de développement et le nettoyage sont
dans [Démarrage rapide](./quick-start.md). Supprimez volontairement la base d'essai :

```powershell
docker compose -f deploy\docker\compose.local.yml down -v
```

La stack contient une base de développement privée et un stockage objet local jetable.
Ne copiez ni ces valeurs ni la posture de connexion par mot de passe dans un autre
environnement. Le navigateur parle seulement au frontend, jamais directement à
PostgreSQL, une file, le stockage, un connecteur ou un fournisseur.

### Overlay de worktree documentation local

Utilisez cet overlay uniquement avec la base locale. Le répertoire
`CASEWEAVER_DOCUMENTATION_REPOSITORY` doit être la racine d'un worktree Git local avec
une entrée `.git`. Docker le monte en lecture seule, côté backend uniquement, dans
`/mnt/caseweaver/repositories/documentation`.

```powershell
$env:CASEWEAVER_DOCUMENTATION_REPOSITORY = '<chemin absolu vers le worktree Git local>'
docker compose -f deploy\docker\compose.local.yml -f deploy\docker\compose.local.documentation.yml up --build --wait
```

L'overlay fixe `CASEWEAVER_GIT_TRUSTED_LOCAL_ROOTS_JSON` à ce montage. Ce n'est pas un
champ Admin : un opérateur ne peut pas élargir une frontière de système de fichiers depuis
le navigateur. Voir [Git et Markdown](./git-markdown.md) pour le flux connecteur/source.

Une valeur fournisseur optionnelle reste côté backend dans l'environnement hôte. Dans
Admin, enregistrez et sélectionnez seulement une référence externe opaque `env:` ; ne
collez jamais la valeur fournisseur dans un formulaire ou une URL.

## Topologies de test

### Acceptation navigateur : `compose.e2e.yml`

`pnpm test:e2e:compose` est un parcours d'acceptation produit déterministe, pas un
chemin de configuration utilisateur. Il combine la stack locale et ce fixture, démarre
un endpoint OpenAI-compatible TLS privé et un dépôt Git seedé, puis Playwright configure
fournisseur et ingestion. Il n'appelle pas de fournisseur réel, ne lit pas un secret
opérateur et ne conserve pas les containers après succès.

Pour diagnostiquer un échec seulement, définissez `CASEWEAVER_E2E_KEEP_STACK=true`. Le
runner affiche le nom du projet unique à inspecter/supprimer. Ne superposez jamais ce
fichier à production ni à une instance locale manuelle.

### Base d'intégration hôte : `compose.test.yml`

Ce fichier démarre seulement PostgreSQL/pgvector pour les tests applicatifs hôte. Son
endpoint loopback est choisi par `CASEWEAVER_TEST_DB_PORT`; ce n'est pas une base runtime
locale générale.

```powershell
docker compose -f deploy\docker\compose.test.yml up -d --wait
pnpm test:integration
docker compose -f deploy\docker\compose.test.yml down -v
```

Ne dirigez pas des commandes développement/production vers cet endpoint sans avoir
prouvé que la base est jetable.

## Pont Admin : `compose.admin.yml`

Utilisez ce fichier avec une API déjà accessible à une origine publique et un conteneur
Admin local utile au diagnostic. Définissez l'origine API publique, sans identifiants :

```powershell
$env:CASEWEAVER_ADMIN_API_BASE_URL = 'https://api.example.invalid'
docker compose -f deploy\docker\compose.admin.yml up --build --wait
```

La configuration runtime accepte `/` pour un proxy same-origin ou HTTPS (HTTP seulement
en loopback développement). Elle n'ajoute ni CORS, ni OIDC, ni autorisation, audit,
base ou secret. L'API cible doit autoriser cette origine UI dans
`ADMIN_ALLOWED_ORIGINS` et posséder elle-même la session cookie.

## Production auto-hébergée : `compose.production.yml`

Cette topologie utilise des digests OCI linux/amd64 publiés, jamais un checkout. Elle
a deux profils runtime mutuellement exclusifs :

| Profil | Exécute | Upstreams edge |
| --- | --- | --- |
| `standalone` | Un processus API, webhook, scheduler, worker et relais, avec sidecar pièces jointes. | `standalone:3000` et `standalone:8081` |
| `distributed` | API, webhook, scheduler et worker séparés, avec le même sidecar. | `api:3000` et `webhook:8081` |

Les deux modes partagent comportement, file, leases et configuration immuable. Choisissez
exactement un mode. Changer de mode est une séquence backup, arrêt, migration,
configuration, démarrage, non une migration sans interruption.

Copiez `deploy/docker/.env.production.example` dans un emplacement opérateur et gardez
chaque secret dans son fichier restreint hors checkout. Le helper refuse avant rendu
Docker une image mutable, un fichier requis absent, une frontière stockage/proxy invalide
ou des upstreams incompatibles avec le profil :

```powershell
node deploy\docker\production-operations.mjs validate --env-file <fichier-env-operateur>
node deploy\docker\production-operations.mjs migrate --env-file <fichier-env-operateur> --mode standalone
node deploy\docker\production-operations.mjs start --env-file <fichier-env-operateur> --mode standalone
```

La migration est explicite et forward-only : PostgreSQL privé, Prisma, migration queue
puis grant du rôle runtime. Les services runtime utilisent le rôle DML séparé. Les
opérations suivantes valident aussi la configuration et arrêtent le runtime pendant la
modification des données :

```powershell
node deploy\docker\production-operations.mjs backup --env-file <fichier-env-operateur> --mode standalone --output <fichier-backup>
node deploy\docker\production-operations.mjs restore --env-file <fichier-env-operateur> --mode standalone --input <fichier-backup>
```

PostgreSQL est le volume Docker durable. TLS et le traitement de pièces jointes utilisent
des tmpfs privés ; les objets durables sont dans le stockage S3-compatible externe et
font partie de la récupération. Lire [Auto-hébergement](./self-hosting.md),
[Persistance et récupération](./persistence-recovery.md) et le
[modèle de menace](https://github.com/lbouriez/CaseWeaver/blob/main/deploy/docker/THREAT_MODEL.md) avant exposition réseau.

## Backend Portainer avec Admin externe : `compose.portainer.yml`

Portainer est volontairement une frontière différente de `compose.production.yml` :

| Question | Compose production | Compose Portainer |
| --- | --- | --- |
| Où est Admin ? | Dans l'edge TLS same-origin. | Hébergé séparément ; aucun service Admin et racine `404`. |
| Profils runtime ? | `standalone` ou `distributed`. | `standalone` seulement. |
| Opérations ? | `production-operations.mjs` valide, migre, démarre, sauvegarde et restaure. | Commandes Docker Standalone explicites, sans helper. |
| Images ? | Digests publiés, non checkout. | Même règle, sans build source. |

Copiez `.env.portainer.example` dans un chemin absolu opérateur du nœud Docker
Standalone. Il contient configuration publique et chemins absolus de fichiers secrets,
jamais leur contenu. Lancez la chaîne migration avant le profil runtime :

```powershell
docker compose --env-file <fichier-env-portainer> -f deploy\docker\compose.portainer.yml --profile migrate up --abort-on-container-exit grant-runtime
docker compose --env-file <fichier-env-portainer> -f deploy\docker\compose.portainer.yml --profile standalone up -d --wait
```

Admin externe doit avoir une origine HTTPS exacte dans `ADMIN_ALLOWED_ORIGINS`. Utilisez
`ADMIN_SESSION_COOKIE_SAME_SITE=none` seulement dans ce modèle HTTPS cross-origin,
configurez le callback OIDC sur l'origine **API** publique finissant par
`/v1/auth/callback`, puis fixez `TRUSTED_PROXY_CIDRS` au subnet application. Le navigateur
reçoit toujours seulement un cookie API `HttpOnly`, jamais un token OAuth. Le contrat
Pages est dans [Automatisation GitHub](https://github.com/lbouriez/CaseWeaver/blob/main/.github/README.md#admin-console--verified-cloudflare-pages-artifact).

Portainer conserve la frontière récupération PostgreSQL/S3 mais n'implémente pas un
second helper backup. Suivez la récupération normale ; n'inventez ni profil, UI ou
commande helper absents de ce fichier.

## Images et frontière d'exposition

Le Dockerfile publie huit targets : `migration`, `api`, `admin`, `worker`, `scheduler`,
`webhook`, `standalone` et `attachment-processor`. Ce dernier est un sidecar Unix-socket
séparé sans réseau dans tous les modes production ; il ne peut joindre ni base,
fournisseur, connecteur ni socket Docker.

Production n'expose que son edge TLS. L'évaluation locale et le pont Admin n'exposent
qu'un frontend loopback ; la stack de test n'expose qu'une base loopback. Un port API ou
PostgreSQL direct est un défaut de configuration, pas un raccourci de diagnostic.

## Séquence de déploiement sûre

1. Choisissez une topologie ; ne les combinez pas sans contrat explicite.
2. Utilisez [Référence de configuration](./configuration-reference.md) et seulement les
   clés consommées par cette topologie.
3. Conservez le contenu secret dans les fichiers/dossiers serveur documentés. Un chemin
   de fichier est configuration publique ; son contenu ne l'est pas.
4. En production, vérifiez identité/attestations release, exécutez `validate`, puis la
   migration explicite avant `start`.
5. Vérifiez `/health/live` et `/health/ready` via l'edge prévu, puis configurez les
   références fournisseur/connecteur dans Admin. Un conteneur sain ne valide pas une
   intégration.

Pour les tâches connecteur, IA, connaissance et analyse dépôt, commencez par la
[Carte de connaissance opérateur](./operator-knowledge-map.md).
