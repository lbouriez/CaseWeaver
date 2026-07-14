import { z } from "zod";

const titleSchema = z.string().trim().min(1).max(120);

const apiBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, context) => {
    try {
      return new URL(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "API base URL must be an absolute URL.",
      });
      return z.NEVER;
    }
  })
  .refine(
    (value) =>
      value.protocol === "https:" ||
      (value.protocol === "http:" && isLocalDevelopmentHost(value.hostname)),
    "API base URL must use HTTPS except for localhost development.",
  )
  .refine(
    (value) => value.username === "" && value.password === "",
    "API base URL must not contain credentials.",
  )
  .refine(
    (value) => value.search === "" && value.hash === "",
    "API base URL must not contain a query string or fragment.",
  )
  .transform((value) => value.href.replace(/\/$/u, ""));

const runtimeConfigSchema = z
  .object({
    apiBaseUrl: apiBaseUrlSchema,
    uiTitle: titleSchema,
  })
  .strict();

export interface RuntimeConfig {
  readonly apiBaseUrl: string;
  readonly uiTitle: string;
}

export class RuntimeConfigurationError extends Error {
  public constructor() {
    super(
      "Operator console configuration is unavailable or invalid. Ask a platform administrator to provide runtime-config.json.",
    );
    this.name = "RuntimeConfigurationError";
  }
}

export type RuntimeConfigFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function isLocalDevelopmentHost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  const parsed = runtimeConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeConfigurationError();
  }

  return Object.freeze(parsed.data);
}

export async function loadRuntimeConfig(
  fetchRuntimeConfig: RuntimeConfigFetch = fetch,
  configUrl = new URL("/runtime-config.json", window.location.origin),
): Promise<RuntimeConfig> {
  let response: Response;
  try {
    response = await fetchRuntimeConfig(configUrl, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new RuntimeConfigurationError();
  }

  if (!response.ok) {
    throw new RuntimeConfigurationError();
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new RuntimeConfigurationError();
  }

  return parseRuntimeConfig(payload);
}
