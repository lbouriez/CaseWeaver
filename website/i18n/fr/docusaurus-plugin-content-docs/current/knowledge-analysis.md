---
sidebar_position: 7
title: Collections, sources, planifications et analyse
---

# Configuration connaissances et analyse

**Disponibilité :** collection, source, planification, politiques retrieval/prompt et
analyse dépôt apparaissent seulement si l'API annonce chaque surface gérée.

## Construire la connaissance volontairement

1. Dans **Knowledge & Analysis**, créez une collection avec binding embedding actif,
   profil de compatibilité et dimension vectorielle. Elle fige la version binding.
2. Dans **Integrations**, créez un connecteur puis une source choisissant collection et
   configuration source/filtre immuable.
3. Créez une planification pour la synchronisation automatique durable, ou utilisez
   **Synchronize** pour une exécution manuelle bornée. Elle fige une version source.
4. Utilisez retrieval/prompt profiles seulement si leur surface est gérée : politiques
   versionnées sans secret, pas sélecteurs de connecteur ou clé.

Images et pièces jointes suivent le même chemin borné pour connaissance/analyse : occurrence
identifiée, dérivé cache réutilisé, binding vision sélectionné par politique immuable.
Téléchargements, archives et IA restent serveur ; le navigateur reçoit statut/preuves sûrs.

## Analyse de cas assistée par dépôt

- **Repository analysis** : brouillons/tests dépôt code et politique exécution.
- **Knowledge & Analysis** : politique pièce jointe et recette analyse.
- **Integrations** : trigger cas et planification intake figés.

La recette choisit versions analyse/retrieval/prompt/publication et éventuellement dépôt/
pièce jointe. Ce n'est pas le profil analyse. L'intake fige la recette afin qu'une reprise
conserve commit, preuves, prompt/contexte et bindings. Les lectures sensibles sont
autorisées, isolées et auditées avant ouverture. Sans formulaire, pas de fallback JSON
ni appel fournisseur/dépôt direct dans Admin.

## Pull requests brouillons automatiques

Pour un dépôt HTTPS Azure DevOps, un administrateur peut activer **Créer automatiquement
une pull request brouillon Azure DevOps** seulement si le checkout configuré est une
branche et si un accès dépôt enregistré est sélectionné. Ce choix fait partie de la
version immuable du dépôt ; le secret reste utilisé uniquement côté serveur pour le
checkout et les opérations Azure DevOps.

Lorsqu'une analyse terminée a une confiance élevée et des constats dépôt vérifiés,
CaseWeaver crée une seule demande durable. Il actualise la branche cible configurée,
exécute une phase Architecte avant une phase Auteur, puis ouvre une PR **brouillon**
déterministe seulement pour une correction texte courte et étayée. Les développeurs
révisent et décident de la suite. CaseWeaver ne complète jamais la PR, ne modifie pas les
politiques de branche, ne crée pas de work item et n'exécute pas une suite de tests dépôt
inconnue. Le brouillon indique que les tests du dépôt cible n'ont pas été exécutés.

Si l'Architecte ne trouve pas de correction sûre, la demande se termine par **Aucune
modification**. Un résultat d'écriture distant non prouvable devient **Résultat inconnu**
et n'est pas relancé sur une nouvelle branche.
