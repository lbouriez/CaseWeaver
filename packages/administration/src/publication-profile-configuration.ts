import type { MutationIdentity } from "./configuration.js";
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

/** Stable generic configuration resource name; it is not an HTTP route. */
export const publicationProfileConfigurationResource = "publication-profiles";

/**
 * The profile definition is validated by the publication package at the durable
 * adapter boundary. The browser cannot choose its immutable id or version:
 * administration derives both from the aggregate and its configuration revision.
 */
export interface PublicationProfileConfigurationProjection {
  readonly profileId: string;
}

/**
 * The PBI-012 profile projection is feature-owned. A durable adapter writes it
 * only when an immutable administration configuration becomes active. Existing
 * publication intents retain their PBI-012 version reference forever.
 */
export interface PublicationProfileConfigurationProjectionStore
  extends ConfigurationLifecycleStore {
  writePublicationProfile(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "active" | "disabled";
      readonly profile: PublicationProfileConfigurationProjection;
    }>,
  ): Promise<void>;
}

export interface CreatePublicationProfileConfigurationCommand {
  readonly workspaceId: string;
  readonly displayName: string;
  /** PBI-012 profile fields other than server-owned `id` and `version`. */
  readonly definition: Readonly<Record<string, unknown>>;
  readonly profile: PublicationProfileConfigurationProjection;
  readonly mutation: MutationIdentity;
}

export interface TransitionPublicationProfileConfigurationCommand {
  readonly workspaceId: string;
  readonly displayName?: string;
  /** PBI-012 profile fields other than server-owned `id` and `version`. */
  readonly definition: Readonly<Record<string, unknown>>;
  readonly profile: PublicationProfileConfigurationProjection;
  readonly expectedRevision: number;
  readonly lifecycle: "active" | "disabled";
  readonly beforeHash?: string;
  readonly mutation: MutationIdentity;
}

/** Browser input is limited to opaque identifiers; profile/version selection is server-owned. */
export interface PreviewPublicationProfileConfigurationCommand {
  readonly profileId: string;
  readonly analysisResultId: string;
}

/**
 * The transport supplies this only after resolving the authenticated session and
 * authorizing both publication and the selected analysis result. It deliberately
 * contains no analysis payload, renderer option, target, or destination input.
 */
export interface TrustedPublicationProfilePreviewContext {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly uiActionId?: string;
}

export interface PublicationProfilePreview {
  readonly profileVersion: string;
  readonly format: "plainText" | "markdown" | "html";
  /** Already bounded by the persisted PBI-012 output-size limit and this DTO cap. */
  readonly body: string;
}

/**
 * Composition resolves the active immutable PBI-012 profile, the workspace-owned
 * analysis result, and its existing renderer. It must persist the authoritative
 * sensitive-read audit before returning the rendered body; audit failure rejects
 * the preview rather than exposing it without a trail.
 */
export interface PublicationProfilePreviewPort {
  renderAndAudit(
    input: Readonly<{
      readonly command: PreviewPublicationProfileConfigurationCommand;
      readonly context: TrustedPublicationProfilePreviewContext;
    }>,
  ): Promise<PublicationProfilePreview>;
}

/**
 * Composes generic version/OCC/idempotency/audit behavior with the existing
 * PBI-012 publication profile parser and persistence projection. It does not
 * render publications, select an analysis target, or contact a destination.
 */
export class ManagePublicationProfileConfiguration {
  public constructor(
    private readonly transactions: AdministrationTransactionRunner,
    private readonly store: PublicationProfileConfigurationProjectionStore,
    private readonly audit: ConfigurationLifecycleAudit,
  ) {}

  public async create(
    command: CreatePublicationProfileConfigurationCommand,
  ): Promise<ConfigurationTransitionResult> {
    assertProfile(command.profile);
    const settings = profileSettings(command.profile, 1, command.definition);
    return this.transactions.transaction(async () =>
      new CreateConfigurationDraft(
        passthroughTransaction,
        this.store,
        publicationAudit(this.audit, "admin.publicationProfile.draft.created"),
      ).execute({
        workspaceId: command.workspaceId,
        configurationId: command.profile.profileId,
        resourceType: publicationProfileConfigurationResource,
        displayName: command.displayName,
        settings,
        secretReferenceIds: [],
        mutation: command.mutation,
      }),
    );
  }

