import {
  type ConnectorConfiguration,
  createConnectorConfigurationSchema,
} from "@caseweaver/connector-sdk";
import { z } from "zod";

const utcDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Date must use YYYY-MM-DD.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), {
    message: "Date must be a valid UTC calendar date.",
  });

const httpsBaseUrlSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "Jitbit base URLs must use HTTPS.",
      });
    }
    if (url.username.length > 0 || url.password.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Jitbit base URLs must not contain credentials.",
      });
    }
    if (url.search.length > 0 || url.hash.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Jitbit base URLs must not contain a query or fragment.",
      });
    }
  })
  .transform((value) => value.replace(/\/+$/u, ""));

export const jitbitSettingsSchema = z
  .object({
    connectorInstanceId: z.string().min(1).max(200),
    baseUrl: httpsBaseUrlSchema,
    apiTokenSecretName: z.string().min(1).max(100).default("apiToken"),
    requestTimeoutMs: z.number().int().min(100).max(120_000).default(30_000),
    discoveryPageSize: z.number().int().min(1).max(300).default(100),
    maximumTicketCharacters: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .default(1_000_000),
    /**
     * An optional initial lower bound. Subsequent cursors are host-persisted and
     * replay this date with a conservative overlap.
     */
    initialUpdatedFrom: utcDateSchema.optional(),
    updatedFromOverlapDays: z.number().int().min(1).max(31).default(1),
  })
  .strict();

const configurationSchema = createConnectorConfigurationSchema(
  jitbitSettingsSchema,
).extend({
  connectorType: z.literal("jitbit"),
});

export const jitbitConfigurationSchema = configurationSchema.superRefine(
  (configuration, context) => {
    const secretName = configuration.settings.apiTokenSecretName;
    if (configuration.secrets[secretName] === undefined) {
      context.addIssue({
        code: "custom",
        path: ["secrets", secretName],
        message:
          "The configured Jitbit API token secret reference is required.",
      });
    }
  },
);

export type JitbitSettings = z.infer<typeof jitbitSettingsSchema>;
export type JitbitConfiguration = z.infer<typeof jitbitConfigurationSchema>;
export type JitbitConfigurationEnvelope =
  ConnectorConfiguration<JitbitSettings>;
