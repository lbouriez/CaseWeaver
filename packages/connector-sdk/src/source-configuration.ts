import { z } from "zod";

import {
  connectorInstanceIdSchema,
  versionedOpaqueValueSchema,
} from "./primitives.js";

const durationMsSchema = z.number().int().positive().max(86_400_000);

const syncTriggerSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("manual") }).strict(),
  z
    .object({
      mode: z.literal("cron"),
      expression: z.string().min(1).max(500),
      timezone: z.string().min(1).max(100),
      jitterMs: z.number().int().nonnegative().optional(),
      overlapPolicy: z.enum(["skip", "queue"]),
      maximumDurationMs: durationMsSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("interval"),
      intervalMs: durationMsSchema,
      jitterMs: z.number().int().nonnegative().optional(),
      overlapPolicy: z.enum(["skip", "queue"]),
      maximumDurationMs: durationMsSchema,
    })
    .strict(),
  z.object({ mode: z.literal("webhook") }).strict(),
]);

export const knowledgeSourceConfigurationSchema = z
  .object({
    schemaVersion: z.literal(1),
    connectorInstanceId: connectorInstanceIdSchema,
    capability: z.literal("knowledgeSource"),
    enabled: z.boolean(),
    knowledgeCollectionId: z.string().min(1).max(200),
    normalizationProfileVersion: z.string().min(1).max(200),
    chunkingProfileVersion: z.string().min(1).max(200),
    synchronization: z
      .object({
        triggers: z.array(syncTriggerSchema).min(1),
        incrementalCursor: versionedOpaqueValueSchema.optional(),
        periodicFullRescanIntervalMs: durationMsSchema.optional(),
      })
      .strict(),
    deletion: z
      .object({
        behavior: z.enum(["tombstone", "retain"]),
        retentionDays: z.number().int().positive().max(36_500).optional(),
      })
      .strict(),
  })
  .strict();

export type KnowledgeSourceConfiguration = z.infer<
  typeof knowledgeSourceConfigurationSchema
>;

/**
 * Source filters remain connector-owned but must be validated by the supplied schema.
 */
export function createKnowledgeSourceConfigurationSchema<
  TFilters extends z.ZodType,
>(filtersSchema: TFilters) {
  return knowledgeSourceConfigurationSchema.extend({
    filters: filtersSchema,
  });
}
