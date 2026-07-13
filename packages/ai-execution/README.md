# Metered AI execution

**PBI:** 003

Exclusive application-level gateway for every AI invocation:

1. Resolve and validate the immutable model binding.
2. Estimate and transactionally reserve applicable budgets.
3. Invoke the matching `ai-sdk` provider port.
4. Normalize usage and provider identifiers.
5. Reconcile reservations and persist operation/cost outcome.
6. Return only normalized results to the calling feature.

Knowledge, attachments, retrieval, analysis, prompts, and chat must not call provider
adapters directly.
