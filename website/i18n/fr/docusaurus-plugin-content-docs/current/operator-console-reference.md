---
sidebar_position: 2
title: Référence de la console opérateur
---

# Référence de la console opérateur

Cette référence vérifiée dans les sources aide à opérer la Console Admin
CaseWeaver ou à préparer un changement avec un opérateur. Elle décrit l'UI
autorisée par le serveur, non un client REST générique et non la promesse qu'un
connecteur, fournisseur ou flux est installé dans chaque déploiement.

La Console est un client à session cookie de l'API CaseWeaver. Elle ne détient
ni jeton OAuth, ni valeur secrète, ni client connecteur/fournisseur, ni connexion
à la base, checkout de dépôt ou politique d'autorisation. Un contrôle absent,
indisponible ou lecture seule signifie que l'API n'a pas annoncé de flux sûr pour
ce déploiement, espace ou permission. Ne le remplacez jamais par un appel API
fabriqué dans le navigateur.

Pour prérequis runtime, Compose et variables, consultez la
[référence de déploiement](./deployment-reference.md). Pour un protocole sûr pour
assistant, commencez par la [carte de connaissance opérateur](./operator-knowledge-map.md).

## Fonctionnement de la console

### Frontière de sécurité et audit côté serveur

L'API, et non le navigateur, résout opérateur, espace actif, permissions
effectives, jeton CSRF, idempotence, concurrence optimiste, versions,
décision prix/budget et résultat d'audit. Mutation réussie et audit sont
enregistrés atomiquement. Les lectures/téléchargements sensibles échouent fermés
si leur audit obligatoire ne peut pas être conservé.

Chaque lecture, requête, commande, mutation, test, export, téléchargement,
connexion, déconnexion et changement d'espace authentifié est limité à l'espace
et audité par le serveur. Une valeur de corrélation navigateur ne choisit jamais
acteur, permission, code action, cible ou résultat. Ne mettez jamais mot de
passe, clé API, jeton OAuth, URL de base, identifiant de checkout, cookie de
session ou valeur secrète dans un champ Console, une URL, diagnostic ou support.

### Cycle brouillon, version immuable et action protégée

Une configuration durable suit normalement ce cycle :

1. Créer un **brouillon** validé par serveur.
2. Lancer un test explicite et borné si l'UI le propose.
3. Examiner impact, expiration et coût fournis par serveur.
4. Activer la version exacte.
5. Examiner ressource, historique, travail durable et audit.

Activation/désactivation crée une version immuable successeur et ne réécrit pas
la configuration capturée par le travail existant. L'UI lit la révision serveur
avant une action de cycle de vie : une modification concurrente est refusée et
non écrasée. **Remove draft** écarte un brouillon inactif des listes/sélecteurs
ordinaires, conserve historique/audit et ne peut pas être réactivé.

Les actions coûteuses ou destructrices exigent preview et confirmation serveur.
L'API calcule l'impact et peut renvoyer estimation, expiration ou refus.
outcome_unknown signifie qu'une réussite ne peut pas être affirmée : examinez
cible, job, publication, coût et audit avant retry.

### Descripteurs et options dynamiques

**Registered type** n'est pas un texte inventé par l'opérateur. Les packages de
connecteurs et fournisseurs IA enregistrent des descripteurs sûrs. La Console lit
à l'exécution nom, schéma, aide, exemples, capacités, tests et slots de
références secrètes masquées. Un nouveau type peut apparaître sans changement
frontend ; un type absent n'est pas offert par ce déploiement.

Les sélecteurs sont aussi possédés par serveur. Les modèles viennent de
l'inventaire du fournisseur actif, les sources de l'espace courant et les dépôts
montés d'alias approuvés au déploiement. N'inférez jamais modèle, capacité, prix,
montage ou permission depuis un libellé.

## Connexion, espaces et navigation

### Connexion et disponibilité de session

