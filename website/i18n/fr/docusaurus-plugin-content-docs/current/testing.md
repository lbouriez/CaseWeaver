---
sidebar_position: 13
title: Tests
---

# Tester sûrement

Utilisez des fakes déterministes par défaut. Les tests intégration/E2E utilisent une base
jetable dont le nom est clairement de test ; ne pointez jamais `DATABASE_URL` vers la
production.

| Couche | Commande/prérequis | Protection |
| --- | --- | --- |
| Format/lint | `pnpm format:check`, `pnpm lint` | Source cohérente. |
| Dépendances | `pnpm deps:check` | Architecture interne. |
| Type/build | `pnpm typecheck`, `pnpm build` | Contrats types/packages. |
| Unit + contrat | `pnpm test` | Invariants et familles adaptateurs. |
| PostgreSQL | `pnpm db:test:up`, `DATABASE_URL` test, `pnpm test:integration`, `pnpm db:test:down` | Migrations, transactions, isolation, file. |
| E2E navigateur | `pnpm test:e2e` | Comportement Admin critique. |
| E2E Compose local | `pnpm test:e2e:compose` | Onboarding fournisseur et ingestion déterministes. |
| E2E Compose production | `pnpm test:e2e:production` | TLS, auth, rôles, backup/restore et deux modes. |

`PG_BOSS_INTEGRATION=1` n'est qu'un prérequis de test quand la suite le nomme. Les tests
IA live sont opt-in et plafonnés ; les tests/doc normaux n'appellent aucun fournisseur ni
ne demandent de crédential production. Nettoyez l'état test même après erreur.
