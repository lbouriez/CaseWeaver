---
sidebar_position: 5
title: Contributing documentation
---

# Contributing documentation

The portal is an independent TypeScript Docusaurus project. Work from the repository
root and use its own package commands:

```powershell
pnpm --dir website install
pnpm --dir website typecheck
pnpm --dir website test
pnpm --dir website build
```

Keep pages concise and task-oriented. Before adding an operator claim, verify it against
the current implementation, configuration validation, and accepted delivery contract.
Mark incomplete behavior as unavailable rather than writing a speculative click path.

Translations are opt-in authoring work. The locale structure is present now; a human
review is required before a translated page is published. After editing an English page,
run `pnpm --dir website translations:status`. Update the locale page, have it reviewed,
then run `pnpm --dir website translations:manifest` to record the exact English source
revision that was reviewed. These commands never call an AI provider or read an API key.