La route #/login vérifie d'abord le cookie de session géré par API. Un
déploiement peut proposer mot de passe, **Continue with configured identity
provider**, ou les deux. Le mot de passe est envoyé seulement pour la requête
finale. OAuth/OIDC utilise Authorization Code + PKCE côté API ; le navigateur ne
reçoit ni ne stocke un jeton OAuth.

**Console unavailable** avec **Retry session check** signifie que l'API session
est inaccessible. Vérifiez santé API, origine UI autorisée, TLS/cookies et
identifiant de requête/corrélation ; ceci ne prouve pas qu'un mot de passe est
faux. Si aucune méthode n'est annoncée, corrigez l'authentification de
déploiement.

### Espace de travail actif

La barre affiche **Active workspace** seulement si la session possède plusieurs
appartenances autorisées. La sélection appelle le changement protégé CSRF et
rafraîchit les données. Elle ne donne pas un rôle et n'expose pas un autre espace.
**Sign out** termine la session gérée par serveur.

### Carte des écrans principaux

La navigation dépend des permissions. Un écran peut être caché sans toutes ses
permissions. Une ressource visible peut rester indisponible ou lecture seule si
sa surface n'est pas gérée par serveur.

| Route | Écran | Objectif | Guide détaillé |
| --- | --- | --- | --- |
| #/ | **Overview** | Pulse système lecture seule : santé, travail, budget et audit. Aucun connecteur/modèle n'est invoqué. | [Operations](./operations.md) |
| #/integrations | **Integrations** | Connecteurs, sources, plannings, webhooks et entrée de cas. | [Connecteurs](./connectors.md) |
| #/ai | **AI configuration** | Fournisseurs, inventaire, bindings, prix, budgets et tests mesurés. | [IA et coût](./ai-and-cost.md) |
| #/knowledge-analysis | **Knowledge & Analysis** | Collections, retrieval/prompt, pièces jointes, recettes et analyses. | [Connaissance et analyse](./knowledge-analysis.md) |
| #/repository-analysis | **Repository analysis** | Dépôt code et politique d'exécution bornée pour investigation. | [Connaissance et analyse](./knowledge-analysis.md#analyse-de-cas-assistée-par-dépôt) |
| #/publication | **Publication** | Politique publication, état durable et approbation si offerte. | [Operations](./operations.md) |
| #/operations | **Operations** | Jobs, reprise, coût, rétention, confidentialité, diagnostics et audit. | [Dépannage](./troubleshooting.md) |
| #/access | **Access & security** | Registre secrets, identités, espaces et rôles. | [Accès et secrets](./access-and-secrets.md) |
| #/platform | **Platform** | Capacité/readiness sûre et liens publics. | [Référence déploiement](./deployment-reference.md) |

## Overview

**Route :** #/
**Accès :** toujours affiché ; les signaux restent limités par permission/espace.

**System pulse** résume santé de file, signaux opérateur et budget sans démarrer
synchronisation, appel modèle, recherche dépôt ou test connecteur. Utilisez-le
comme entrée de diagnostic puis ouvrez **Jobs**, **Costs** ou **Audit** dans
**Operations**. Un signal absent n'est pas sain : utilisez l'état indisponible et
le [dépannage](./troubleshooting.md).

## Integrations

**Route :** #/integrations
**Permission navigation :** configuration.read ; chaque commande reçoit aussi
son autorisation propre.

Le registre de surfaces détermine si une ressource offre édition, cycle de vie,
action protégée ou seulement liste/détail.

### Instances de connecteur

Dans **Connector configuration drafts**, sélectionnez un **Registered type**
fourni serveur, donnez un nom d'instance, complétez ses champs et choisissez une
référence secrète active masquée pour chaque slot. Ne mettez jamais un
identifiant dans JSON ou URL endpoint.

Lorsqu'un descripteur propose **Test**, demandez preview bornée puis confirmez.
Le résultat ne contient que l'état, jamais réponse distante, endpoint, secret ou
exception interne. Un test réussi n'ingère pas de contenu, ne crée pas de trigger
et n'autorise pas la publication. Activez le brouillon exact ensuite.
L'inspection montre historique immuable, cycle, révision, condensat paramètres et
nombre de références.

