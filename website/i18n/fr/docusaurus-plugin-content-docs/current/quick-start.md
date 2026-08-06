---
sidebar_position: 2
title: Démarrage rapide
---

# Démarrage rapide : évaluation locale jetable

**Disponibilité :** disponible pour un poste privé ; ce n'est pas une production.

## Prérequis et lancement

Installez Docker Desktop avec Compose, Node.js 22.13 ou plus récent et Corepack. Clonez
le dépôt ; aucun compte cloud, clé fournisseur ou connecteur externe n'est requis.

```powershell
corepack enable
pnpm install
docker compose -f deploy\docker\compose.local.yml up --build --wait
```

La commande démarre trois services persistants : PostgreSQL/pgvector, un backend
standalone et le frontend Admin. Prisma et les migrations de file sont des jobs courts
terminant avant le backend. Seul le frontend expose un port.

Ouvrez `http://localhost:8080` ou `http://127.0.0.1:8080`, puis utilisez
`admin` / `admin`. Ces valeurs sont seulement pour la stack loopback de développement.
Remplacez-les via l'environnement hôte avant de partager une UI privée, jamais dans
navigateur, URL ou documentation.

```powershell
$env:ADMIN_LOGIN = "local-operator"
$env:ADMIN_PASSWORD = "<non-default private local value>"
docker compose -f deploy\docker\compose.local.yml up --build --wait
```

## Vérifier et nettoyer

```powershell
curl.exe --fail http://localhost:8080/health/live
curl.exe --fail http://localhost:8080/health/ready
docker compose -f deploy\docker\compose.local.yml down -v
```

`down -v` convient **uniquement** ici : il supprime le volume local jetable. Ce n'est
jamais une commande de récupération production. `compose.test.yml` fournit seulement la
base jetable pour processus hôte (port `54329`) via `pnpm db:test:up` /
`pnpm db:test:down`. Une `DATABASE_URL` de test est requise seulement quand une suite
la demande. `compose.admin.yml` ne sert que le bridge Admin d'une API déjà
lancée : aucun accès base, file, connecteur ou IA.

Pour une expérience Git locale réelle, continuez avec [Git / Markdown](./git-markdown.md).
