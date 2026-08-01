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
