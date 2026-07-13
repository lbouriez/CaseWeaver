# Connector template

**PBI:** 006

Copy this directory to create a connector, then rename `package.json.example` and
`tsconfig.json.example` after choosing a package name. The root integration owner adds
the resulting workspace package and lockfile entry.

```
src/
  config.ts        # Zod settings schema and secret-reference envelope
  index.ts         # explicit registration of implemented capabilities only
  fakes.ts         # normalized, vendor-neutral fixtures
  config.test.ts   # package-local boundary test layout
```

The template deliberately implements no real API client. Add only the relevant
`KnowledgeSource`, `CaseSource`, `AttachmentSource`, `AnalysisDestination`, or
`WebhookAdapter` implementations, honor every `AbortSignal`, and validate remote input
with connector-owned schemas before mapping to SDK contracts. Secret values must be
resolved at runtime from the `secrets` references and redacted from diagnostics.
