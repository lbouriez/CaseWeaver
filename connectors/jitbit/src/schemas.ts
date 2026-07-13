import { z } from "zod";

const stringOrNumberSchema = z
  .union([z.string().min(1), z.number().int().nonnegative()])
  .transform((value) => String(value));

const optionalStringSchema = z.string().max(1_000_000).optional();

const attachmentSchema = z
  .object({
    FileID: stringOrNumberSchema.optional(),
    Id: stringOrNumberSchema.optional(),
    FileName: z.string().max(1_024).optional(),
    ContentType: z.string().max(255).optional(),
    ContentLength: z.number().int().nonnegative().optional(),
    Size: z.number().int().nonnegative().optional(),
  })
  .passthrough()
  .transform((attachment, context) => {
    const id = attachment.FileID ?? attachment.Id;
    if (id === undefined) {
      context.addIssue({
        code: "custom",
        message: "Jitbit attachment metadata requires a file ID.",
      });
      return z.NEVER;
    }
    return {
      id,
      fileName: attachment.FileName,
      mediaType: attachment.ContentType,
      contentLength: attachment.ContentLength ?? attachment.Size,
    };
  });

export const jitbitTicketSummarySchema = z
  .object({
    IssueID: stringOrNumberSchema,
    Status: z.string().max(200).optional(),
    LastUpdated: z.string().max(200).optional(),
    IssueDate: z.string().max(200).optional(),
    Subject: z.string().max(10_000).optional(),
  })
  .passthrough();

export const jitbitTicketSummariesSchema = z.array(jitbitTicketSummarySchema);

export const jitbitTicketSchema = z
  .object({
    IssueID: stringOrNumberSchema,
    Status: z.string().max(200).optional(),
    Subject: optionalStringSchema,
    Body: optionalStringSchema,
    LastUpdated: z.string().max(200).optional(),
    IssueDate: z.string().max(200).optional(),
    ResolvedDate: z.string().max(200).optional(),
    ClosedDate: z.string().max(200).optional(),
    UserID: stringOrNumberSchema.optional(),
    UserName: z.string().max(1_000).optional(),
    TechID: stringOrNumberSchema.optional(),
    TechName: z.string().max(1_000).optional(),
    Priority: z.string().max(100).optional(),
    Category: z.string().max(1_000).optional(),
    Tags: z.union([z.string(), z.array(z.string().max(1_000))]).optional(),
    Resolution: optionalStringSchema,
    ResolutionText: optionalStringSchema,
    Attachments: z.array(attachmentSchema).default([]),
  })
  .passthrough();

export const jitbitCommentSchema = z
  .object({
    CommentID: stringOrNumberSchema,
    Body: optionalStringSchema,
    CommentDate: z.string().max(200).optional(),
    UserID: stringOrNumberSchema.optional(),
    UserName: z.string().max(1_000).optional(),
    IsSystem: z.boolean().optional().default(false),
    ForTechsOnly: z.boolean().optional().default(false),
    Attachments: z.array(attachmentSchema).default([]),
  })
  .passthrough();

export const jitbitCommentsSchema = z.array(jitbitCommentSchema);

export const jitbitPostCommentResponseSchema = z.union([
  stringOrNumberSchema,
  z
    .object({
      CommentID: stringOrNumberSchema.optional(),
      Id: stringOrNumberSchema.optional(),
    })
    .passthrough()
    .transform((value, context) => {
      const id = value.CommentID ?? value.Id;
      if (id === undefined) {
        context.addIssue({
          code: "custom",
          message: "Jitbit comment response requires a comment ID.",
        });
        return z.NEVER;
      }
      return id;
    }),
]);

export type JitbitTicketSummary = z.infer<typeof jitbitTicketSummarySchema>;
export type JitbitTicket = z.infer<typeof jitbitTicketSchema>;
export type JitbitComment = z.infer<typeof jitbitCommentSchema>;
