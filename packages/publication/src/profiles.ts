import { z } from "zod";

const identifier = z.string().min(1).max(200);

export const publicationModeSchema = z.enum([
  "previewOnly",
  "approvalRequired",
  "autoPublishInternal",
]);

export const publicationVisibilitySchema = z.literal("internal", {
  error: "Customer-visible publication is not available.",
});

export const publicationPolicySchema = z
  .object({
    mode: publicationModeSchema,
    visibility: publicationVisibilitySchema,
  })
  .strict();

export const publicationRendererSchema = z
  .object({
    id: identifier,
    version: identifier,
    format: z.enum(["plainText", "markdown", "html"]),
  })
  .strict();

export const publicationNoticesSchema = z
  .object({
    aiDisclosure: z.string().min(1).max(4_000).optional(),
    disclaimers: z.array(z.string().min(1).max(4_000)).max(20),
  })
  .strict();

export const publicationProfileSchema = z
  .object({
    id: identifier,
    version: identifier,
    destination: z
      .object({
        connectorInstanceId: identifier,
      })
      .strict(),
    renderer: publicationRendererSchema,
    notices: publicationNoticesSchema,
    policy: publicationPolicySchema,
    limits: z
      .object({
        maximumBodyCharacters: z.number().int().positive().max(1_000_000),
      })
      .strict(),
  })
  .strict();

export type PublicationMode = z.infer<typeof publicationModeSchema>;
export type PublicationPolicy = z.infer<typeof publicationPolicySchema>;
export type PublicationRendererProfile = z.infer<
  typeof publicationRendererSchema
>;
export type PublicationNotices = z.infer<typeof publicationNoticesSchema>;
export type PublicationProfile = z.infer<typeof publicationProfileSchema>;
