---
sidebar_position: 1
title: Bienvenue
---

# CaseWeaver en une page

CaseWeaver aide une équipe de support à enquêter sur un dossier avec les connaissances
pertinentes de l'entreprise, tout en conservant les preuves et décisions opérationnelles
avec le résultat. Ce n'est ni une extension de navigateur, ni un coffre de mots de passe,
ni un chatbot générique.

```text
connaissances / dossiers / événements vérifiés
                    |
             travail durable en file
                    |
 preuves, IA bornée, résultat gouverné
                    |
       revue ou publication interne
```

Le navigateur n'est que la console opérateur. Il reçoit une session gérée par le serveur
et des enregistrements de configuration expurgés, jamais une URL de base de données, un
jeton de connecteur, une clé de fournisseur ou un jeton OAuth.

## Commencer au bon endroit

- Nouveau dans le projet : [Démarrage rapide](./quick-start.md).
- Connexion ou référence de secret : [Accès et secrets](./access-and-secrets.md).
- Connexion de contenu : [matrice des connecteurs](./connectors.md).
- Installation durable : [Auto-hébergement](./self-hosting.md), et non Compose de développement.

## Vocabulaire

| Terme | Signification |
| --- | --- |
| Instance de connecteur | Connexion testée et versionnée à un système externe. |
| Source de connaissance | Contenu et filtre choisis depuis un connecteur. |
| Collection | Identité immuable de l'espace d'embeddings indexé. |
| Planification | Déclencheur durable distinct pour une source ou un intake. |
| Profil d'analyse/publication | Politique versionnée pour produire/envoyer un résultat approuvé. |
| Référence de secret | Pointeur opaque vers une valeur du backend de secrets. |

## Libellés de disponibilité

**Disponible** signifie que l'API annonce un flux géré. **Lecture seule** signifie que
la console affiche l'enregistrement sans pouvoir le modifier sûrement. **Indisponible**
signifie qu'il n'existe aucun contournement navigateur documenté. Consultez le
[statut des capacités](./capability-status.md) avant de traiter une capacité prévue
comme une tâche opérateur.
