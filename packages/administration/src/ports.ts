import type { Permission } from "@caseweaver/security";
import type { ConfigurationDescriptor, DescriptorKind } from "./descriptor.js";
import type { CursorPosition } from "./pagination.js";
import type {
  ImmutableConfigurationVersion,
  MutationIdentity,
  StoredMutationResult,
  VersionedConfiguration,
} from "./configuration.js";

export interface DescriptorRegistry {
  list(
    input: Readonly<{
      readonly kind?: DescriptorKind;
      readonly after?: CursorPosition;
      readonly limit: number;
    }>,
  ): Promise<readonly ConfigurationDescriptor[]>;
  find(
    input: Readonly<{
      readonly kind: DescriptorKind;
      readonly type: string;
      readonly version?: string;
    }>,
  ): Promise<ConfigurationDescriptor | undefined>;
}

/** Trusted application composition registers safe descriptor snapshots only. */
export interface DescriptorRegistryWriter {
  register(value: unknown): Promise<ConfigurationDescriptor>;
}

export interface ConfigurationVersionStore {
  findConfiguration(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resourceType: string;
      readonly configurationId: string;
    }>,
  ): Promise<VersionedConfiguration | undefined>;
  findMutation(
    input: Readonly<{
      readonly workspaceId: string;
      readonly identity: MutationIdentity;
    }>,
  ): Promise<StoredMutationResult | undefined>;
  recordMutation(
    input: Readonly<{
      readonly workspaceId: string;
      readonly identity: MutationIdentity;
      readonly result: StoredMutationResult;
    }>,
  ): Promise<void>;
  appendImmutableVersion(
    input: Readonly<{
      readonly configuration: VersionedConfiguration;
      readonly version: ImmutableConfigurationVersion;
      readonly expectedRevision: number;
    }>,
  ): Promise<VersionedConfiguration>;
}

export interface ConfigurationChangeNotice {
  readonly workspaceId: string;
  readonly resourceType: string;
  readonly configurationId: string;
  readonly previousVersionId?: string;
  readonly currentVersionId: string;
  readonly cacheScopes: readonly string[];
}

/** Implement through the durable application outbox after the caller transaction commits. */
export interface ConfigurationChangePublisher {
  publish(change: ConfigurationChangeNotice): Promise<void>;
}

/** Durable signal store. A relay publishes only committed, unacknowledged notices. */
export interface ClaimedConfigurationChange {
  readonly claimToken: string;
  readonly id: string;
  readonly change: ConfigurationChangeNotice;
}

export interface ConfigurationChangeOutbox {
  claim(
    input: Readonly<{
      readonly limit: number;
      readonly leaseMs: number;
    }>,
  ): Promise<readonly ClaimedConfigurationChange[]>;
  acknowledge(claim: ClaimedConfigurationChange): Promise<void>;
}

export interface AdministrationAuditIntent {
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string;
  readonly permission: Permission;
  readonly outcome: "succeeded" | "failed" | "denied";
  readonly beforeHash?: string;
  readonly afterHash?: string;
}
