import {
  gitMarkdownAdministrationDescriptor,
  testGitMarkdownAdministrationSettings,
} from "@caseweaver/connector-git-markdown";
import {
  jitbitAdministrationDescriptor,
  testJitbitAdministrationSettings,
} from "@caseweaver/connector-jitbit";
import { EnvironmentConnectorSecretResolver } from "@caseweaver/connector-runtime";
import {
  GitCliRepository,
  parseTrustedLocalRootsJson,
} from "@caseweaver/git-repository-runtime";

/** Safe composition registry. Connector-specific code stays in its adapter;
 * administration routes select an entry by the descriptor identity only. */
export interface ConnectorDraftTestRegistration {
  readonly descriptorType: string;
  readonly descriptorVersion: string;
  readonly operation: "connector.test";
  execute(
    settings: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<void>;
}

export function createConnectorDraftTestRegistrations(
  environment: NodeJS.ProcessEnv,
): readonly ConnectorDraftTestRegistration[] {
  const secrets = new EnvironmentConnectorSecretResolver(environment);
  const trustedLocalRoots = parseTrustedLocalRootsJson(
    environment.CASEWEAVER_GIT_TRUSTED_LOCAL_ROOTS_JSON,
  );
  const gitRepository = new GitCliRepository({
    environment,
    ...(trustedLocalRoots.length === 0 ? {} : { trustedLocalRoots }),
  });
  return Object.freeze([
    Object.freeze({
      descriptorType: "git-markdown",
      descriptorVersion: gitMarkdownAdministrationDescriptor.version,
      operation: "connector.test" as const,
      execute: (
        settings: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
      ) =>
        testGitMarkdownAdministrationSettings({
          settings,
          repository: gitRepository,
          secrets,
          signal,
        }),
    }),
    Object.freeze({
      descriptorType: "jitbit",
      descriptorVersion: jitbitAdministrationDescriptor.version,
      operation: "connector.test" as const,
      execute: (
        settings: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
      ) => testJitbitAdministrationSettings({ settings, secrets, signal }),
    }),
  ]);
}
