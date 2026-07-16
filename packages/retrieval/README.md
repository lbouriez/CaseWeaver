# Retrieval

**PBI:** 009

Hybrid lexical/vector retrieval policies, collection selection, query-embedding reuse,
source quotas, score fusion, access filtering, context budgets, and optional reranking.

Database search is invoked through ports; this package does not contain PostgreSQL SQL.

`RetrievalService` invokes embeddings and reranking only through
`AiExecutionGateway`, forwarding server-owned analysis identity/job attribution
when the request is part of case analysis. It creates one query embedding per binding only when all
selected collections sharing that binding have the same embedding profile and
dimensions. `RetrievalSearchPort` must perform bounded, active-revision and
access-constrained lexical/vector search in the persistence layer.

The service fuses ranks with deterministic reciprocal-rank fusion, deduplicates
by collection/source/revision/chunk, applies source candidate/final-result
quotas, then applies character and token budgets. If enabled, the reranker sees
only the token- and count-bounded fused candidates. `RetrievalSnapshotPort`
persists the frozen selected evidence and AI operation IDs as insert-only audit
state. Every token measurement names an immutable binding version and purpose:
embedding, reranking, or final prompt context. `WhitespaceTokenCounter` and the
in-memory snapshot/search ports are deterministic test fakes; production
composition must supply counters resolved for those exact retained bindings and
durable search/snapshot adapters. A missing tokenizer is a configuration failure,
never a fallback to a different model's tokenization.
