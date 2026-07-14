# Prompts

**PBIs:** 011, 014

Versioned prompt templates, bounded context assembly, structured-output schemas, and
prompt/evidence hashing shared by analysis and future chat.

Prompts are data and policy; provider invocation belongs behind `ai-sdk`.

`@caseweaver/prompts` owns immutable analysis-template contracts, bounded context
assembly, evidence delimiters and hashes, and the Zod-backed destination-neutral
analysis-output schema. It never invokes a provider or renders a destination payload.
