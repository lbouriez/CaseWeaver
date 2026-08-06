---
sidebar_position: 8
title: Configuration IA et coût
---

# Configuration IA, inventaire et coût

**Disponibilité :** la configuration fournisseur est guidée par descripteur. Le navigateur
ne fournit ni clé, ni réponse fournisseur, ni invocation modèle directe.

## Fournisseur OpenAI-compatible

1. Enregistrez dans **Accès et sécurité** une référence opaque, par exemple
   `env:CASEWEAVER_OPENROUTER_KEY` si ce nom est disponible au backend de secrets.
2. Dans **AI configuration**, créez un brouillon OpenAI-compatible avec endpoint API HTTPS
   et mode immuable embeddings, chat completions ou responses.
3. Relisez et activez. L'activation rend une identité sûre éligible, elle ne prouve pas
   tous les modèles.
4. Utilisez **Refresh models available from provider** : le serveur persiste un inventaire
   borné, isolé, lié à cette version fournisseur.
5. Créez un binding depuis cet inventaire, choisissez le rôle CaseWeaver, configurez
   prix/budget et utilisez le capability test protégé.

Le catalogue LiteLLM de confiance est distinct : le rafraîchir ne rend pas un modèle
global disponible. Une correspondance exacte enrichit l'inventaire ; sinon le prix est
**inconnu**, jamais zéro, et ne satisfait pas un budget strict sans override complet pour
ce modèle de ce fournisseur.

Utilisez une instance embeddings pour les vecteurs et chat/responses pour génération si
nécessaire. Le test est serveur, confirmation-bound, rate-limit, budget-gated et passe
seulement par `@caseweaver/ai-execution`.

## Binding, budget, historique

Un binding sélectionne un modèle par rôle ; un défaut de rôle sélectionne un binding actif ;
collection/profil/recette figent sa version. Le prix couvre tokens entrée embeddings/
reranking, entrée/sortie génération et unités image vision. Coûts/prix inconnus sont
consultables ; clés et réponses brutes ne le sont pas. Copilot SDK BYOK reste un runtime
dépôt séparé et borné, pas un binding embedding/chat ni appel direct de fonctionnalité.
