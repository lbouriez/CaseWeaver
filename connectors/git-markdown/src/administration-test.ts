import type {
  ConnectorSecretReference,
  ConnectorSecretResolver,
} from "@caseweaver/connector-sdk";

import { gitMarkdownSettingsSchema } from "./config.js";
import type { GitRepository } from "./git-repository.js";

/**
 * Performs Git/Markdown's one safe, non-destructive administration check.
 * It resolves a server-owned reference only when the selected remote requires
 * it, then inspects one immutable repository snapshot.  Callers intentionally
 * receive no repository path, ref, commit, file, credential, or Git error.
 */
export async function testGitMarkdownAdministrationSettings(
  input: Readonly<{
    readonly settings: Readonly<Record<string, unknown>>;
    readonly repository: GitRepository;
    readonly secrets: ConnectorSecretResolver;
    readonly signal: AbortSignal;
  }>,
): Promise<void> {
  const settings = gitMarkdownSettingsSchema.parse(input.settings);
  const authentication =
    settings.authentication.kind === "token"
      ? {
          kind: "token" as const,
          token: (
            await input.secrets.resolve(
              settings.authentication.secretName as ConnectorSecretReference,
              input.signal,
            )
          ).value,
        }
      : ({ kind: "none" } as const);

  await input.repository.inspect({
    repository: settings.repository,
    allowedLocalRoots: settings.allowedLocalRoots,
    ref: settings.ref,
    authentication,
    signal: input.signal,
  });
}