### Sources de connaissance et plannings

**Create an inert source draft** ne contacte ni connecteur ni planificateur et ne
démarre aucune ingestion. Il sélectionne connecteur actif, **Knowledge
collection**, identités/versions de profils, taille de lot embedding, budget
embedding strict, comportement pièces jointes, politique synchronisation et
suppression.

La source fige ces choix. Les pièces jointes sont désactivées, optionnelles
(avertissements possibles) ou obligatoires (le travail s'arrête si preuve requise
non terminale). La synchronisation est du JSON fonctionnel borné ; les filtres
propres au connecteur restent dans le connecteur. **Tombstone deleted documents**
conserve un état auditable ; **Retain deleted documents** garde les documents.

Activez seulement quand connecteur, collection, politique et budget sont prêts.
**Synchronize** demande travail incrémental borné ; **Full rescan** demande
réévaluation contrôlée. Les workers font le travail, pas le navigateur.

**Create a source-version-pinned draft** crée un planning lié à une version
immuable de source. Il ne suit pas les éditions futures. Choisissez
**Synchronize changes** ou **Full rescan**, intervalle ou cron/fuseau IANA validé,
politique de chevauchement et première exécution UTC. **Skip overlapping
execution** évite la concurrence ; **Queue overlapping execution** conserve le
travail pour workers. Activez/désactivez par cycle de vie.

### Webhooks et automatisation d'entrée de cas

**Create a webhook endpoint draft** sélectionne connecteur actif et types
événement reconnus. Il définit taille/débit bornés, trigger opaque optionnel, JSON
sûr et références masquées. L'UI ne saisit jamais secret, en-tête, corps, URL
endpoint ou client connecteur. L'activation valide avant usage futur.

**Case analysis automation** décide l'entrée de cas :

- **Create a case analysis trigger draft** relie source de cas fournie serveur,
  recette immuable et profil publication. Choisissez **Polling** pour scan
  connecteur ou **Verified webhook endpoint** pour entrée validée.
- **Create a case intake schedule draft** fige le trigger et utilise intervalle
  ou cron cinq champs/fuseau. Le serveur calcule échéance, leases et
  chevauchements.

Créer le brouillon ne traite pas les tickets existants. Activez puis examinez
**Jobs**, **Analyses**, **Publications** et **Audit**.

## AI configuration

**Route :** #/ai
**Permission navigation :** configuration.read ; création, activation, prix,
budget et test restent autorisés séparément.

Cet écran sépare instance fournisseur, modèles annoncés par ce fournisseur et
enrichissement catalogue/prix optionnel.

### Activation et inventaire possédé par fournisseur

Dans **Configure an AI provider**, choisissez un descripteur, saisissez
**Instance display name** et complétez les champs dynamiques. Un descripteur
OpenAI-compatible impose un mode API explicite, par exemple embeddings ou chat :
CaseWeaver ne change jamais silencieusement de protocole. Sélectionnez une
référence secrète opaque, jamais une clé API.

Sauver crée un brouillon inerte validé. **Review and activate provider** est une
étape protégée distincte. Seuls fournisseurs actifs entrent dans les bindings.
Un brouillon inactif peut exposer **Remove draft** ; historique/audit restent.

Après activation, sélectionnez fournisseur et **Refresh models available from
provider**. Le serveur appelle le fournisseur et conserve inventaire borné de
l'espace lié à cette version. Le navigateur ne reçoit ni endpoint, secret,
réponse brute ni métadonnée de compte.

### Catalogue, bindings, défauts, prix et budget

**Refresh trusted model catalog** enrichit éventuellement prix/capacités. Il ne
rend pas chaque modèle catalogue exécutable. L'ensemble exécutable est
l'inventaire rafraîchi du fournisseur. Une correspondance canonique peut enrichir
le prix ; sinon il reste unknown, jamais zéro.

