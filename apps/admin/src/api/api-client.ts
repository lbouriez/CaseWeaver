import type { RuntimeConfig } from "../runtime-config.js";
import {
  type ActionOutcome,
  type ActionPreview,
  type AdminActionName,
  type AdminDetail,
  type AdminListResponse,
  type AdminResourceName,
  actionOutcomeSchema,
  actionPreviewSchema,
  adminDetailSchema,
  adminListResponseSchema,
  type ConfigurationDescriptor,
  descriptorCatalogSchema,
  type PublicApiErrorBody,
  publicApiErrorBodySchema,
  resourceEndpoints,
  type Session,
  sessionSchema,
} from "./contracts.js";

export type UiActionMode = "user" | "passive_poll";

export interface ApiClientOptions {
  readonly fetchImplementation?: typeof fetch;
  readonly createActionId?: () => string;
}

export interface ListQuery {
  readonly limit?: number;
  readonly after?: string;
  readonly sort?: string;
  readonly direction?: "ASC" | "DESC";
  readonly filter?: Readonly<Record<string, string | number | boolean>>;
}

export interface DescriptorDraftInput {
  readonly descriptorType: string;
  readonly displayName: string;
  readonly settings: Readonly<Record<string, unknown>>;
}

export type ApiFailureKind =
  | "unauthenticated"
  | "denied"
  | "invalid"
  | "conflict"
  | "unavailable"
  | "cancelled"
  | "failed";

export class PublicApiError extends Error {
  public readonly kind: ApiFailureKind;
  public readonly status?: number;
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly requestId?: string;
  public readonly correlationId?: string;
  public readonly retryAfterSeconds?: number;

  public constructor(
    kind: ApiFailureKind,
    code: string,
    message: string,
    options: {
      readonly status?: number;
      readonly retryable?: boolean;
      readonly requestId?: string;
      readonly correlationId?: string;
      readonly retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    this.name = "PublicApiError";
    this.kind = kind;
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
    this.correlationId = options.correlationId;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

function createBrowserActionId(): string {
  return crypto.randomUUID();
}

function classifyStatus(status: number): ApiFailureKind {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "denied";
  if (status === 409 || status === 412) return "conflict";
  if (status === 400 || status === 422) return "invalid";
  if (status === 404 || status === 429 || status >= 500) return "unavailable";
  return "failed";
}

function genericFailure(status?: number): PublicApiError {
  return new PublicApiError(
    status === undefined ? "unavailable" : classifyStatus(status),
    status === undefined ? "network.unavailable" : "request.failed",
    status === undefined
      ? "The control-plane API is unavailable. No local data is being shown."
      : "The control-plane API could not complete this request.",
    { status, retryable: status === undefined || status >= 500 },
  );
}

function parsePublicError(status: number, value: unknown): PublicApiError {
  const parsed = publicApiErrorBodySchema.safeParse(value);
  if (!parsed.success) return genericFailure(status);

  const body: PublicApiErrorBody = parsed.data;
  return new PublicApiError(
    classifyStatus(status),
    body.code,
    body.message ?? "The control-plane API rejected this request.",
    {
      status,
      retryable: body.retryable,
      requestId: body.requestId,
      correlationId: body.correlationId,
      retryAfterSeconds: body.retryAfterSeconds,
    },
  );
}

function safelyEncodeIdentifier(identifier: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(identifier)) {
    throw new PublicApiError(
      "invalid",
      "client.invalidIdentifier",
      "The selected resource identifier is invalid.",
    );
  }
  return encodeURIComponent(identifier);
}

function validateIdentifier(identifier: string): string {
  safelyEncodeIdentifier(identifier);
  return identifier;
}

export class CaseWeaverApiClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly createActionId: () => string;
  private csrfToken: string | undefined;

  public constructor(
    private readonly config: RuntimeConfig,
    options: ApiClientOptions = {},
  ) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.createActionId = options.createActionId ?? createBrowserActionId;
  }

  public async session(signal?: AbortSignal): Promise<Session> {
    const session = await this.requestJson(
      "/v1/auth/session",
      { method: "GET", signal },
      sessionSchema,
      "user",
    );
    this.csrfToken = session.authenticated ? session.csrfToken : undefined;
    return session;
  }

  public loginUrl(returnTo: string): URL {
    const url = this.endpointUrl("/v1/auth/login");
    url.searchParams.set("returnTo", returnTo);
    return url;
  }

  public async logout(signal?: AbortSignal): Promise<void> {
    await this.requestJson(
      "/v1/auth/logout",
      { method: "POST", signal },
      undefined,
      "user",
    );
    this.csrfToken = undefined;
  }

