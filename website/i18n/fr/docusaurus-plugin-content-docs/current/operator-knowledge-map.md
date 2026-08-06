---
sidebar_position: 1
title: Carte de connaissances opérateur
---

# Carte de connaissances opérateur

**Objectif :** cette page est le point de départ sûr pour une personne ou un assistant
IA qui aide à configurer CaseWeaver. Elle indique quel document répond à quelle
question et, tout aussi important, quelles valeurs ne doivent jamais être demandées,
déduites ou conservées dans un navigateur.

CaseWeaver dispose de deux plans de configuration :

| Plan | Ce qui y appartient | Point de départ |
| --- | --- | --- |
| Déploiement | Images de conteneur, fichiers de secrets et base de données, origines publiques, amorçage OIDC, TLS, montages, stockage et topologie des processus. | [Référence de déploiement](./deployment-reference.md) |
| Console opérateur | Configuration de l'espace de travail auditée par le serveur : connecteurs, sources, instances de fournisseur IA, liaisons, budgets, recettes d'analyse de dépôt et politiques de publication. | [Référence de la console opérateur](./operator-console-reference.md) |

Ne déplacez pas un réglage de déploiement dans le navigateur parce qu'un champ de la
Console n'est pas visible. Ne déplacez pas un réglage de la Console dans Compose parce
qu'il est disponible dans une variable d'environnement. Ces frontières protègent
l'isolation des espaces, l'historique immuable, l'audit et la non-divulgation des
identifiants.

## Protocole de configuration sûr

Suivez ce protocole avant de proposer une modification :

1. Identifiez l'objectif, l'espace de travail visé et s'il s'agit d'une évaluation ou
   d'une installation persistante.
2. Lisez la page de tâche et ses **Prérequis**. Vérifiez le descripteur ou la liste
   d'options fournie par le serveur dans la Console plutôt que de supposer l'existence
   d'un connecteur, fournisseur, modèle, liaison, montage de dépôt ou permission.
3. Classez chaque entrée nécessaire : réglage public, identifiant opaque, référence de
   secret de déploiement ou valeur secrète. Seul l'opérateur de déploiement fournit une
   valeur secrète à son gestionnaire de secrets ou fichier. La Console reçoit seulement
   un identifiant d'enregistrement de référence masqué après sa création.
4. Créez un brouillon lorsque la Console le propose. Validez ou exécutez le test
   explicitement borné. Examinez l'impact et le coût fournis par le serveur, puis
   activez uniquement la version immuable exacte qui a été testée.
5. Vérifiez le résultat durable dans le panneau de ressource indiqué et utilisez
   **Operations → Audit** pour trouver le résultat de l'action détenu par le serveur.
   Un clic dans le navigateur ne prouve pas l'achèvement d'une opération en arrière-plan.

Un assistant doit présenter un changement proposé sous cette forme compacte :

| Élément | Réponse nécessaire |
| --- | --- |
| Objectif | Résultat souhaité sans inventer un fournisseur ni un connecteur. |
| Plan | Déploiement ou Console, avec la page ou l'écran précis. |
| Conditions préalables | Enregistrements actifs, permissions, capacités de montage/secrets/backend et exigences de budget. |
| Entrées | Valeurs publiques et identifiants opaques uniquement. Indiquez où l'opérateur de déploiement fournit un secret sans le demander dans une conversation. |
| Action | Brouillon, test/aperçu, activation, synchronisation ou inspection via le flux fourni par le serveur. |
| Résultat attendu | État durable à trouver dans le modèle de lecture Console/API. |
| Preuve | Historique de la ressource, état du travail/publication, coût et événement d'audit serveur à inspecter. |
| Échec sûr | Guide ou contrôle de déploiement précis ; jamais un contournement qui affaiblit identité, CSRF, audit, TLS ou isolation. |

## Règles de sécurité non négociables

- Ne demandez, répétez, journalisez ni placez dans une URL ou le stockage du navigateur
  une clé API, mot de passe, jeton OAuth, cookie, clé privée, URL de base de données ou
  autre valeur d'identifiant.
- Utilisez une référence de secret externe opaque telle que
  `env:CASEWEAVER_PROVIDER_KEY` uniquement quand le déploiement serveur expose ce nom
  dans son gestionnaire de secrets configuré. Le nom est une métadonnée ; sa valeur
  n'est jamais une entrée Console ni une réponse API.
- N'inventez jamais un type de connecteur/fournisseur, une identité ou un prix de
  modèle, une capacité, un filtre de source, un montage de dépôt ou une permission. Les
  listes de descripteurs, catalogues et options du backend sont l'autorité de
  l'installation en cours.
- Considérez un prix inconnu comme une décision de coût bloquée, jamais comme un coût
  nul. Configurez une politique de prix/budget explicite avant d'approuver un test
  comptabilisé lorsque l'API l'exige.
- Ne contournez pas une vérification échouée de fournisseur, connecteur, dépôt, OIDC,
  autorisation ou audit par un accès direct à la base, des appels directs du navigateur,
  une origine approuvée plus large ou un contrôle de sécurité désactivé.
- Un contrôle Console désactivé, indisponible ou en lecture seule est un état explicite
  du serveur. Ce n'est pas une invitation à construire une requête API non documentée.

## Carte de récupération

Utilisez la page la plus précise en premier. Chaque page possède des sections stables et
autonomes afin de pouvoir être indexée indépendamment.

| Besoin | Référence principale | Référence d'appui |
| --- | --- | --- |
| Comprendre chaque écran Console, ressource, flux et résultat d'audit | [Référence de la console opérateur](./operator-console-reference.md) | [Accès et secrets](./access-and-secrets.md) |
| Lancer une évaluation locale ou choisir une topologie Compose | [Référence de déploiement](./deployment-reference.md) | [Démarrage rapide](./quick-start.md) |
| Configurer une source Git/Markdown | [Git / Markdown](./git-markdown.md) | [Matrice de capacités des connecteurs](./connectors.md) |
| Configurer un adaptateur Jitbit source/cas/destination | [Jitbit](./jitbit.md) | [Connaissances et analyse](./knowledge-analysis.md) |
| Configurer un fournisseur IA, inventaire de modèles, liaison, prix ou budget | [Configuration IA et coût](./ai-and-cost.md) | [Référence de la console opérateur](./operator-console-reference.md) |
| Configurer un flux d'analyse de cas assistée par dépôt | [Connaissances et analyse](./knowledge-analysis.md) | [Référence de la console opérateur](./operator-console-reference.md) |
| Récupérer un travail, inspecter coûts, rétention, confidentialité, diagnostics ou audit | [Operations](./operations.md) | [Dépannage](./troubleshooting.md) |
| Installer, mettre à niveau, récupérer ou vérifier une image de livraison | [Auto-hébergement](./self-hosting.md) | [Persistance et récupération](./persistence-recovery.md) |

## Réalité des capacités

La documentation explique le parcours opérateur livré, mais le déploiement décide
toujours quels descripteurs et options sûrs sont enregistrés. Une page peut expliquer
le comportement d'un fournisseur ou connecteur dynamique sans promettre qu'il apparaît
dans chaque installation.

Pour les capacités volontairement différées, utilisez [État des capacités](./capability-status.md)
plutôt que de créer un plan de configuration. Pour une erreur, commencez par
[Dépannage](./troubleshooting.md) et préservez l'identifiant de requête/corrélation du
serveur s'il est affiché ; n'incluez pas de contenu de requête sensible dans un rapport
de support.
