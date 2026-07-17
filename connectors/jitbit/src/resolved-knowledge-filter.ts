import { z } from "zod";

/**
 * Connector-owned source filter projected by the administration/source runtime.
 * It deliberately is not connector-instance configuration: two Jitbit knowledge
 * sources may legitimately retain different historical-case eligibility policies.
 */
export const jitbitResolvedKnowledgeFilterSchema = z
  .object({
    resolvedOrClosedOnly: z.boolean().default(true),
  })
  .strict();

export type JitbitResolvedKnowledgeFilter = z.infer<
  typeof jitbitResolvedKnowledgeFilterSchema
>;

export const defaultJitbitResolvedKnowledgeFilter: JitbitResolvedKnowledgeFilter =
  Object.freeze({ resolvedOrClosedOnly: true });

export function parseJitbitResolvedKnowledgeFilter(
  value: JitbitResolvedKnowledgeFilter | undefined,
): JitbitResolvedKnowledgeFilter {
  return value === undefined
    ? defaultJitbitResolvedKnowledgeFilter
    : jitbitResolvedKnowledgeFilterSchema.parse(value);
}
