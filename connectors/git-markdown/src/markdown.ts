import type { GitMarkdownSettings } from "./config.js";

export interface MarkdownHeading {
  readonly level: number;
  readonly text: string;
  readonly anchor: string;
  readonly line: number;
}

export interface MarkdownFrontMatter {
  readonly values: Readonly<
    Record<string, string | boolean | readonly string[]>
  >;
  readonly body: string;
}

export interface ParsedMarkdownDocument {
  readonly markdown: string;
  readonly title?: string;
  readonly frontMatter: MarkdownFrontMatter["values"];
  readonly headings: readonly MarkdownHeading[];
  readonly draft: boolean;
}

function normaliseLineEndings(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function splitInlineList(value: string): readonly string[] {
  const content = value.slice(1, -1).trim();
  if (content.length === 0) return [];

  return content.split(",").map((entry) => unquote(entry.trim()));
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1).replace(/\\(["'\\])/g, "$1");
  }
  return value;
}

function parseFrontMatterValue(
  value: string,
): string | boolean | readonly string[] {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitInlineList(value);
  }
  return unquote(value);
}

/**
 * Reads the conventional scalar Docusaurus fields while leaving unsupported YAML
 * structures out of the normalized Markdown body rather than interpreting them.
 */
export function splitMarkdownFrontMatter(
  markdown: string,
): MarkdownFrontMatter {
  const normalized = normaliseLineEndings(markdown);
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    return { values: Object.freeze({}), body: normalized };
  }

  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---" || lines[index] === "...") {
      endIndex = index;
      break;
    }
  }

  if (endIndex === -1) {
    return { values: Object.freeze({}), body: normalized };
  }

  const values: Record<string, string | boolean | readonly string[]> = {};
  for (const line of lines.slice(1, endIndex)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
    if (match === null) continue;

    const key = match[1];
    if (key === undefined) continue;
    const value = match[2]?.trim() ?? "";
    values[key] = parseFrontMatterValue(value);
  }

  return {
    values: Object.freeze(values),
    body: lines.slice(endIndex + 1).join("\n"),
  };
}

function plainHeadingText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

export function docusaurusAnchor(value: string): string {
  return plainHeadingText(value)
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/[\s-]+/g, "-");
}

function extractHeadings(markdown: string): readonly MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const duplicateAnchors = new Map<string, number>();
  let fence: { marker: "`" | "~"; length: number } | undefined;
  const lines = markdown.split("\n");

  for (const [index, line] of lines.entries()) {
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
      continue;
    }
    if (fence !== undefined) continue;

    const headingMatch = /^(?: {0,3})(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (headingMatch === null) continue;

    const text = plainHeadingText(headingMatch[2] ?? "");
    const baseAnchor = docusaurusAnchor(text);
    if (baseAnchor.length === 0) continue;
    const duplicateCount = duplicateAnchors.get(baseAnchor) ?? 0;
    duplicateAnchors.set(baseAnchor, duplicateCount + 1);

    headings.push({
      level: headingMatch[1]?.length ?? 1,
      text,
      anchor:
        duplicateCount === 0 ? baseAnchor : `${baseAnchor}-${duplicateCount}`,
      line: index + 1,
    });
  }

  return Object.freeze(headings);
}

function stringFrontMatterValue(
  frontMatter: MarkdownFrontMatter["values"],
  key: string,
): string | undefined {
  const value = frontMatter[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseMarkdownDocument(
  markdown: string,
): ParsedMarkdownDocument {
  const frontMatter = splitMarkdownFrontMatter(markdown);
  const headings = extractHeadings(frontMatter.body);
  const firstHeading = headings.find((heading) => heading.level === 1);
  const title =
    stringFrontMatterValue(frontMatter.values, "title") ?? firstHeading?.text;

  return Object.freeze({
    markdown: frontMatter.body,
    title,
    frontMatter: frontMatter.values,
    headings,
    draft: frontMatter.values.draft === true,
  });
}

function trimPathSegment(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function joinUrlPath(...segments: readonly string[]): string {
  const cleanSegments = segments
    .map(trimPathSegment)
    .filter((segment) => segment.length > 0)
    .flatMap((segment) => segment.split("/"))
    .map((segment) => encodeURIComponent(segment));
  return `/${cleanSegments.join("/")}`;
}

function repositoryRelativeDocsPath(
  path: string,
  docsPath: string,
): string | undefined {
  const prefix = `${trimPathSegment(docsPath)}/`;
  if (!path.startsWith(prefix)) return undefined;
  const withoutExtension = path
    .slice(prefix.length)
    .replace(/\.(?:md|mdx)$/i, "");
  if (withoutExtension.length === 0) return undefined;
  return withoutExtension;
}

function docusaurusSlug(
  path: string,
  parsed: ParsedMarkdownDocument,
  settings: GitMarkdownSettings["docusaurus"],
): string | undefined {
  const configuredSlug = stringFrontMatterValue(parsed.frontMatter, "slug");
  const relativePath = repositoryRelativeDocsPath(path, settings.docsPath);
  if (configuredSlug !== undefined) {
    if (configuredSlug.startsWith("/")) return configuredSlug;
    const directory = relativePath?.split("/").slice(0, -1).join("/") ?? "";
    return joinUrlPath(settings.routeBasePath, directory, configuredSlug);
  }
  if (relativePath === undefined) return undefined;

  const parts = relativePath.split("/");
  if (parts.at(-1) === "index") parts.pop();
  return joinUrlPath(settings.routeBasePath, parts.join("/"));
}

export function docusaurusDocumentUrl(input: {
  readonly path: string;
  readonly parsed: ParsedMarkdownDocument;
  readonly settings: GitMarkdownSettings["docusaurus"];
}): string | undefined {
  if (!input.settings.enabled || input.settings.siteUrl === undefined) {
    return undefined;
  }
  const slug = docusaurusSlug(input.path, input.parsed, input.settings);
  if (slug === undefined) return undefined;

  const base = new URL(input.settings.siteUrl);
  base.pathname = joinUrlPath(input.settings.baseUrl, slug);
  base.search = "";
  base.hash = "";
  return base.toString();
}

export function gitBlobSourceUrl(input: {
  readonly repository: GitMarkdownSettings["repository"];
  readonly browserUrl?: string;
  readonly commitSha: string;
  readonly path: string;
}): string | undefined {
  if (input.repository.kind === "local" && input.browserUrl === undefined) {
    return undefined;
  }

  const base = new URL(
    input.browserUrl ??
      (input.repository.kind === "remote" ? input.repository.url : ""),
  );
  const repositoryPath = base.pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  base.pathname = `${repositoryPath}/blob/${encodeURIComponent(
    input.commitSha,
  )}/${input.path.split("/").map(encodeURIComponent).join("/")}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}
