# Legacy implementation references

The following local implementations record valuable operational knowledge for initial
adapters. They are reference material only. CaseWeaver must not import, invoke, copy
credentials from, or couple its architecture to these projects.

## Jitbit API behavior

`C:\GIT\Nectari\Scripts\Cloud\Modules\HelpDeskHelper.psm1` is the reference for
PBI-007. It demonstrates the currently deployed Jitbit API paths and operational edge
cases:

- paginated lightweight ticket discovery through `/api/Tickets`;
- full-ticket and comments reads through `/api/ticket` and `/api/comments`;
- `updatedFrom` filtering for recent live-case discovery;
- attachment discovery from HTML, ticket attachments, and comment attachments;
- filtering system comments and CaseWeaver-equivalent AI publication markers;
- internal-comment publishing through `/api/comment`.

Implementations must improve on the legacy script by retaining opaque cursors and
immutable revision evidence, mapping API failures to typed connector errors, honoring
abort signals and retry hints, storing only secret references, and using stable
publication-marker reconciliation before a write. Attachment bytes and processing belong
to PBI-008, not the Jitbit connector.

## Copilot SDK agent behavior

`C:\GIT\Nectari\Scripts\Tools\AITinyBootstrap` is the reference for PBI-010. It
demonstrates a small TypeScript shell around Copilot SDK provider initialization, skill
prompt resolution, MCP injection, CLI configuration, structured logs, pipeline
artifacts, and cost/usage output.

CaseWeaver must preserve those useful operational capabilities while improving the
security and portability model: model roles and immutable bindings, provider-neutral
execution through `@caseweaver/ai-execution`, BYOK-compatible OpenAI endpoints, safe
budget reservation/reconciliation, and a credential-free, networkless, read-only
repository tool sandbox. Skill markdown is not an authorization boundary, and case data
cannot choose repositories, secrets, endpoints, tools, or egress.
