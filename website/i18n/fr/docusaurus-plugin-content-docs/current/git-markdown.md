---
sidebar_position: 5
title: Source Git / Markdown
---

# Source de connaissance Git / Markdown

**Disponibilité :** source de connaissance et de pièces jointes uniquement, pas source de
cas ni destination de publication.

## Dépôt HTTPS distant

Dans **Intégrations**, choisissez **Git / Markdown**. L'adresse de clone est distincte de
l'URL navigateur facultative qui rend les liens de provenance pratiques.

```json
{
  "repository": { "kind": "remote", "url": "https://github.com/example/support-docs.git" },
  "allowedLocalRoots": [],
  "ref": { "kind": "branch", "name": "main" },
  "browserUrl": "https://docs.example.test",
  "paths": { "include": ["docs/**/*.md", "docs/**/*.mdx"], "exclude": ["docs/drafts/**"] },
  "maximumMarkdownCharacters": 250000
}
```

L'URL clone doit être HTTPS, sans utilisateur, mot de passe, query ou fragment. Pour un
dépôt privé distant, sélectionnez une référence de jeton Git enregistrée, jamais un jeton
dans l'URL. Branche/tag doit être sûr ; un commit exact rend la source reproductible.
Chaque synchronisation enregistre le commit immuable réellement lu.

Lancez **Test**, relisez le preview serveur, activez le connecteur, puis créez/sélectionnez
collection, source et planification. **Synchronize** indexe Markdown/MDX avec provenance
dépôt, commit, chemin relatif et titre. Les blobs inchangés évitent un nouveau traitement.

## Worktree local en lecture seule pour l'évaluation

L'overlay local accepté est distinct de la stack de base. Le dossier doit être un worktree
Git complet contenant `.git`, monté en lecture seule seulement dans le backend standalone,
jamais dans Admin.

```powershell
$env:CASEWEAVER_DOCUMENTATION_REPOSITORY = "<absolute path to a Git worktree>"
docker compose -f deploy\docker\compose.local.yml -f deploy\docker\compose.local.documentation.yml up --build --wait
```

Configurez les chemins runtime, jamais un chemin navigateur :

```json
{
  "repository": { "kind": "local", "path": "/mnt/caseweaver/repositories/documentation" },
  "allowedLocalRoots": ["/mnt/caseweaver/repositories"],
  "ref": { "kind": "branch", "name": "main" }
}
```

Les chemins doivent exister, être canoniques et rester dans la racine autorisée après
symlinks. Un dépôt local ne peut pas utiliser de jeton Git. Cet overlay est seulement une
évaluation locale ; en production, un override de déploiement revu est requis.

## Docusaurus et récupération

Activez Docusaurus uniquement pour un dépôt Docusaurus. `siteUrl` est l'origine HTTPS,
`baseUrl` le préfixe avec slash, `routeBasePath` la route docs relative et `docsPath`
le dossier dépôt relatif. Corrigez URL HTTPS, référence, ref/filtre sûr ou mount revu,
puis relancez le test borné : n'élargissez pas les racines et n'insérez pas de crédential.
