import { requireRepositoryPath } from "./git-repository.js";

const imageExtensions = new Set(["bmp", "gif", "jpeg", "jpg", "png", "webp"]);
const fileExtensions = new Set([
  "cfg",
  "conf",
  "config",
  "csv",
  "ini",
  "json",
  "log",
  "md",
  "mdx",
  "text",
  "toml",
  "txt",
  "xml",
  "yaml",
  "yml",
  "zip",
]);

export type MarkdownAttachmentCandidate =
  | Readonly<{
      kind: "repositoryFile";
      relation: "inlineImage" | "inlineFile";
      path: string;
    }>
  | Readonly<{
      kind: "publicHttpsImage";
      relation: "inlineImage";
      url: string;
    }>;

interface RawMarkdownLink {
  readonly index: number;
  readonly syntax: "image" | "link";
  readonly destination: string;
}

function withoutFencedCode(markdown: string): string {
  let fence:
    | { readonly marker: "`" | "~"; readonly length: number }
    | undefined;
  return markdown
    .split("\n")
    .map((line) => {
      const fenceMatch = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);
      if (fenceMatch !== null) {
        const marker = fenceMatch[1]?.[0];
        const length = fenceMatch[1]?.length;
        if ((marker === "`" || marker === "~") && length !== undefined) {
          if (fence === undefined) {
            fence = { marker, length };
          } else if (fence.marker === marker && length >= fence.length) {
            fence = undefined;
          }
        }
        return " ".repeat(line.length);
      }
      return fence === undefined ? line : " ".repeat(line.length);
    })
    .join("\n");
}

function addMarkdownLinks(markdown: string, links: RawMarkdownLink[]): void {
  const expression =
    /(!?)\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/gu;
  for (const match of markdown.matchAll(expression)) {
    const start = match.index;
    const destination = match[2];
    if (start === undefined || destination === undefined) continue;
    links.push({
      index: start,
      syntax: match[1] === "!" ? "image" : "link",
      destination,
    });
  }
}

function addHtmlLinks(markdown: string, links: RawMarkdownLink[]): void {
  const expression =
    /<(img|a)\b[^>]*?\b(src|href)\s*=\s*("[^"]*"|'[^']*')[^>]*>/giu;
  for (const match of markdown.matchAll(expression)) {
    const start = match.index;
    const tag = match[1]?.toLowerCase();
    const quotedDestination = match[3];
    if (start === undefined || quotedDestination === undefined) continue;
    const destination = quotedDestination.slice(1, -1);
    links.push({
      index: start,
      syntax: tag === "img" ? "image" : "link",
      destination,
    });
  }
}

function extension(path: string): string | undefined {
  const name = path.split("/").at(-1);
  const separator = name?.lastIndexOf(".") ?? -1;
  if (separator <= 0) return undefined;
  return name?.slice(separator + 1).toLowerCase();
}

function isSupportedRepositoryFile(path: string): boolean {
  const fileExtension = extension(path);
  return (
    fileExtension !== undefined &&
    (imageExtensions.has(fileExtension) || fileExtensions.has(fileExtension))
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
}

function repositoryPathFromLink(
  destination: string,
  documentPath: string,
): string | undefined {
  const trimmed = destination.trim().replace(/^<|>$/g, "");
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    trimmed.includes("\\") ||
    hasControlCharacter(trimmed)
  ) {
    return undefined;
  }

  // Any URI scheme (including data:, javascript:, and protocol-relative URLs) is
  // not a repository-relative file. Public HTTPS is handled separately.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(trimmed) || trimmed.startsWith("//")) {
    return undefined;
  }

  const pathOnly = trimmed.split(/[?#]/u, 1)[0];
  if (pathOnly === undefined || pathOnly.length === 0) return undefined;
  const directory = documentPath.split("/").slice(0, -1);
  const segments = [...directory, ...pathOnly.split("/")];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) return undefined;
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  try {
    return requireRepositoryPath(resolved.join("/"));
  } catch {
    return undefined;
  }
}

function publicHttpsImage(destination: string): string | undefined {
  const trimmed = destination.trim().replace(/^<|>$/g, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    return undefined;
  }
  url.hash = "";
  return url.toString();
}

/**
 * Finds static Markdown/MDX attachment references without changing source text.
 * Dynamic MDX expressions are intentionally ignored: they cannot be pinned to one
 * immutable binary identity at discovery time.
 */
export function discoverMarkdownAttachmentCandidates(input: {
  readonly markdown: string;
  readonly documentPath: string;
}): readonly MarkdownAttachmentCandidate[] {
  const documentPath = requireRepositoryPath(input.documentPath);
  const links: RawMarkdownLink[] = [];
  const searchable = withoutFencedCode(input.markdown);
  addMarkdownLinks(searchable, links);
  addHtmlLinks(searchable, links);

  return Object.freeze(
    links
      .sort((left, right) => left.index - right.index)
      .flatMap((link): readonly MarkdownAttachmentCandidate[] => {
        if (link.syntax === "image") {
          const publicImage = publicHttpsImage(link.destination);
          if (publicImage !== undefined) {
            return [
              Object.freeze({
                kind: "publicHttpsImage" as const,
                relation: "inlineImage" as const,
                url: publicImage,
              }),
            ];
          }
        }

        const path = repositoryPathFromLink(link.destination, documentPath);
        if (path === undefined || !isSupportedRepositoryFile(path)) return [];
        const image = imageExtensions.has(extension(path) ?? "");
        if (link.syntax === "image" && !image) return [];
        return [
          Object.freeze({
            kind: "repositoryFile" as const,
            relation: image
              ? ("inlineImage" as const)
              : ("inlineFile" as const),
            path,
          }),
        ];
      }),
  );
}
