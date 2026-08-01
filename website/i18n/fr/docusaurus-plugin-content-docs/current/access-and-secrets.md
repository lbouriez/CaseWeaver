---
sidebar_position: 3
title: Accès et secrets
---

# Accès, sessions et références de secret

**Disponibilité :** l'authentification de déploiement et le registre Accès et sécurité
sont disponibles. La console ne devient jamais un coffre de secrets.

## La connexion est une configuration de déploiement

La stack locale active `admin` / `admin`. L'API ne renvoie pas le mot de passe et le
navigateur ne le conserve pas après la requête de connexion. En production,
l'authentification mot de passe est désactivée sauf si le déploiement choisit
`ADMIN_ENABLE_PASSWORD_AUTHENTICATION=true` avec `ADMIN_LOGIN` et `ADMIN_PASSWORD`
non par défaut via fichiers secrets.

OIDC est une méthode Authorization Code + PKCE gérée par l'API. Tous
`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CALLBACK_URL`,
`OIDC_EPHEMERAL_ENCRYPTION_KEY` et `OIDC_EPHEMERAL_KEY_ID` doivent être présents
ensemble. Hors localhost explicite, le callback est HTTPS et finit par
`/v1/auth/callback`. Une installation neuve peut utiliser une fois
`ADMIN_BOOTSTRAP_OIDC_SUBJECT` avec `ADMIN_BOOTSTRAP_DISPLAY_NAME`, puis la retirer.

OIDC complet ajoute un choix OIDC ; le mot de passe reste actif sauf si
`ADMIN_DISABLE_LOGIN_AUTHENTICATION=true` est choisi. Ce mode est invalide sans OIDC
complet. `ADMIN_ALLOWED_ORIGINS` est une liste exacte et les en-têtes proxy ne sont
fiables que depuis `TRUSTED_PROXY_CIDRS`. L'API possède cookies `HttpOnly`, CSRF,
state, nonce, PKCE, changement d'espace, autorisation et audit. Aucun jeton ne passe
dans localStorage.

## Références de secrets externes

Dans **Accès et sécurité → Références de secrets**, enregistrez un locator opaque tel que
`env:CASEWEAVER_OPENROUTER_KEY`. Il nomme une valeur déjà disponible au backend de
secrets ; ce n'est pas sa valeur. La console ne renvoie qu'un identifiant généré et les
métadonnées de cycle de vie/dépendances, jamais le locator ou secret.

Sélectionnez l'enregistrement expurgé dans un connecteur ou fournisseur. Faites tourner
la valeur dans le backend externe puis utilisez **Confirm rotation**. **Revoke** est
protégé et refusé si une configuration active en dépend.
