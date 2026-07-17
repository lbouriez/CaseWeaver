import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type ConnectorConfiguration,
  createConnectorConfigurationSchema,
} from "@caseweaver/connector-sdk";
import { z } from "zod";

const defaultIncludePatterns = ["**/*.md", "**/*.mdx"];

function hasUnsafeGitReferenceCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      character.trim().length === 0 ||
      "~^:?*[\\".includes(character)
    );
  });
}

const gitReferenceNameSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !hasUnsafeGitReferenceCharacter(value) &&
      !value.includes("..") &&
      !value.endsWith("/") &&
      !value.endsWith("."),
    "Git reference names must be safe branch or tag names.",
  );

const relativePathPatternSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.split("/").includes(".."),
    "Path patterns must be relative POSIX globs.",
  );

const localFilesystemPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 0x20 && code !== 0x7f;
      }),
    "Local repository paths must not contain control characters.",
  )
  .refine(
    (value) =>
      isAbsolute(value) &&
      !value
        .split(/[\\/]+/u)
        .some((segment) => segment === "." || segment === ".."),
    "Local repository paths must be absolute paths without traversal segments.",
  );

function resolveCanonicalLocalPath(value: string): string | undefined {
  try {
    return realpathSync.native(resolve(value));
  } catch {
    return undefined;
  }
}

function isWithinLocalRoot(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot.length === 0 ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

const safeHttpsUrlSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "Repository URLs must use HTTPS.",
      });
    }
    if (url.username.length > 0 || url.password.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Repository URLs must not contain credentials.",
      });
    }
    if (url.search.length > 0 || url.hash.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Repository URLs must not contain a query or fragment.",
      });
    }
  });

const gitRepositorySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("local"),
      path: localFilesystemPathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("remote"),
      url: safeHttpsUrlSchema,
    })
    .strict(),
]);

const gitReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("branch"),
      name: gitReferenceNameSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("tag"),
      name: gitReferenceNameSchema,
    })
    .strict(),
  z
    .object({
      // An exact object ID is useful for a deliberately reproducible source
      // or repository-analysis checkout.  It is not an arbitrary refspec and
      // it is still verified as a commit by the runtime.
      kind: z.literal("commit"),
      sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu),
    })
    .strict(),
]);

const docusaurusSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    siteUrl: safeHttpsUrlSchema.optional(),
    baseUrl: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          value.startsWith("/") &&
          !value.includes("\\") &&
          !value.includes("\0") &&
          !value.split("/").includes(".."),
        "Docusaurus baseUrl must be an absolute URL path.",
      )
      .default("/"),
    routeBasePath: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.includes("\\") &&
          !value.includes("\0") &&
          !value.split("/").includes(".."),
        "Docusaurus routeBasePath must be a relative URL path.",
      )
      .default("docs"),
    docsPath: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.includes("\\") &&
          !value.includes("\0") &&
          !value.split("/").includes(".."),
        "Docusaurus docsPath must be a relative repository path.",
      )
      .default("docs"),
  })
  .strict()
  .superRefine((settings, context) => {
    if (settings.enabled && settings.siteUrl === undefined) {
      context.addIssue({
        code: "custom",
        path: ["siteUrl"],
        message: "Docusaurus siteUrl is required when Docusaurus is enabled.",
      });
    }
  });

export const gitMarkdownSettingsSchema = z
  .object({
    connectorInstanceId: z.string().min(1).max(200),
    repository: gitRepositorySchema,
    allowedLocalRoots: z.array(localFilesystemPathSchema).max(100).default([]),
    ref: gitReferenceSchema,
    browserUrl: safeHttpsUrlSchema.optional(),
    authentication: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("none") }).strict(),
        z
          .object({
            kind: z.literal("token"),
            secretName: z.string().min(1).max(100),
          })
          .strict(),
      ])
      .default({ kind: "none" }),
    paths: z
      .object({
        include: z
          .array(relativePathPatternSchema)
          .min(1)
          .max(100)
          .default(defaultIncludePatterns),
        exclude: z.array(relativePathPatternSchema).max(100).default([]),
      })
      .strict()
      .default({ include: defaultIncludePatterns, exclude: [] }),
    maximumMarkdownCharacters: z
      .number()
      .int()
      .positive()
      .max(1_000_000)
      .default(1_000_000),
    docusaurus: docusaurusSettingsSchema.default({
      enabled: false,
      baseUrl: "/",
      routeBasePath: "docs",
      docsPath: "docs",
    }),
  })
  .strict();

const connectorConfigurationSchema = createConnectorConfigurationSchema(
  gitMarkdownSettingsSchema,
).extend({
  connectorType: z.literal("git-markdown"),
});

export const gitMarkdownConfigurationSchema =
  connectorConfigurationSchema.superRefine((configuration, context) => {
    const canonicalRoots = configuration.settings.allowedLocalRoots.map(
      (root, index) => {
        const canonicalRoot = resolveCanonicalLocalPath(root);
        if (canonicalRoot === undefined) {
          context.addIssue({
            code: "custom",
            path: ["settings", "allowedLocalRoots", index],
            message:
              "Allowed local repository roots must exist and resolve to canonical paths.",
          });
        }
        return canonicalRoot;
      },
    );
    const repository = configuration.settings.repository;
    if (repository.kind === "local") {
      const canonicalRepositoryPath = resolveCanonicalLocalPath(
        repository.path,
      );
      if (canonicalRepositoryPath === undefined) {
        context.addIssue({
          code: "custom",
          path: ["settings", "repository", "path"],
          message:
            "Local repository paths must exist and resolve to canonical paths.",
        });
      } else if (
        !canonicalRoots.some(
          (root) =>
            root !== undefined &&
            isWithinLocalRoot(canonicalRepositoryPath, root),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["settings", "repository", "path"],
          message:
            "Local repository paths must resolve within an allowed local repository root.",
        });
      }
    }

    const authentication = configuration.settings.authentication;
    if (repository.kind === "local" && authentication.kind !== "none") {
      context.addIssue({
        code: "custom",
        path: ["settings", "authentication"],
        message: "Local repositories do not support Git token authentication.",
      });
    }
    if (
      authentication.kind === "token" &&
      configuration.secrets[authentication.secretName] === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["secrets", authentication.secretName],
        message: "The configured Git token secret reference is required.",
      });
    }
  });

export type GitMarkdownSettings = z.infer<typeof gitMarkdownSettingsSchema>;
export type GitMarkdownConfiguration = z.infer<
  typeof gitMarkdownConfigurationSchema
>;

export type GitMarkdownConfigurationEnvelope =
  ConnectorConfiguration<GitMarkdownSettings>;
