import type {
  AuthAuditPlan,
  AuthAuditRecorder,
  AuthSessionAuditMutationStore,
  AuthSessionStore,
  ConfigurationDescriptor,
  EphemeralSecretProtector,
  LoginTransaction,
  OidcAuthorizationCodeClient,
  OidcIdentityMapping,
  OidcIdentityMappingStore,
  SealedEphemeralValue,
  ServerSession,
} from "@caseweaver/administration";
import type { Permission } from "@caseweaver/security";

import { type ApiInstance, buildApi } from "../app.js";
import type { ApiConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { AdministrationApiOperations } from "../modules/administration/operations.js";
import {
  AuthSessionService,
  type AuthSessionServiceDependencies,
} from "../modules/auth/session-service.js";

class MemorySessionStore implements AuthSessionStore {
  public readonly transactions = new Map<string, LoginTransaction>();
  public readonly sessions = new Map<string, ServerSession>();

  public async createLoginTransaction(
    transaction: LoginTransaction,
  ): Promise<void> {
    this.transactions.set(transaction.stateDigest, transaction);
  }

  public async consumeLoginTransaction(
    stateDigest: string,
    _now: string,
  ): Promise<LoginTransaction | undefined> {
    const transaction = this.transactions.get(stateDigest);
    this.transactions.delete(stateDigest);
    return transaction;
  }

  public async createSession(session: ServerSession): Promise<void> {
    this.sessions.set(session.sessionDigest, session);
  }

  public async findActiveSession(
    sessionDigest: string,
    now: string,
  ): Promise<ServerSession | undefined> {
    const session = this.sessions.get(sessionDigest);
    return session !== undefined && new Date(session.expiresAt) > new Date(now)
      ? session
      : undefined;
  }

  public async revokeSession(
    sessionDigest: string,
    _now: string,
  ): Promise<void> {
    this.sessions.delete(sessionDigest);
  }

  public async rotateSession(
    input: Readonly<{
      readonly previousSessionDigest: string;
      readonly replacement: ServerSession;
      readonly now: string;
    }>,
  ): Promise<boolean> {
    if (
      !(await this.findActiveSession(input.previousSessionDigest, input.now))
    ) {
      return false;
    }
    this.sessions.delete(input.previousSessionDigest);
    this.sessions.set(input.replacement.sessionDigest, input.replacement);
    return true;
  }
}

/** Test-only atomic collaborator: state and the append-only plan commit together
 * in the deterministic in-memory fixture, mirroring the production PostgreSQL
 * transaction without exposing it to tests as an alternate application path. */
class MemorySessionAuditMutationStore implements AuthSessionAuditMutationStore {
  public constructor(
    private readonly sessions: MemorySessionStore,
    private readonly plans: AuthAuditPlan[],
  ) {}

  public async createSessionAndRecord(input: {
    readonly session: ServerSession;
    readonly audit: AuthAuditPlan;
  }): Promise<void> {
    await this.sessions.createSession(input.session);
    this.plans.push(input.audit);
  }

  public async revokeSessionAndRecord(input: {
    readonly sessionDigest: string;
    readonly now: string;
    readonly audit: AuthAuditPlan;
  }): Promise<boolean> {
    const active = await this.sessions.findActiveSession(
      input.sessionDigest,
      input.now,
    );
    if (active === undefined) return false;
    await this.sessions.revokeSession(input.sessionDigest, input.now);
    this.plans.push(input.audit);
    return true;
  }

  public async rotateSessionAndRecord(input: {
    readonly previousSessionDigest: string;
    readonly replacement: ServerSession;
    readonly now: string;
    readonly audit: AuthAuditPlan;
  }): Promise<boolean> {
    const rotated = await this.sessions.rotateSession({
      previousSessionDigest: input.previousSessionDigest,
      replacement: input.replacement,
      now: input.now,
    });
    if (!rotated) return false;
    this.plans.push(input.audit);
    return true;
  }
}

class TestProtector implements EphemeralSecretProtector {
  public async seal(
    plaintext: string,
    purpose: "oidc-nonce" | "oidc-pkce-verifier" | "session-csrf",
  ): Promise<SealedEphemeralValue> {
    return { keyId: "test-key", ciphertext: `${purpose}.${plaintext}` };
  }

  public async open(
    value: SealedEphemeralValue,
    purpose: "oidc-nonce" | "oidc-pkce-verifier" | "session-csrf",
  ): Promise<string> {
    const prefix = `${purpose}.`;
    if (value.keyId !== "test-key" || !value.ciphertext.startsWith(prefix)) {
      throw new Error("invalid sealed value");
    }
    return value.ciphertext.slice(prefix.length);
  }
}

const mappings: readonly OidcIdentityMapping[] = [
  {
    id: "mapping-a",
    workspaceId: "workspace-a",
    principalId: "principal-a",
    issuer: "https://issuer.example.test",
    subject: "operator-subject",
    displayName: "Operator",
  },
  {
    id: "mapping-b",
    workspaceId: "workspace-b",
    principalId: "principal-b",
    issuer: "https://issuer.example.test",
    subject: "operator-subject",
    displayName: "Operator",
  },
];

function mappingStore(): OidcIdentityMappingStore {
  return {
    findByExternalIdentity: async ({ issuer, subject }) =>
      issuer === "https://issuer.example.test" && subject === "operator-subject"
        ? mappings
        : [],
    findByWorkspacePrincipal: async ({ workspaceId, principalId }) =>
      mappings.find(
        (mapping) =>
          mapping.workspaceId === workspaceId &&
          mapping.principalId === principalId,
      ),
  };
}

export const oidcFixtureConfig: Omit<ApiConfig, "allowedAdminOrigins"> = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  databaseUrl: "postgresql://localhost/caseweaver_test",
  workspaceId: "workspace-a",
  principalId: "principal-a",
  databaseReadinessTimeoutMs: 500,
  trustedProxyCidrs: [],
};

