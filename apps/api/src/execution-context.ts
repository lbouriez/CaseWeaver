import { randomUUID } from "node:crypto";

import type { ExecutionContext } from "@caseweaver/application";
import {
  correlationId,
  principalId,
  requestId,
  workspaceId,
} from "@caseweaver/domain";
import { captureOpenTelemetryTraceContext } from "@caseweaver/observability";

import type { ApiConfig } from "./config.js";

export interface ApiExecutionContextResolver {
  /**
   * Authentication is composed outside feature routes. Route headers and bodies are
   * never converted to a principal by a feature module.
   */
  resolve(request: unknown): Promise<ExecutionContext>;
}

/**
 * The deployment supplies this actor after authenticating callers upstream.
 * Request headers are deliberately not accepted as identity claims.
 */
export class ConfiguredApiExecutionContextResolver
  implements ApiExecutionContextResolver
{
  private readonly workspaceId: ExecutionContext["workspaceId"];
  private readonly principalId: ExecutionContext["principalId"];

  public constructor(config: ApiConfig) {
    this.workspaceId = workspaceId(config.workspaceId);
    this.principalId = principalId(config.principalId);
  }

  public async resolve(_request: unknown): Promise<ExecutionContext> {
    const id = randomUUID();
    const traceContext = captureOpenTelemetryTraceContext();
    return Object.freeze({
      requestId: requestId(`api-request:${id}`),
      workspaceId: this.workspaceId,
      principalId: this.principalId,
      correlationId: correlationId(`api-correlation:${id}`),
      ...(traceContext === undefined ? {} : { traceContext }),
      signal: new AbortController().signal,
    });
  }
}