  public async switchWorkspace(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<Session> {
    const session = await this.requestJson(
      "/v1/auth/session/workspace",
      {
        method: "POST",
        signal,
        body: JSON.stringify({ workspaceId: validateIdentifier(workspaceId) }),
      },
      sessionSchema,
      "user",
    );
    this.csrfToken = session.authenticated ? session.csrfToken : undefined;
    return session;
  }

  public async list(
    resource: AdminResourceName,
    query: ListQuery = {},
    options: {
      readonly signal?: AbortSignal;
      readonly mode?: UiActionMode;
    } = {},
  ): Promise<AdminListResponse> {
    const endpoint = this.listEndpoint(resource, query);
    return this.requestJson(
      endpoint,
      { method: "GET", signal: options.signal },
      adminListResponseSchema,
      options.mode ?? "user",
    );
  }

  public async get(
    resource: AdminResourceName,
    id: string,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    const route = resourceEndpoints[resource].detail;
    if (route === undefined) {
      throw new PublicApiError(
        "unavailable",
        "resource.readUnavailable",
        "This operational view is available only as a summary.",
      );
    }
    return this.requestJson(
      `${route}/${safelyEncodeIdentifier(id)}`,
      { method: "GET", signal },
      adminDetailSchema,
      "user",
    );
  }

  public async listDescriptors(
    kind: ConfigurationDescriptor["kind"],
    signal?: AbortSignal,
  ): Promise<readonly ConfigurationDescriptor[]> {
    const endpoint =
      kind === "connector"
        ? "/v1/admin/descriptors/connectors"
        : "/v1/admin/descriptors/ai-providers";
    const result = await this.requestJson(
      endpoint,
      { method: "GET", signal },
      descriptorCatalogSchema,
      "user",
    );
    return result.items.filter((descriptor) => descriptor.kind === kind);
  }

  public async createDescriptorDraft(
    kind: ConfigurationDescriptor["kind"],
    input: DescriptorDraftInput,
    signal?: AbortSignal,
  ): Promise<AdminDetail> {
    const endpoint =
      kind === "connector"
        ? "/v1/admin/connector-instances/drafts"
        : "/v1/admin/ai/provider-instances/drafts";
    return this.requestJson(
      endpoint,
      {
        method: "POST",
        signal,
        body: JSON.stringify(input),
      },
      adminDetailSchema,
      "user",
    );
  }

  public async previewAction(
    action: AdminActionName,
    target: { readonly resource: AdminResourceName; readonly id?: string },
    signal?: AbortSignal,
  ): Promise<ActionPreview> {
    return this.requestJson(
      "/v1/admin/action-previews",
      {
        method: "POST",
        signal,
        body: JSON.stringify({
          action,
          target: {
            resource: target.resource,
            ...(target.id === undefined
              ? {}
              : { id: safelyEncodeIdentifier(target.id) }),
          },
        }),
      },
      actionPreviewSchema,
      "user",
    );
  }

  public async executeAction(
    previewId: string,
    signal?: AbortSignal,
  ): Promise<ActionOutcome> {
    return this.requestJson(
      "/v1/admin/actions/execute",
      {
        method: "POST",
        signal,
        body: JSON.stringify({ previewId: safelyEncodeIdentifier(previewId) }),
      },
      actionOutcomeSchema,
      "user",
    );
  }

  private endpointUrl(endpoint: string): URL {
    return new URL(endpoint.replace(/^\//u, ""), `${this.config.apiBaseUrl}/`);
  }

  private listEndpoint(resource: AdminResourceName, query: ListQuery): string {
    const url = new URL(
      resourceEndpoints[resource].list,
      "https://endpoint.invalid",
    );
    if (query.limit !== undefined)
      url.searchParams.set("limit", String(query.limit));
    if (query.after !== undefined) url.searchParams.set("after", query.after);
    if (query.sort !== undefined) url.searchParams.set("sort", query.sort);
    if (query.direction !== undefined)
      url.searchParams.set("direction", query.direction);
    if (query.filter !== undefined) {
      for (const [key, value] of Object.entries(query.filter)) {
        url.searchParams.set(`filter.${key}`, String(value));
      }
    }
    return `${url.pathname}${url.search}`;
  }

  private async requestJson<T>(
    endpoint: string,
    init: RequestInit,
    schema:
      | {
          readonly safeParse: (
            value: unknown,
          ) => { success: true; data: T } | { success: false };
        }
      | undefined,
    mode: UiActionMode,
  ): Promise<T> {
    const actionId = this.createActionId();
    const isMutation = init.method !== undefined && init.method !== "GET";
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("X-CaseWeaver-UI-Action-ID", actionId);
    headers.set("X-CaseWeaver-Correlation-ID", actionId);
    headers.set("X-CaseWeaver-Request-Mode", mode);
    if (isMutation) {
      headers.set("Content-Type", "application/json");
      headers.set("Idempotency-Key", actionId);
      if (this.csrfToken !== undefined)
        headers.set("X-CSRF-Token", this.csrfToken);
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(this.endpointUrl(endpoint), {
        ...init,
        headers,
        credentials: "include",
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new PublicApiError(
          "cancelled",
          "request.cancelled",
          "The request was cancelled.",
        );
      }
      throw genericFailure();
    }

    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      throw parsePublicError(response.status, payload);
    }

    if (schema === undefined) {
      return undefined as T;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PublicApiError(
        "failed",
        "response.invalid",
        "The control-plane API returned an invalid response.",
        { status: response.status },
      );
    }

    const result = schema.safeParse(payload);
    if (!result.success) {
      throw new PublicApiError(
        "failed",
        "response.invalid",
        "The control-plane API returned an invalid response.",
        { status: response.status },
      );
    }
    return result.data;
  }
}
