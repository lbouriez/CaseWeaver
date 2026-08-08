# Analysis and delivery

## Analysis profile

An analysis profile versions:

- model-role bindings,
- retrieval profile,
- attachment policy,
- repository bindings,
- prompt templates,
- output schema,
- and cost/token budgets.

Changing a profile creates a new version. Existing analyses remain linked to the version
that produced them.

## Structured result

The initial schema contains:

```ts
interface CaseAnalysis {
  summary: string;
  probableCauses: ProbableCause[];
  investigation: InvestigationStep[];
  recommendedActions: RecommendedAction[];
  evidence: EvidenceReference[];
  unansweredQuestions: string[];
  confidence: "low" | "medium" | "high";
  customerSafeSummary?: string;
}
```

Probable causes and recommendations reference evidence IDs. Evidence types include case
messages, attachment derivatives, knowledge chunks, and repository file/line ranges.
Assertions without evidence must be marked as hypotheses.

The model returns destination-neutral structured data validated by Zod. It does not
select destinations or produce trusted destination markup.

## Repository investigation

The agent receives:

- a bounded case summary,
- selected retrieval evidence,
- processed attachment text,
- repository and commit identity,
- explicit investigation goals,
- and a structured response contract.

Repository evidence records path, commit, line range, excerpt hash, and explanation.
Invalid paths or line ranges are rejected or downgraded before publication.

An analysis is auditably reconstructable where retained, not assumed deterministic.
Store binding/profile versions, request parameters, schemas, prompt and evidence hashes,
tool transcript references, provider identifiers, and source snapshots. Privacy deletion
leaves explicit tombstones and hashes rather than a claim of exact reproduction.

## Automatic draft pull requests

An immutable remote-HTTPS repository version may opt in to automatic Azure DevOps draft
pull requests only when its configured checkout reference is a branch and it has one
registered repository write credential. After a completed analysis, CaseWeaver schedules
at most one request when the structured result has `high` confidence and validated
repository findings. It resolves the latest configured target branch, keeps the analyzed
and refreshed commits separately, asks an architect phase to decide whether a narrow
correction is safe, then asks an author phase for bounded text-file replacements.

The Azure DevOps adapter creates a deterministic source branch and **draft** pull request.
It never runs an unknown target repository test suite, completes a pull request, alters
branch policy, creates a work item, or bypasses developer review. The PR body links the
analysis and any already-retained case/work-item reference, records documentation impact,
and explicitly says target-repository tests were not run. Durable states distinguish
queued, planning, authoring, draft created, no change, failed, and outcome unknown; an
uncertain remote write is never retried as a new branch.

## Publication policy

A separate publication profile versions:

- destination binding,
- renderer and template,
- notice/disclaimer policy,
- visibility and destination-specific limits,
- and publication mode.

Publication modes support:

- `previewOnly`
- `approvalRequired`
- `autoPublishInternal`

Customer-visible publication is outside the initial release. Notices and AI disclaimers
are appended by renderer policy. Destination adapters receive a rendered payload and a
stable publication marker.

## Failure behavior

- A failed attachment does not necessarily fail the case; policy decides whether it is
  required and the omission is visible in the result.
- Retrieval failure, repository-agent failure, and analysis-model failure are distinct.
- The system never returns success-shaped content after a required stage fails.
- Partial evidence and operation records remain available for diagnostics.
- Retries reuse completed derivatives and embeddings.
