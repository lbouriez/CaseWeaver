import {
  ConnectorCancelledError,
  ConnectorProtocolError,
} from "@caseweaver/connector-sdk";
import { z } from "zod";

import type { GitMarkdownSettings } from "./config.js";

export const gitObjectIdSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, "Expected a Git object ID.");

export const repositoryPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      !path.split("/").includes("..") &&
      !path.split("/").includes("."),
    "Repository paths must be safe, relative POSIX paths.",
  );

const gitRepositoryFileEntrySchema = z
  .object({
    path: repositoryPathSchema,
    blobOid: gitObjectIdSchema,
  })
  .strict();

const gitRepositorySnapshotSchema = z
  .object({
    commitSha: gitObjectIdSchema,
    files: z.array(gitRepositoryFileEntrySchema).max(100_000),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const paths = new Set<string>();
    for (const [index, file] of snapshot.files.entries()) {
      if (paths.has(file.path)) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: "A Git snapshot must not contain duplicate paths.",
        });
      }
      paths.add(file.path);
    }
  });

const gitRepositoryFileSchema = gitRepositoryFileEntrySchema
  .extend({
    commitSha: gitObjectIdSchema,
    content: z.string().max(5_000_000),
  })
  .strict();

const gitRepositoryChangeSchema = z.discriminatedUnion("kind", [
  gitRepositoryFileEntrySchema
    .extend({
      kind: z.literal("upsert"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tombstone"),
      path: repositoryPathSchema,
    })
    .strict(),
]);

const gitRepositoryDeltaSchema = z
  .object({
    fromCommitSha: gitObjectIdSchema,
    commitSha: gitObjectIdSchema,
    changes: z.array(gitRepositoryChangeSchema).max(100_000),
  })
  .strict()
  .superRefine((delta, context) => {
    const paths = new Set<string>();
    for (const [index, change] of delta.changes.entries()) {
      if (paths.has(change.path)) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "path"],
          message: "A Git diff must not contain duplicate paths.",
        });
      }
      paths.add(change.path);
    }
  });

export type GitRepositoryTarget = GitMarkdownSettings["repository"];
export type GitRepositoryReference = GitMarkdownSettings["ref"];
export type GitRepositorySnapshot = z.infer<typeof gitRepositorySnapshotSchema>;
export type GitRepositoryFile = z.infer<typeof gitRepositoryFileSchema>;
export type GitRepositoryDelta = z.infer<typeof gitRepositoryDeltaSchema>;

export type GitRepositoryAuthentication =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "token"; token: string }>;

export interface InspectGitRepositoryRequest {
  readonly repository: GitRepositoryTarget;
  /** Trusted roots for the local repository mode; never accepted from a Git server. */
  readonly allowedLocalRoots: readonly string[];
  readonly ref: GitRepositoryReference;
  readonly authentication: GitRepositoryAuthentication;
  readonly signal: AbortSignal;
}

export interface ReadGitRepositoryFileRequest
  extends InspectGitRepositoryRequest {
  readonly path: string;
  /** Immutable commit resolved during discovery, never a mutable branch or tag. */
  readonly commitSha: string;
}

export interface DiffGitRepositoryRequest extends InspectGitRepositoryRequest {
  readonly fromCommitSha: string;
}

/**
 * Safe Git access boundary. Its implementation owns Git libraries, checkout isolation,
 * remote authentication, and any process execution; this connector never shells out.
 */
export interface GitRepository {
  inspect(request: InspectGitRepositoryRequest): Promise<GitRepositorySnapshot>;
  readFile(request: ReadGitRepositoryFileRequest): Promise<GitRepositoryFile>;
  diff?(request: DiffGitRepositoryRequest): Promise<GitRepositoryDelta>;
}

export function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ConnectorCancelledError();
  }
}

export function parseGitRepositorySnapshot(
  value: unknown,
): GitRepositorySnapshot {
  return gitRepositorySnapshotSchema.parse(value);
}

export function parseGitRepositoryFile(value: unknown): GitRepositoryFile {
  return gitRepositoryFileSchema.parse(value);
}

export function parseGitRepositoryDelta(value: unknown): GitRepositoryDelta {
  return gitRepositoryDeltaSchema.parse(value);
}

export function requireGitObjectId(value: string): string {
  const result = gitObjectIdSchema.safeParse(value);
  if (!result.success) {
    throw new ConnectorProtocolError(
      "The Git cursor does not contain a commit ID.",
    );
  }
  return result.data;
}

export function requireRepositoryPath(path: string): string {
  const result = repositoryPathSchema.safeParse(path);
  if (!result.success) {
    throw new ConnectorProtocolError(
      "The requested Git document path is invalid.",
    );
  }
  return result.data;
}