**Create a model binding draft** sélectionne fournisseur actif, modèle de son
inventaire, rôle CaseWeaver et limites tokens optionnelles. Il est immuable, pas
un modèle manuel ni identifiant. Révisez par version successeur puis utilisez
**Set workspace role default** pour sélectionner binding actif par défaut.

**Create pricing override** s'applique au modèle d'inventaire choisi et n'active
aucun autre modèle. Couvrez les unités : entrée pour embeddings/reranking,
entrée/sortie pour génération, unité image pour vision. Unknown reste unknown.

**Replace budget policy** crée/remplace limite versionnée. Un budget strict peut
bloquer travail mesuré avant démarrage. L'UI utilise révision serveur pour éviter
écrasement concurrent.

### Test de capacité borné

Le panneau vérifie binding actif compatible, prix connu/complet et budget strict
requis, puis demande preview et confirmation. Le serveur réserve budget, limite
débit, applique timeout, attribue coût et utilise la passerelle IA. Échec, refus
et outcome_unknown sont résultats durables, pas une raison de retry fournisseur
dans navigateur.

Voir [IA et coût](./ai-and-cost.md).

## Knowledge & Analysis

**Route :** #/knowledge-analysis
**Permission navigation :** analysis.read ; édition seulement pour surfaces
serveur gérées.

### Collections et profils

**Create a collection** crée un espace vectoriel permanent de l'espace. Il
demande ID durable, binding **embedding** actif, profil/compatibilité documenté
et dimension exacte. L'API fige le binding : changement IA ne modifie pas les
vecteurs existants. Créez collection distincte si représentation, dimension ou
compatibilité change. Ce n'est ni connecteur, source ni planning.

**Create retrieval profile draft** et **Create prompt profile draft** apparaissent
seulement si annoncés. Leur JSON est borné et refuse clés type identifiant. Ils
décrivent sélection d'évidence et contraintes prompt, pas fournisseur, connecteur,
modèle ou secret.

**Analysis profiles** et **Analyses** peuvent volontairement être liste/détail.
Une recette sélectionne un profil existant, elle ne l'édite pas.

### Intelligence pièces jointes et recettes

**Attachment intelligence and analysis recipes** configure préparation partagée
pour sources/cas. **Create an attachment handling policy draft** sélectionne
politique sécurité processeur approuvée et binding vision actif, puis limite
nombre/octet, entrées archive, taille extraite et profondeur. Le serveur
télécharge, vérifie MIME/archive, réutilise dérivés cache, appelle vision et
conserve preuve. Le navigateur reçoit seulement métadonnées sûres.

**Create an analysis recipe draft** compose versions immuables profil/binding
analyse, retrieval, prompt et publication. Enquête dépôt et préparation pièce
jointe peuvent être optionnelles/requises. Une preuve requise stoppe le run si
indisponible ; optionnelle laisse avertissement. L'API valide les relations,
notamment binding agent fixé par politique exécution, avant activation.

La recette est le plan versionné du cas : dépôt, pièces jointes, retrieval,
prompt, modèle et publication sont capturés pour qu'un retry n'utilise pas une
configuration plus récente.

## Repository analysis

**Route :** #/repository-analysis
**Permission navigation :** configuration.read.

Cet écran possède l'évidence code, non le contenu Git/Markdown de source. Il
crée versions dépôt/politique pour une recette. Le serveur lit, checkout et teste
les dépôts ; la Console ne lit jamais worktree.

### Brouillon dépôt de code

**Create a code repository draft** supporte deux emplacements :

- **Server-managed HTTPS repository** accepte URL HTTPS sans identifiant, sans
  jeton, mot de passe, query ou fragment. L'URL est transitoire, effacée après
  requête et absente listes/audit/contrôles. Dépôt privé peut sélectionner
  **Registered repository access** opaque.
- **Deployment-approved repository mount** sélectionne alias fourni serveur.
  Déploiement possède chemin derrière alias ; aucun chemin hôte ne va navigateur.