export interface OidcAdministrationApiFixture {
  readonly app: ApiInstance;
  readonly auditPlans: AuthAuditPlan[];
  /** Captures only the safe draft payload accepted by the real HTTP boundary. */
  readonly drafts: readonly Readonly<{
    readonly descriptorType: string;
    readonly displayName: string;
    readonly settings: Readonly<Record<string, unknown>>;
  }>[];
  readonly oidc: OidcAuthorizationCodeClient;
  /** The test issuer can send the browser through the existing callback route. */
  setCallbackOrigin(origin: string): void;
}

/**
 * Test-only composition for deterministic API and browser flows. It uses the
 * real Fastify route tree, administration operations, session state machine,
 * and cookie/CSRF behavior; only OIDC, persistence, and audit durability are
 * deterministic in-memory collaborators.
 */
export function createOidcAdministrationApiFixture(
  input: Readonly<{
    readonly allowedAdminOrigins: readonly string[];
  }>,
): OidcAdministrationApiFixture {
  const sessions = new MemorySessionStore();
  const auditPlans: AuthAuditPlan[] = [];
  const drafts: Array<
    Readonly<{
      readonly descriptorType: string;
      readonly displayName: string;
      readonly settings: Readonly<Record<string, unknown>>;
    }>
  > = [];
  const sessionAuditMutations = new MemorySessionAuditMutationStore(
    sessions,
    auditPlans,
  );
  let callbackOrigin: string | undefined;
  const oidc = {
    authorizationUrl: async (request) => {
      const url = new URL(
        callbackOrigin === undefined
          ? "https://issuer.example.test/authorize"
          : "/v1/auth/callback",
        callbackOrigin,
      );
      url.searchParams.set("code", "authorization-code-for-test");
      url.searchParams.set("state", request.state);
      url.searchParams.set("nonce", request.nonce);
      url.searchParams.set("code_challenge", request.codeChallenge);
      return url;
    },
    exchangeAndValidate: async ({ code, nonce, verifier }) => {
      if (
        code !== "authorization-code-for-test" ||
        nonce.length < 20 ||
        verifier.length < 20
      ) {
        throw new Error("OIDC exchange rejected");
      }
      return {
        issuer: "https://issuer.example.test",
        subject: "operator-subject",
        displayName: "Operator",
        expiresAt: "2030-01-02T00:00:00.000Z",
      };
    },
  } satisfies OidcAuthorizationCodeClient;
  const dependencies: AuthSessionServiceDependencies = {
    oidc,
    sessions,
    sessionAuditMutations,
    mappings: mappingStore(),
    protector: new TestProtector(),
    ids: {
      next: (scope) =>
        `${scope}-${sessions.transactions.size + sessions.sessions.size + 1}`,
    },
    workspaceName: async (workspaceId) =>
      workspaceId === "workspace-a"
        ? "Operations"
        : workspaceId === "workspace-b"
          ? "Research"
          : undefined,
    permissionsFor: async () => [
      "configuration.read" as Permission,
      "configuration.manage" as Permission,
      "credential.readMetadata" as Permission,
    ],
    now: () => new Date("2030-01-01T00:00:00.000Z"),
    secureCookies: false,
    allowedOrigins: input.allowedAdminOrigins,
  };
  const authAudits: AuthAuditRecorder = {
    record: async (plan) => {
      auditPlans.push(plan);
    },
  };
  const config: ApiConfig = {
    ...oidcFixtureConfig,
    allowedAdminOrigins: input.allowedAdminOrigins,
  };
  const syntheticConnector = Object.freeze({
    kind: "connector",
    type: "fixture-source",
    version: "1",
    displayName: "Fixture source",
    description: "A backend-only test connector descriptor.",
    connectorCapabilities: ["knowledgeSource"] as const,
    aiCapabilities: [] as const,
    supportedWireApis: [] as const,
    supportedWebhookEventTypes: [] as const,
    settingsSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", title: "Endpoint", format: "uri" },
      },
      required: ["endpoint"] as const,
      additionalProperties: false,
    },
    uiGroups: [
      {
        id: "connection",
        title: "Connection",
        fields: ["endpoint"],
        advanced: false,
      },
    ],
    secretSlots: [] as const,
    supportsConfigurationMigration: false,
    supportedTestOperations: [] as const,
  } as const satisfies ConfigurationDescriptor);
  const operations = new AdministrationApiOperations({
    auth: new AuthSessionService(dependencies),
    reads: {} as never,
    resources: {
      list: async () => ({ items: [], page: { hasNextPage: false } }),
    } as never,
    descriptors: {
      list: async () => [syntheticConnector],
    } as never,
    unitOfWork: {
      transaction: async (operation: (transaction: object) => unknown) =>
        operation(Object.freeze({})),
    } as never,
    auditStore: { append: async () => undefined } as never,
    authAudits,
    auditWorkspaceId: "workspace-a",
    createDraft: async (input) => {
      drafts.push(
        Object.freeze({
          descriptorType: input.descriptorType,
          displayName: input.displayName,
          settings: Object.freeze({ ...input.settings }),
        }),
      );
      return { id: `draft-${drafts.length}`, revision: 1 };
    },
    createSecretReference: async () => ({ id: "unused", lifecycle: "active" }),
    createKnowledgeSourceDraft: async () => ({
      id: "unused-source",
      revision: 1,
    }),
    createKnowledgeScheduleDraft: async () => ({
      id: "unused-schedule",
      revision: 1,
    }),
    transitionKnowledgeSource: async () => ({
      revision: 1,
      lifecycle: "enabled",
    }),
    transitionKnowledgeSchedule: async () => ({
      revision: 1,
      lifecycle: "enabled",
    }),
    replaceWorkspacePrincipalRoles: {
      execute: async () => ({
        assignment: {
          workspaceId: "workspace-a",
          principalId: "principal-a",
          roles: ["administrator" as const],
          revision: 1,
        },
        previousRoles: ["administrator" as const],
        idempotency: "created" as const,
      }),
    },
    workspaceRoleAssignments: {
      read: async () => ({
        workspaceId: "workspace-a",
        principalId: "principal-a",
        roles: ["administrator" as const],
        revision: 1,
      }),
    },
  });
  return {
    app: buildApi({
      config,
      logger: createLogger(config),
      readinessProbe: { check: async () => "ready" },
      administration: operations,
    }),
    auditPlans,
    drafts,
    oidc,
    setCallbackOrigin: (origin) => {
      callbackOrigin = origin;
    },
  };
}
