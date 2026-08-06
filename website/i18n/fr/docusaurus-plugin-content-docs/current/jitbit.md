---
sidebar_position: 6
title: "Jitbit : source vers publication"
---

# Jitbit : de la source à la publication interne

**Disponibilité :** Jitbit fournit source de connaissance, source de cas, pièces jointes
et destination d'analyse. Ces capacités sont indépendantes.

```text
connecteur Jitbit
  ├─ source connaissances résolues → collection → planification
  ├─ source de cas + pièces jointes → recette / intake analyse
  └─ destination d'analyse ← profil publication ← résultat approuvé
```

## Configurer et tester

1. Dans **Accès et sécurité**, enregistrez le locator API-token externe, jamais le jeton.
2. Dans **Intégrations**, créez un brouillon avec l'adresse HTTPS d'installation, pas
   une page ticket ni URL avec identifiants. Sélectionnez token expurgé, timeout, taille
   de page et limite de caractères.
3. Configurez optionnellement `initialUpdatedFrom` pour le premier import et
   `updatedFromOverlapDays` (un jour prudent) pour les dates Jitbit.
4. Lancez le test borné, contrôlez le statut sûr, puis activez la version immuable.

La source résolue filtre par défaut les états terminaux reconnus. C'est une politique de
version de source, pas globale. Après une synchronisation complète, le curseur durable
remplace la date initiale. Créez collection, source et planification ; commencez avec une
fenêtre bornée et vérifiez la provenance. Si d'anciens cas manquent, contrôlez date et
filtre ; ne supprimez jamais curseur/audit.

## Analyse et publication

Quand le serveur annonce les flux repository-analysis, créez séparément source de cas,
politique pièce jointe, recette/profil analyse et trigger/planification. Créez un profil
publication vers la destination Jitbit avec la politique d'approbation.

CaseWeaver publie uniquement un commentaire Jitbit **interne approuvé** avec marqueur
stable. Il ne crée pas de réponse client, ne décide pas l'approbation et ne relance pas
l'analyse. Après timeout d'écriture possible, l'état est `outcome_unknown` : réconciliez
cas/marqueur avant une autre tentative. Corrigez URL non HTTPS, token absent ou test
échoué avant activation ; jamais de jeton dans URL, logs ou console.
