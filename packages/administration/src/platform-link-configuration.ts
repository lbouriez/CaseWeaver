import type {
  ConfigurationLifecycle,
  MutationIdentity,
} from "./configuration.js";
import type {
  AdministrationTransactionRunner,
  ConfigurationLifecycleAudit,
  ConfigurationLifecycleStore,
  ConfigurationTransitionResult,
} from "./configuration-lifecycle.js";
import {
  CreateConfigurationDraft,
  TransitionConfigurationVersion,
} from "./configuration-lifecycle.js";

/** Stable generic configuration resource name; it is not a browser route. */
export const platformLinkConfigurationResource = "platform-links";

export interface PlatformLinkSettings {
  readonly apiPublicBaseUrl: string;
  readonly webhookPublicBaseUrl: string;
}

export interface CreatePlatformLinkConfigurationCommand {
  readonly workspaceId: string;
  readonly settings: PlatformLinkSettings;
  readonly mutation: MutationIdentity;
}

export interface TransitionPlatformLinkConfigurationCommand {
  readonly workspaceId: string;
  readonly settings: PlatformLinkSettings;
  readonly expectedRevision: number;
  readonly beforeHash?: string;
  readonly mutation: MutationIdentity;
}

/**
 * Deployment composition, rather than a browser request, decides whether a
 * local HTTP URL is permitted for a development installation.
 */
export interface PlatformLinkConfigurationPolicy {
  readonly allowHttpLocalhost: boolean;
}

/** Safe read model: public bases are configuration, never credentials. */
export interface PlatformLinkConfigurationState {
  readonly workspaceId: string;
  readonly configurationId: string;
  readonly configurationVersionId: string;
  readonly revision: number;
  readonly lifecycle: ConfigurationLifecycle;
  readonly settings: PlatformLinkSettings;
}

/**
 * Read adapters validate persisted values again before returning them. A missing
 * platform-links aggregate is distinct from deployment-owned OIDC/runtime status.
 */
export interface PlatformLinkConfigurationReadPort {
  find(
    input: Readonly<{ readonly workspaceId: string }>,
  ): Promise<PlatformLinkConfigurationState | undefined>;
}

/**
 * Persists workspace public-link bases as immutable configuration versions.
 * OIDC, trusted proxy, health, and runtime details are intentionally excluded:
 * they remain deployment-owned read-only status.
 */
export class ManagePlatformLinkConfiguration {
  public constructor(
    private readonly transactions: AdministrationTransactionRunner,
    private readonly store: ConfigurationLifecycleStore,
    private readonly audit: ConfigurationLifecycleAudit,
    private readonly policy: PlatformLinkConfigurationPolicy,
  ) {}

  public create(
    command: CreatePlatformLinkConfigurationCommand,
  ): Promise<ConfigurationTransitionResult> {
    const settings = normalizedPlatformLinks(command.settings, this.policy);
    return new CreateConfigurationDraft(
      this.transactions,
      this.store,
      platformAudit(this.audit, "admin.platformLink.draft.created"),
    ).execute({
      workspaceId: command.workspaceId,
      configurationId: platformLinkConfigurationId(command.workspaceId),
      resourceType: platformLinkConfigurationResource,
      displayName: "Public links",
      settings: platformLinkSettingsRecord(settings),
      secretReferenceIds: [],
      mutation: command.mutation,
    });
  }

  public transition(
    command: TransitionPlatformLinkConfigurationCommand,
  ): Promise<ConfigurationTransitionResult> {
    if (
      !Number.isSafeInteger(command.expectedRevision) ||
      command.expectedRevision < 1
    ) {
      throw new RangeError("Platform link expected revision is invalid.");
    }
    const settings = normalizedPlatformLinks(command.settings, this.policy);
    return new TransitionConfigurationVersion(
      this.transactions,
      this.store,
      platformAudit(this.audit, "admin.platformLink.configuration.changed"),
    ).execute({
      workspaceId: command.workspaceId,
      configurationId: platformLinkConfigurationId(command.workspaceId),
      resourceType: platformLinkConfigurationResource,
      expectedRevision: command.expectedRevision,
      settings: platformLinkSettingsRecord(settings),
      secretReferenceIds: [],
      lifecycle: "active",
      ...(command.beforeHash === undefined
        ? {}
        : { beforeHash: command.beforeHash }),
      mutation: command.mutation,
    });
  }
}

/** A stable per-workspace aggregate id; no client supplies it. */
export function platformLinkConfigurationId(workspaceId: string): string {
  if (
    typeof workspaceId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(workspaceId)
  ) {
    throw new RangeError("Platform link workspace identifier is invalid.");
  }
  return `platform-links:${workspaceId}`;
}

/**
 * Builds the public ingress URL without ever inspecting a request Host header.
 * The caller supplies the opaque server-generated endpoint id from persisted
 * endpoint configuration.
 */
export function webhookEndpointPublicUrl(
  webhookPublicBaseUrl: string,
  endpointId: string,
  policy: PlatformLinkConfigurationPolicy,
): string {
  if (
    typeof endpointId !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/u.test(endpointId)
  ) {
    throw new RangeError("Webhook endpoint identifier is invalid.");
  }
  const base = normalizedPublicBaseUrl(
    webhookPublicBaseUrl,
    policy.allowHttpLocalhost,
  );
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/webhooks/${endpointId}`;
  return url.toString();
}

export function normalizedPlatformLinks(
  settings: PlatformLinkSettings,
  policy: PlatformLinkConfigurationPolicy,
): PlatformLinkSettings {
  if (
    settings === null ||
    typeof settings !== "object" ||
    Object.getPrototypeOf(settings) !== Object.prototype
  ) {
    throw new TypeError("Platform link settings are invalid.");
  }
  return Object.freeze({
    apiPublicBaseUrl: normalizedPublicBaseUrl(
      settings.apiPublicBaseUrl,
      policy.allowHttpLocalhost,
    ),
    webhookPublicBaseUrl: normalizedPublicBaseUrl(
      settings.webhookPublicBaseUrl,
      policy.allowHttpLocalhost,
    ),
  });
}

function platformLinkSettingsRecord(
  settings: PlatformLinkSettings,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    apiPublicBaseUrl: settings.apiPublicBaseUrl,
    webhookPublicBaseUrl: settings.webhookPublicBaseUrl,
  });
}

function normalizedPublicBaseUrl(
  value: string,
  allowHttpLocalhost: boolean,
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_000) {
    throw new RangeError("Public base URL is invalid.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RangeError("Public base URL is invalid.");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" &&
      !(
        allowHttpLocalhost &&
        url.protocol === "http:" &&
        isLocalhost(url.hostname)
      ))
  ) {
    throw new RangeError("Public base URL must use HTTPS.");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function isLocalhost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

function platformAudit(
  audit: ConfigurationLifecycleAudit,
  action: string,
): ConfigurationLifecycleAudit {
  return Object.freeze({
    append: (input: Parameters<ConfigurationLifecycleAudit["append"]>[0]) =>
      audit.append({ ...input, action }),
  });
}