Choisissez branche/tag/SHA complet puis référence checkout. Branches/tags se
résolvent en commit exact ; SHA complet est immuable. HEAD, refspec, SHA court et
nom non sûr sont refusés. Utilisez test/activation brouillon si offerts.

### Politique d'exécution dépôt

**Create a repository execution policy draft** sélectionne binding agent actif
et alias sandbox possédé déploiement. Il choisit outils bornés, impose réseau
désactivé et fixe limites serveur taille/temps/processus. L'alias n'est ni chemin
hôte, image conteneur ou sandbox contrôlé navigateur. La recette sélectionne la
relation exacte politique/binding.

Voir [Connaissance et analyse](./knowledge-analysis.md#analyse-de-cas-assistée-par-dépôt).

## Publication

**Route :** #/publication
**Permission navigation :** analysis.read.

**Create a publication profile draft** définit politique destination versionnée
avec JSON borné sans identifiant. L'API valide destination/politique ; le
formulaire refuse champs ressemblant à secrets. Activez/désactivez avec cycle.
**Publication state** liste intentions, approbations, tentatives, reçus et
réconciliation ; ce n'est pas un écran d'envoi direct.

Si serveur expose publication en attente, utilisez **Approve publication** via
preview/confirmation. En cas échec/non résolu, examinez publication durable,
job/dead letter et audit, pas de doublon manuel.

## Operations

**Route :** #/operations
**Visible avec :** operations.inspect, cost.read, audit.read ou retention.run ;
chaque ressource/action garde sa permission.

Operations fournit preuve et récupération contrôlée, jamais appel SDK direct.

| Ressource | Ce qu'elle montre ou permet |
| --- | --- |
| **Jobs** | Travail durable sous lease et reprise ; annulation/récupération protégées. |
| **Dead letters** | Échec nécessitant inspection/retry. **Retry** est prévisualisé serveur. |
| **Costs** | Coût attribué et unknown explicite ; unknown n'est pas zéro. |
| **Retention** | État serveur ; **Request retention preview** avant confirmation reap. |
| **Privacy** | Données tombstonées, suppression contrôlée ; **Purge** exige confirmation. |
| **Diagnostics** | Posture masquée ; **Audited diagnostics export** donne état durable, téléchargement seulement prêt. |
| **Audit** | Activité administrative append-only, cible/résultat possédés serveur. |

L'UI ne sonde pas automatiquement export, ne conserve pas octets et ne construit
pas lien stockage. Redemandez un export expiré par flux audité. Voir
[Operations](./operations.md), [persistance et récupération](./persistence-recovery.md)
et [dépannage](./troubleshooting.md).

## Access & security

**Route :** #/access
**Visible avec :** workspace.manage, identity.manage ou credential.manage.

C'est le registre canonique de références secrètes. Formulaires Intégration/IA
sélectionnent une inscription masquée mais ne gèrent pas son cycle.

### Cycle référence externe de secret

Utilisez **Register where a secret lives** après que l'opérateur déploiement a
placé valeur dans backend/environnement serveur. Le résolveur open source fourni
accepte locator opaque env:UPPERCASE_NAME, par exemple
env:CASEWEAVER_PROVIDER_KEY. Cette chaîne indique où le serveur résout une
valeur, pas mot de passe, jeton ou clé.

Après **Register reference**, formulaire efface locator. Les écrans suivants ne
montrent que identité générée, cycle, dates et nombre de dépendances actives.
Descripteurs sélectionnent inscription, pas locator ni valeur.

Tournez d'abord valeur hors CaseWeaver, puis **Mark rotation required** et
**Confirm rotation**. **Revoke** est protégé/bloqué si une configuration active
dépend de la référence. Examinez dépendances et remplacez/désactivez d'abord.
L'audit contient identité, jamais valeur.

### Espaces, principals et rôles

**Workspaces** et **Principals** sont vues lecture seule résolues serveur. L'UI
ne crée ni appartenance ni identité. **Replace an operator's role set** choisit
principal fourni serveur et rôles définis par code dans l'espace actif. Elle lit
révision appartenance ; protection dernier administrateur, permissions effectives,
périmètre, historique et audit restent côté serveur.

Ne confondez pas rôle, mapping OIDC ou origine de confiance ; identité/origine/
proxy sont réglages de déploiement.

## Platform

**Route :** #/platform
**Permission navigation :** configuration.read.

Platform affiche capacité runtime, readiness, posture authentification et état
déploiement sûrs sans divulguer secrets ou configuration proxy/OIDC. **Public
links** est éditable seulement si surface gérée. Il configure bases API/webhook
publiques ; l'API normalise URL et dérive seulement routes webhook opaques fixes.

Utilisez HTTPS sauf si politique autorise explicitement HTTP loopback. Ce
formulaire ne configure ni issuer/client OIDC, proxy confiance, CORS, base ou TLS.
Voir [référence de déploiement](./deployment-reference.md).

## Parcours opérateur

### Enregistrer et utiliser une référence secrète

**Prérequis :** valeur provisonnée côté serveur et rôle pouvant gérer identifiants.

1. Ouvrez **Access & security** et entrez seulement **External secret reference**
   opaque. Le résolveur fourni utilise env:UPPERCASE_NAME.
2. Choisissez **Register reference** ; conservez identité générée, jamais valeur
   ou locator.
3. Dans formulaire descripteur, sélectionnez inscription masquée.
4. Tournez valeur externe puis confirmez rotation dans registre.
5. Avant revoke, examinez dépendances. Un blocage est attendu/sûr ; remplacez ou
   désactivez les dépendances.

**Résultat :** référence active sélectionnable sans valeur/locator dans état
navigateur, détail ressource, audit ou logs.

### Connecter et synchroniser la connaissance

**Prérequis :** binding embedding et budget strict actifs, descripteur connecteur
enregistré, connecteur actif après test éventuel.

1. Dans **AI configuration**, activez fournisseur embedding, rafraîchissez
   inventaire, créez/activez binding embedding, définissez prix/budget strict.
2. Dans **Knowledge & Analysis**, créez collection immuable avec profil/dimension
   exacts.
3. Dans **Integrations**, créez/testez/activez le connecteur dynamique en
   utilisant son aide.
4. Créez source avec collection, profils/versions, lot, budget, pièces jointes,
   synchronisation/suppression puis activez.
5. Lancez **Synchronize** ou créez planning figé. **Full rescan** est réservé à
   réévaluation volontaire.
6. Examinez source, **Jobs**, **Costs**, **Audit** : ressource durable prouve
   travail terminé, pas seulement message navigateur.

**Résultat :** binding collection figé, source/planning ne suivent pas une version
ultérieure sans action délibérée.

### Ajouter un fournisseur et lancer test borné

**Prérequis :** descripteur fournisseur, référence si requise, prix connu/enrichi
ou override complet, budget strict compatible si nécessaire.

1. Enregistrez référence opaque dans **Access & security**.
2. Dans **AI configuration**, choisissez **Registered type**, complétez champs
   dynamiques et créez brouillon.
3. Choisissez **Review and activate provider** ; brouillon sauvegardé n'est pas
   exécutable.
4. Sélectionnez fournisseur actif et **Refresh models available from provider**.
5. Créez/activez binding depuis inventaire, choisissez rôle/limites/défaut si utile.
6. Rafraîchissez catalogue fiable seulement pour enrichir ; il n'autorise pas un
   modèle absent inventaire. Override complet seulement pour ce modèle.
7. Définissez budget, demandez preview, vérifiez coût/impact/expiration puis
   confirmez une fois.

**Résultat :** résultat durable, coût attribué si disponible et audit sans secret
ni réponse brute fournisseur.

### Configurer analyse de cas assistée par dépôt

**Prérequis :** source cas éligible, versions actives analyse/retrieval/prompt/
publication, bindings/budgets IA et, si utilisé, binding agent + sandbox approuvé.

1. Dans **Repository analysis**, créez/testez/activez dépôt et politique. Utilisez
   URL transitoire sans identifiant ou alias montage, jamais chemin hôte/secret.
2. Dans **Knowledge & Analysis**, créez/activez politique pièces jointes puis
   recette ; choisissez preuve dépôt/pièce jointe optionnelle ou requise.
3. Dans **Integrations**, créez/activez trigger figeant recette/publication,
   polling ou webhook validé connecteur.
4. Pour polling créez planning ; pour webhook utilisez endpoint vérifié. Les deux
   mettent en file travail durable avec identité figée.
5. Examinez **Analyses**, **Publications**, **Jobs**, **Costs**, **Audit**.

**Résultat :** le cas capture recette, commit/politique dépôt, preuves pièces
jointes, chemin prompt/contexte, binding modèle et publication. Un retry ne prend
pas une configuration plus récente par surprise.

### Trouver les preuves d'audit

1. Restez dans espace où l'action a eu lieu.
2. Ouvrez **Operations → Audit** et utilisez identité/temps/requête/corrélation
   sûrs exposés par API.
3. Ouvrez historique cible ; pour travail accepté examinez job, analyse,
   publication, coût ou export.
4. Refus, validation et outcome_unknown sont auditables. Ne rejouez pas mutation
   avant de connaître état durable.

Le serveur possède acteur, espace, code action, cible, permission et résultat.
Audit exclut valeurs/tokens secrets, corps bruts, réponses distantes et contenu
prompt/contexte protégé.

## Disponibilité et erreurs

| État UI | Signification | Action sûre |
| --- | --- | --- |
| Chargement | Console attend réponse API bornée. | Attendre ou retry visible ; pas de mutation double. |
| Vide | Aucun enregistrement dans l'espace. | Satisfaire prérequis ou créer brouillon proposé. |
| Refusé/caché | Permission effective absente. | Demander administrateur autorisé ; pas de requête navigateur non documentée. |
| Indisponible/lecture seule | Flux non enregistré ou dépendance indisponible. | Vérifier composition, descripteurs/options et preuves Platform/Operations. |
| Validation | API rejette saisie/état. | Corriger valeur sûre indiquée, jamais identifiant JSON/URL. |
| Conflit | Modification rend révision obsolète. | Recharger, examiner, créer successeur. |
| Test/action échoué | Opération bornée échoue terminalement. | Examiner ressource, job/coût/audit et réparer au bon plan. |
| outcome_unknown | Réussite non affirmable. | Examiner preuves avant retry ; éviter travail externe double. |

## Visibilité ressources et cycle de vie

| Zone | Panneaux | Comportement normal |
| --- | --- | --- |
| Integrations | Connector instances, knowledge sources, schedules, webhooks | Brouillons descriptifs/cycle si annoncés ; sinon liste/détail sûr. |
| AI | Provider instances, model bindings, catalog snapshots, role defaults, pricing, budgets | Fournisseurs dynamiques et inventaire/binding/prix/budget serveur si gérés. |
| Knowledge | Collections, retrieval profiles, prompt profiles, analysis profiles, analyses | Édition collection/politique si gérée ; analyses parfois lecture seule. |
| Repository/case | Code repositories, execution policies, attachment policies, analysis recipes, case triggers/schedules | Brouillons typés, versions immuables, tests éventuels, activation. |
| Publication | Publication profiles, publications | Cycle politique si géré ; état/approbation si offert. |
| Operations | Jobs, dead letters, costs, retention, privacy, diagnostics, audit events | Inspection et récupération/purge/rétention/export protégés. |
| Access | Secret references, workspaces, principals, role assignments | Cycle secret canonique, autorité résolue, rôle protégé. |
| Platform | Runtime capability et public links | Posture/readiness sûre, bases publiques seulement si gérées. |

Pour prérequis déploiement et frontière public/secret, consultez la
[référence de déploiement](./deployment-reference.md). Pour le protocole assistant,
revenez à la [carte de connaissance opérateur](./operator-knowledge-map.md).
