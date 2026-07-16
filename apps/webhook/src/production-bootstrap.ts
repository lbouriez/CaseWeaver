import { createPostgresPersistence } from "@caseweaver/postgres";
import { WebhookIngress } from "@caseweaver/webhooks";

import { buildWebhookApp } from "./app.js";
import {
  PersistedWebhookEndpointResolver,
  type WebhookAdapterResolver,
} from "./persisted-endpoint-resolver.js";
import { createWebhookRuntime, type WebhookRuntime } from "./runtime.js";

export interface WebhookRuntimeConfiguration {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly maximumBodyBytes: number;
}

export class WebhookConfigurationError extends Error {
  public readonly code = "webhook.invalidConfiguration";
  public readonly retryable = false;

  public constructor() {
    super("Webhook configuration is invalid.");
    this.name = "WebhookConfigurationError";
  }
}

export function loadWebhookRuntimeConfiguration(
  environment: NodeJS.ProcessEnv,
): WebhookRuntimeConfiguration {
  const databaseUrl = environment.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new WebhookConfigurationError();
  }
  const host = environment.WEBHOOK_HOST ?? "0.0.0.0";
  if (host.length < 1 || host.length > 255 || /[\r\n\0]/u.test(host)) {
    throw new WebhookConfigurationError();
  }
  return Object.freeze({
    databaseUrl,
    host,
    port: boundedInteger(environment.WEBHOOK_PORT, 8081, 1, 65_535),
    maximumBodyBytes: boundedInteger(
      environment.WEBHOOK_MAXIMUM_BODY_BYTES,
      1_048_576,
      1,
      10 * 1024 * 1024,
    ),
  });
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new WebhookConfigurationError();
  }
  return parsed;
}

/**
 * A deployment registers executable webhook adapters here. No currently
 * supported connector declares that capability, so the default is an explicit
 * empty registry: active records remain opaque 404s instead of attempting a
 * mutable connector lookup or accepting unsigned content.
 */
export function createEmptyWebhookAdapterResolver(): WebhookAdapterResolver {
  return Object.freeze({ resolve: async () => undefined });
}

/** Builds public ingress from persisted opaque endpoint state and closes its DB client on stop. */
export async function createWebhookRuntimeFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  adapters: WebhookAdapterResolver = createEmptyWebhookAdapterResolver(),
): Promise<WebhookRuntime> {
  const configuration = loadWebhookRuntimeConfiguration(environment);
  const persistence = createPostgresPersistence({
    databaseUrl: configuration.databaseUrl,
  });
  const ingress = new WebhookIngress({
    store: persistence.verifiedWebhookEventStore,
    clock: { now: () => new Date().toISOString() },
  });
  const app = buildWebhookApp({
    ingress,
    endpointResolver: new PersistedWebhookEndpointResolver(
      persistence.webhookEndpointRuntimeStore,
      persistence.webhookEndpointRuntimeStore,
      adapters,
    ),
    maximumBodyBytes: configuration.maximumBodyBytes,
    readinessProbe: {
      async check() {
        try {
          await persistence.unitOfWork.transaction(async () => undefined);
          return "ready";
        } catch {
          return "unavailable";
        }
      },
    },
  });
  const runtime = createWebhookRuntime({
    app,
    host: configuration.host,
    port: configuration.port,
  });
  let closed = false;
  return Object.freeze({
    start: () => runtime.start(),
    async stop(): Promise<void> {
      const failures: unknown[] = [];
      try {
        await runtime.stop();
      } catch (error) {
        failures.push(error);
      }
      if (!closed) {
        closed = true;
        try {
          await persistence.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Webhook shutdown failed.");
      }
    },
  });
}
