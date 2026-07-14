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
import type { ApiExecutionContextResolver } from "./modules/pbi-012/routes.js";

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
