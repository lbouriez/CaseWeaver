import {
  normalizedPlatformLinks,
  type PlatformLinkConfigurationPolicy,
  type PlatformLinkConfigurationReadPort,
  type PlatformLinkConfigurationState,
  platformLinkConfigurationId,
  platformLinkConfigurationResource,
} from "@caseweaver/administration";
import type { PrismaClient } from "@prisma/client";

import { PostgresConfigurationLifecycleStore } from "./configuration-store.js";

/**
 * A semantic transaction-bound construction point for platform-link mutations.
 * Generic immutable configuration persistence remains the only write mechanism.
 */
export class PostgresPlatformLinkConfigurationStore extends PostgresConfigurationLifecycleStore {}

/**
 * Safe platform-link projection. It selects only public bases from the current
 * immutable configuration version; no OIDC, trusted-proxy, secret, or request
 * host value is read here.
 */
export class PostgresPlatformLinkConfigurationReadStore
  implements PlatformLinkConfigurationReadPort
{
  public constructor(
    private readonly client: PrismaClient,
    private readonly policy: PlatformLinkConfigurationPolicy,
  ) {}

  public async find(
    input: Readonly<{ readonly workspaceId: string }>,
  ): Promise<PlatformLinkConfigurationState | undefined> {
    const configurationId = platformLinkConfigurationId(input.workspaceId);
    const configuration =
      await this.client.administrationConfiguration.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: configurationId,
          },
        },
        select: {
          resourceType: true,
          revision: true,
          lifecycle: true,
          currentVersionId: true,
        },
      });
    if (configuration === null) return undefined;
    if (
      configuration.resourceType !== platformLinkConfigurationResource ||
      configuration.currentVersionId === null ||
      !isLifecycle(configuration.lifecycle)
    ) {
      throw new Error("Persisted platform link configuration is invalid.");
    }
    const version =
      await this.client.administrationConfigurationVersion.findFirst({
        where: {
          workspaceId: input.workspaceId,
          configurationId,
          id: configuration.currentVersionId,
        },
        select: { settings: true },
      });
    if (version === null || !isPlatformLinkSettings(version.settings)) {
      throw new Error("Persisted platform link settings are invalid.");
    }
    const settings = normalizedPlatformLinks(version.settings, this.policy);
    return Object.freeze({
      workspaceId: input.workspaceId,
      configurationId,
      configurationVersionId: configuration.currentVersionId,
      revision: configuration.revision,
      lifecycle: configuration.lifecycle,
      settings,
    });
  }
}

function isLifecycle(
  value: string,
): value is PlatformLinkConfigurationState["lifecycle"] {
  return ["draft", "active", "disabled", "superseded"].includes(value);
}

function isPlatformLinkSettings(value: unknown): value is Readonly<{
  readonly apiPublicBaseUrl: string;
  readonly webhookPublicBaseUrl: string;
}> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "apiPublicBaseUrl" in value &&
    typeof value.apiPublicBaseUrl === "string" &&
    "webhookPublicBaseUrl" in value &&
    typeof value.webhookPublicBaseUrl === "string"
  );
}
