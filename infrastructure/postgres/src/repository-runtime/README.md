# PostgreSQL repository-runtime configuration

This submodule projects one exact immutable `repository-runtimes` administration
configuration version for trusted worker/provider composition. It never follows
`current_version_id`, returns no browser/API read model, and rejects a disabled
aggregate, cross-workspace pin, revoked checkout credential, malformed settings,
or an unknown-pricing bypass.

The broker/provider resolver's checkout locator is server-private. It may be
passed only to a checkout broker; it must never be logged, audited, traced, or
serialized. Analysis execution instead receives a separate secret-free
projection, so it cannot observe that locator. The worker still has to compose
a separately attested checkout broker and OCI sandbox, and all model execution
continues through `@caseweaver/ai-execution`.

The immutable settings shape is deliberately small and provider-neutral:

```json
{
  "repositoryId": "support-service",
  "pinnedCommit": "<40-or-64-character-hex-sha>",
  "bindingVersionId": "repository-agent-binding-v3",
  "allowedTools": ["listFiles", "readFile", "searchFiles"],
  "sandbox": {
    "timeoutMs": 120000,
    "maximumCpuMilliseconds": 120000,
    "maximumMemoryBytes": 536870912,
    "maximumOutputBytes": 1048576,
    "maximumToolCalls": 30
  },
  "agent": {
    "maximumTurns": 8,
    "maximumInputTokensPerTurn": 4096,
    "maximumOutputTokensPerTurn": 1024,
    "maximumInstructionCharacters": 64000,
    "budget": { "currency": "USD", "hard": true }
  }
}
```

Exactly one active credential registration must match the immutable version's
single opaque secret-reference locator. The locator is not part of the settings
document and is never exposed through administration reads.