  public async transition(
    command: TransitionPublicationProfileConfigurationCommand,
  ): Promise<ConfigurationTransitionResult> {
    assertProfile(command.profile);
    assertExpectedRevision(command.expectedRevision);
    const nextVersion = command.expectedRevision + 1;
    const settings = profileSettings(
      command.profile,
      nextVersion,
      command.definition,
    );
    return this.transactions.transaction(async () => {
      const transitioned = await new TransitionConfigurationVersion(
        passthroughTransaction,
        this.store,
        publicationAudit(
          this.audit,
          "admin.publicationProfile.configuration.changed",
        ),
      ).execute({
        workspaceId: command.workspaceId,
        configurationId: command.profile.profileId,
        resourceType: publicationProfileConfigurationResource,
        expectedRevision: command.expectedRevision,
        settings,
        secretReferenceIds: [],
        ...(command.displayName === undefined
          ? {}
          : { displayName: command.displayName }),
        lifecycle: command.lifecycle,
        ...(command.beforeHash === undefined
          ? {}
          : { beforeHash: command.beforeHash }),
        mutation: command.mutation,
      });
      if (transitioned.idempotency === "created") {
        if (transitioned.version.version !== nextVersion) {
          throw new Error(
            "Publication profile version projection is inconsistent.",
          );
        }
        await this.store.writePublicationProfile({
          workspaceId: command.workspaceId,
          configurationVersionId: transitioned.version.id,
          lifecycle: command.lifecycle,
          profile: command.profile,
        });
      }
      return transitioned;
    });
  }
}

/**
 * A narrow composition seam around the PBI-012 renderer. It never creates a
 * publication intent, invokes a destination, or accepts output/renderer settings
 * from the browser.
 */
export class PreviewPublicationProfileConfiguration {
  public constructor(
    private readonly previews: PublicationProfilePreviewPort,
  ) {}

  public async execute(
    command: PreviewPublicationProfileConfigurationCommand,
    context: TrustedPublicationProfilePreviewContext,
  ): Promise<PublicationProfilePreview> {
    assertIdentifier(command.profileId, "Publication profile identifier");
    assertIdentifier(command.analysisResultId, "Analysis result identifier");
    assertIdentifier(
      context.workspaceId,
      "Publication preview workspace identifier",
    );
    assertIdentifier(
      context.actorPrincipalId,
      "Publication preview actor identifier",
    );
    assertIdentifier(
      context.requestId,
      "Publication preview request identifier",
    );
    assertIdentifier(
      context.correlationId,
      "Publication preview correlation identifier",
    );
    if (context.uiActionId !== undefined) {
      assertIdentifier(
        context.uiActionId,
        "Publication preview UI action identifier",
      );
    }
    const preview = await this.previews.renderAndAudit({ command, context });
    if (
      !isIdentifier(preview.profileVersion) ||
      !["plainText", "markdown", "html"].includes(preview.format) ||
      typeof preview.body !== "string" ||
      preview.body.length > 1_000_000
    ) {
      throw new Error("Publication preview response is invalid.");
    }
    return Object.freeze({ ...preview });
  }
}

const passthroughTransaction: AdministrationTransactionRunner = Object.freeze({
  transaction: async <T>(operation: () => Promise<T>) => operation(),
});

function publicationAudit(
  audit: ConfigurationLifecycleAudit,
  action: string,
): ConfigurationLifecycleAudit {
  return Object.freeze({
    append: (input: Parameters<ConfigurationLifecycleAudit["append"]>[0]) =>
      audit.append({ ...input, action }),
  });
}

function profileSettings(
  profile: PublicationProfileConfigurationProjection,
  version: number,
  definition: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!isPlainObject(definition)) {
    throw new TypeError("Publication profile definition is invalid.");
  }
  if ("id" in definition || "version" in definition) {
    throw new TypeError(
      "Publication profile id and version are managed by the server.",
    );
  }
  return Object.freeze({
    ...definition,
    id: profile.profileId,
    version: String(version),
  });
}

function assertProfile(
  profile: PublicationProfileConfigurationProjection,
): void {
  assertIdentifier(profile.profileId, "Publication profile identifier");
}

function assertExpectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Publication profile expected revision is invalid.");
  }
}

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (!isIdentifier(value)) {
    throw new RangeError(`${label} is invalid.`);
  }
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)
  );
}

function isPlainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
