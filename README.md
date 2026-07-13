# CaseWeaver

CaseWeaver is an open-source, helpdesk-neutral investigation engine for support cases.
It combines helpdesk conversations, historical resolutions, documentation, attachments,
and source code to produce evidence-backed analyses that can be reviewed or published
through the originating support system.

## Product principles

- Helpdesk systems are adapters. Jitbit is the first reference implementation, not a
  product dependency. Odoo or another case system must be addable without changing the
  core.
- Knowledge sources are independently configured adapter instances. Each source chooses
  its synchronization policy, knowledge collection, chunking profile, and embedding
  binding.
- Destinations are adapter instances selected by an analysis profile. Jitbit, Odoo, or
  another destination must be replaceable without changing analysis orchestration.
- AI providers and models are configuration. Embedding, vision, generation, reranking,
  and repository-agent roles may use different providers and models.
- GitHub Copilot SDK is an optional repository-agent implementation. Its BYOK support
  allows OpenAI-compatible endpoints without requiring a Copilot subscription.
- Every AI operation is attributable, budgetable, and auditable.
- Untrusted case content never receives unrestricted access to source code, credentials,
  the host filesystem, or the network.
- The initial product is a reliable investigation engine, not another generic chatbot.

## Planned first release

The first usable release will:

1. Ingest Markdown documentation from a Git repository.
2. Ingest resolved cases from a helpdesk through a connector.
3. Process case images, text files, logs, and safe ZIP archives.
4. Retrieve relevant historical and documentation knowledge.
5. inspect a pinned source-code revision through an isolated read-only agent.
6. Produce a structured analysis with evidence and confidence.
7. Preview or publish that analysis through a destination connector.
8. Persist job state, evidence, model usage, and cost.

Jitbit will validate the connector contracts. It must be removable without changing the
domain, ingestion, retrieval, analysis, or persistence packages.

Unchanged source items are no-op synchronizations. A Markdown file with the same Git
blob/content fingerprint or a resolved API case with the same external revision must not
be normalized, chunked, or embedded again. If an external revision changes but normalized
content does not, CaseWeaver records the observation without generating embeddings.

## Documentation

The `.features` directory is the authoritative implementation specification:

- [Product and scope](.features/01-product-and-scope.md)
- [Domain and workflows](.features/02-domain-and-workflows.md)
- [Architecture](.features/03-architecture.md)
- [Connector contracts](.features/04-connectors.md)
- [AI models and pricing](.features/05-ai-models-and-pricing.md)
- [Knowledge and retrieval](.features/06-knowledge-and-retrieval.md)
- [Attachments and security](.features/07-attachments-and-security.md)
- [Analysis and delivery](.features/08-analysis-and-delivery.md)
- [Data, observability, and cost](.features/09-data-observability-and-cost.md)
- [API, MCP, and future UI](.features/10-api-mcp-and-future-ui.md)
- [Engineering standards](.features/11-engineering-standards.md)
- [Roadmap](.features/12-roadmap.md)

Implementation-ready backlog items are temporarily maintained under
[`temp/pbi`](temp/pbi/README.md). They can later be imported into GitHub Issues and
removed from the repository.

## Status

CaseWeaver is currently in specification and foundation planning. No implementation
choices in this README override the detailed contracts in `.features`.

## License

Apache-2.0 is the planned license because it is permissive and includes an explicit
patent grant. The license file will be added with the repository foundation.
