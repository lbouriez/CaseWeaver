import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import {
  assertActive,
  type GitMarkdownAttachmentAddress,
  type GitMarkdownAttachmentLocatorCodec,
  gitMarkdownAttachmentReferenceId,
  invalidAttachmentIdentity,
  parseGitMarkdownAttachmentAddress,
} from "@caseweaver/connector-git-markdown";
import {
  type AttachmentLocator,
  type AttachmentSource,
  attachmentLocatorSchema,
  ConnectorCancelledError,
  ConnectorProtocolError,
  ConnectorRemoteError,
  type OpenAttachmentRequest,
  type OpenedAttachment,
} from "@caseweaver/connector-sdk";

const attachmentLocatorVersion = "git-markdown.attachment.v1";
const attachmentLocatorAad = new TextEncoder().encode(
  "caseweaver.git-markdown.attachment.v1",
);
const documentResourceType = "document";
const attachmentResourceType = "attachment";
const supportedImageMediaTypes = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface GitMarkdownAttachmentLocatorKey {
  /** Deployment-owned key identifier. It is not a secret and is included in the envelope. */
  readonly id: string;
  /** Exactly 32 bytes of server-private AES-256 material. */
  readonly material: Uint8Array;
}

export interface AesGcmGitMarkdownAttachmentLocatorCodecOptions {
  /** New locators are always sealed with this key. */
  readonly activeKeyId: string;
  /** Includes the active key and any decrypt-only rotated keys. */
  readonly keys: readonly GitMarkdownAttachmentLocatorKey[];
}

interface SealedAttachmentEnvelope {
  readonly v: 1;
  readonly k: string;
  readonly n: string;
  readonly c: string;
  readonly t: string;
}

/**
 * Stateless sealed locator codec for Git/Markdown attachment addresses. The token is
 * safe to retain only as server-private connector state: it is authenticated and
 * encrypted with AES-256-GCM, carries no process-local reverse lookup, and supports
 * rotation by retaining decrypt-only keys in the supplied key ring.
 */
export class AesGcmGitMarkdownAttachmentLocatorCodec
  implements GitMarkdownAttachmentLocatorCodec
{
  private readonly activeKey: Readonly<{
    id: string;
    material: Uint8Array;
  }>;
  private readonly keys: ReadonlyMap<string, Uint8Array>;

  public constructor(options: AesGcmGitMarkdownAttachmentLocatorCodecOptions) {
    const keys = new Map<string, Uint8Array>();
    for (const key of options.keys) {
      assertKeyId(key.id);
      if (key.material.byteLength !== 32 || keys.has(key.id)) {
        throw new TypeError(
          "Git Markdown attachment locator key configuration is invalid.",
        );
      }
      keys.set(key.id, new Uint8Array(key.material));
    }
    assertKeyId(options.activeKeyId);
    const activeMaterial = keys.get(options.activeKeyId);
    if (activeMaterial === undefined) {
      throw new TypeError(
        "Git Markdown attachment locator key configuration is invalid.",
      );
    }
    this.activeKey = Object.freeze({
      id: options.activeKeyId,
      material: activeMaterial,
    });
    this.keys = keys;
  }

  public async seal(
    address: GitMarkdownAttachmentAddress,
    signal: AbortSignal,
  ): Promise<AttachmentLocator> {
    assertActive(signal);
    try {
      const canonical = parseGitMarkdownAttachmentAddress(address);
      const nonce = randomBytes(12);
      const cipher = createCipheriv(
        "aes-256-gcm",
        this.activeKey.material,
        nonce,
      );
      cipher.setAAD(attachmentLocatorAad);
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(canonical), "utf8"),
        cipher.final(),
      ]);
      const envelope: SealedAttachmentEnvelope = {
        v: 1,
        k: this.activeKey.id,
        n: nonce.toString("base64url"),
        c: encrypted.toString("base64url"),
        t: cipher.getAuthTag().toString("base64url"),
      };
      assertActive(signal);
      return attachmentLocatorSchema.parse({
        version: attachmentLocatorVersion,
        value: Buffer.from(JSON.stringify(envelope), "utf8").toString(
          "base64url",
        ),
      });
    } catch (error) {
      if (error instanceof ConnectorCancelledError) throw error;
      throw invalidAttachmentIdentity();
    }
  }

  public async open(
    locator: AttachmentLocator,
    signal: AbortSignal,
  ): Promise<GitMarkdownAttachmentAddress> {
    assertActive(signal);
    try {
      const parsedLocator = attachmentLocatorSchema.parse(locator);
      if (parsedLocator.version !== attachmentLocatorVersion) {
        throw new Error("invalid locator version");
      }
      const envelope = parseSealedEnvelope(parsedLocator.value);
      const key = this.keys.get(envelope.k);
      if (key === undefined) throw new Error("unknown locator key");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        decodeBase64(envelope.n),
      );
      decipher.setAAD(attachmentLocatorAad);
      decipher.setAuthTag(decodeBase64(envelope.t));
      const plaintext = Buffer.concat([
        decipher.update(decodeBase64(envelope.c)),
        decipher.final(),
      ]);
      assertActive(signal);
      return parseGitMarkdownAttachmentAddress(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
      );
    } catch (error) {
      if (error instanceof ConnectorCancelledError) throw error;
      throw invalidAttachmentIdentity();
    }
  }
}

/** Opens only a pre-validated sealed public image address. */
export interface PublicHttpsImageAttachmentOpener {
  open(
    address: Extract<
      GitMarkdownAttachmentAddress,
      { readonly kind: "publicHttpsImage" }
    >,
    signal: AbortSignal,
  ): Promise<OpenedAttachment>;
}

export interface GitMarkdownAttachmentDispatcherOptions {
  readonly connectorInstanceId: string;
  readonly locatorCodec: GitMarkdownAttachmentLocatorCodec;
  /** The connector's repository-file source; it revalidates before Git access. */
  readonly repositoryAttachmentSource: AttachmentSource;
  readonly publicImageAttachmentOpener: PublicHttpsImageAttachmentOpener;
}

/**
 * Validates a sealed occurrence before dispatching it to the repository-only
 * connector source or the outer public-image opener. No public URL is accepted from
 * a caller and a repository source never receives a public-image locator.
 */
export class GitMarkdownAttachmentDispatcher implements AttachmentSource {
  private readonly connectorInstanceId: string;
  private readonly locatorCodec: GitMarkdownAttachmentLocatorCodec;
  private readonly repositoryAttachmentSource: AttachmentSource;
  private readonly publicImageAttachmentOpener: PublicHttpsImageAttachmentOpener;

  public constructor(options: GitMarkdownAttachmentDispatcherOptions) {
    if (!safeIdentifier(options.connectorInstanceId)) {
      throw new TypeError(
        "Git Markdown attachment dispatcher configuration is invalid.",
      );
    }
    this.connectorInstanceId = options.connectorInstanceId;
    this.locatorCodec = options.locatorCodec;
    this.repositoryAttachmentSource = options.repositoryAttachmentSource;
    this.publicImageAttachmentOpener = options.publicImageAttachmentOpener;
  }

  public async openAttachment(
    request: OpenAttachmentRequest,
  ): Promise<OpenedAttachment> {
    assertActive(request.signal);
    const identity = request.identity;
    if (
      identity === undefined ||
      !sameReference(request.reference, identity.reference)
    ) {
      throw invalidAttachmentIdentity();
    }
    if (
      identity.owner.kind !== "knowledgeDocument" ||
      identity.owner.document.connectorInstanceId !==
        this.connectorInstanceId ||
      identity.owner.document.resourceType !== documentResourceType ||
      identity.reference.connectorInstanceId !== this.connectorInstanceId ||
      identity.reference.resourceType !== attachmentResourceType ||
      identity.reference.externalId !==
        gitMarkdownAttachmentReferenceId(identity.locator)
    ) {
      throw invalidAttachmentIdentity();
    }

    let address: GitMarkdownAttachmentAddress;
    try {
      address = parseGitMarkdownAttachmentAddress(
        await this.locatorCodec.open(identity.locator, request.signal),
      );
    } catch (error) {
      if (error instanceof ConnectorCancelledError) throw error;
      throw invalidAttachmentIdentity();
    }
    assertActive(request.signal);
    if (
      address.connectorInstanceId !== this.connectorInstanceId ||
      address.sourcePath !== identity.owner.document.externalId ||
      address.ordinal !== identity.ordinal ||
      address.relation !== identity.relation
    ) {
      throw invalidAttachmentIdentity();
    }

    if (address.kind === "repositoryFile") {
      return this.repositoryAttachmentSource.openAttachment(request);
    }
    return this.publicImageAttachmentOpener.open(address, request.signal);
  }
}

export interface PublicHttpsImageDnsResolver {
  /** Resolves one hostname to literal addresses before every connection/redirect. */
  resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
}

export class NodePublicHttpsImageDnsResolver
  implements PublicHttpsImageDnsResolver
{
  public async resolve(
    hostname: string,
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    assertActive(signal);
    const result = await awaitWithCancellation(
      dnsLookup(hostname, { all: true, verbatim: true }),
      signal,
    );
    assertActive(signal);
    return result.map((entry) => entry.address);
  }
}

export interface PublicHttpsImageTransportRequest {
  readonly url: URL;
  /** Prevalidated literal address; transport must not perform another DNS lookup. */
  readonly address: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface PublicHttpsImageTransportResponse {
  readonly statusCode: number;
  readonly headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
  readonly body: AsyncIterable<Uint8Array>;
  /** Stops the response and releases its socket without exposing response details. */
  dispose(): void;
}

export interface PublicHttpsImageTransport {
  open(
    request: PublicHttpsImageTransportRequest,
  ): Promise<PublicHttpsImageTransportResponse>;
}

class PublicImageTransportFailure extends Error {
  public constructor(
    public readonly reason: "cancelled" | "network" | "timeout",
  ) {
    super("Public image transport failed.");
    this.name = "PublicImageTransportFailure";
  }
}

/**
 * HTTPS transport that pins a connection to an already-screened address. Passing a
 * custom lookup prevents Node from resolving the host again between DNS screening and
 * TCP connection, while SNI and certificate validation remain bound to the hostname.
 */
export class NodePublicHttpsImageTransport
  implements PublicHttpsImageTransport
{
  public async open(
    input: PublicHttpsImageTransportRequest,
  ): Promise<PublicHttpsImageTransportResponse> {
    assertActive(input.signal);
    const family = isIP(input.address);
    if (family === 0) throw new PublicImageTransportFailure("network");

    return new Promise<PublicHttpsImageTransportResponse>(
      (resolveResponse, reject) => {
        let settled = false;
        let timedOut = false;
        let response: IncomingMessage | undefined;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          callback();
        };
        const request = httpsRequest(input.url, {
          agent: false,
          headers: {
            accept: "image/avif,image/gif,image/jpeg,image/png,image/webp",
            "accept-encoding": "identity",
            "user-agent": "CaseWeaver attachment intake",
          },
          lookup: (hostname, _options, callback) => {
            if (hostname !== input.url.hostname) {
              callback(new PublicImageTransportFailure("network"), "", family);
              return;
            }
            callback(null, input.address, family);
          },
          method: "GET",
          servername: input.url.hostname,
        });
        const cancelled = () => {
          request.destroy(new PublicImageTransportFailure("cancelled"));
          response?.destroy(new PublicImageTransportFailure("cancelled"));
        };
        const cleanup = () =>
          input.signal.removeEventListener("abort", cancelled);
        request.setTimeout(input.timeoutMs, () => {
          timedOut = true;
          request.destroy(new PublicImageTransportFailure("timeout"));
        });
        request.once("error", (error: unknown) => {
          cleanup();
          if (error instanceof PublicImageTransportFailure) {
            finish(() => reject(error));
            return;
          }
          finish(() =>
            reject(
              new PublicImageTransportFailure(timedOut ? "timeout" : "network"),
            ),
          );
        });
        request.once("response", (received) => {
          response = received;
          received.setTimeout(input.timeoutMs, () => {
            timedOut = true;
            received.destroy(new PublicImageTransportFailure("timeout"));
          });
          const dispose = () => {
            request.destroy();
            received.destroy();
          };
          received.once("close", cleanup);
          finish(() =>
            resolveResponse(
              Object.freeze({
                statusCode: received.statusCode ?? 0,
                headers: received.headers,
                body: received,
                dispose,
              }),
            ),
          );
        });
        input.signal.addEventListener("abort", cancelled, { once: true });
        if (input.signal.aborted) cancelled();
        request.end();
      },
    );
  }
}

export interface PublicHttpsImageFetchLimits {
  readonly maximumBytes: number;
  readonly timeoutMs: number;
  readonly maximumRedirects: number;
  readonly maximumDnsAddresses: number;
}

const defaultPublicHttpsImageFetchLimits: PublicHttpsImageFetchLimits =
  Object.freeze({
    maximumBytes: 10 * 1_024 * 1_024,
    timeoutMs: 15_000,
    maximumRedirects: 3,
    maximumDnsAddresses: 16,
  });

export interface SecurePublicHttpsImageAttachmentOpenerOptions {
  readonly dnsResolver?: PublicHttpsImageDnsResolver;
  readonly transport?: PublicHttpsImageTransport;
  readonly limits?: Partial<PublicHttpsImageFetchLimits>;
}

/**
 * Opens a public image only after HTTPS, port, DNS, address, redirect, MIME, encoding,
 * byte, timeout, and cancellation checks. The resulting stream is still verified by
 * the attachment intake pipeline; no URL or response detail crosses this boundary.
 */
export class SecurePublicHttpsImageAttachmentOpener
  implements PublicHttpsImageAttachmentOpener
{
  private readonly dnsResolver: PublicHttpsImageDnsResolver;
  private readonly transport: PublicHttpsImageTransport;
  private readonly limits: PublicHttpsImageFetchLimits;

  public constructor(
    options: SecurePublicHttpsImageAttachmentOpenerOptions = {},
  ) {
    this.dnsResolver =
      options.dnsResolver ?? new NodePublicHttpsImageDnsResolver();
    this.transport = options.transport ?? new NodePublicHttpsImageTransport();
    this.limits = parsePublicHttpsImageFetchLimits(options.limits);
  }

  public async open(
    address: Extract<
      GitMarkdownAttachmentAddress,
      { readonly kind: "publicHttpsImage" }
    >,
    signal: AbortSignal,
  ): Promise<OpenedAttachment> {
    assertActive(signal);
    let validatedAddress: Extract<
      GitMarkdownAttachmentAddress,
      { readonly kind: "publicHttpsImage" }
    >;
    try {
      const parsed = parseGitMarkdownAttachmentAddress(address);
      if (parsed.kind !== "publicHttpsImage")
        throw new Error("invalid image address");
      validatedAddress = parsed;
    } catch {
      throw invalidAttachmentIdentity();
    }
    let target: URL;
    try {
      target = publicHttpsTarget(validatedAddress.url);
    } catch {
      throw invalidAttachmentIdentity();
    }

    for (
      let redirects = 0;
      redirects <= this.limits.maximumRedirects;
      redirects += 1
    ) {
      const connectionAddress = await this.resolveSafeAddress(target, signal);
      let response: PublicHttpsImageTransportResponse;
      try {
        response = await this.transport.open({
          url: target,
          address: connectionAddress,
          signal,
          timeoutMs: this.limits.timeoutMs,
        });
      } catch (error) {
        throw publicImageRemoteFailure(error, signal);
      }
      assertActive(signal);

      if (isRedirect(response.statusCode)) {
        const location = singleHeader(response.headers, "location");
        response.dispose();
        if (
          location === undefined ||
          redirects === this.limits.maximumRedirects
        ) {
          throw new ConnectorProtocolError(
            "The public image redirect is unavailable or exceeds its configured limit.",
          );
        }
        try {
          target = publicHttpsTarget(new URL(location, target).toString());
        } catch {
          throw new ConnectorProtocolError(
            "The public image redirect is unavailable or exceeds its configured limit.",
          );
        }
        continue;
      }
      if (response.statusCode !== 200) {
        response.dispose();
        throw new ConnectorRemoteError("The public image is unavailable.", {
          category: "remote",
          retryable: response.statusCode >= 500,
        });
      }

      let mediaType: string;
      let contentLength: number | undefined;
      try {
        mediaType = requiredImageMediaType(response.headers);
        contentLength = declaredContentLength(
          response.headers,
          this.limits.maximumBytes,
        );
      } catch (error) {
        response.dispose();
        throw error;
      }
      return Object.freeze({
        content: boundedPublicImageContent(
          response,
          signal,
          this.limits.maximumBytes,
        ),
        mediaType,
        ...(contentLength === undefined ? {} : { contentLength }),
      });
    }
    throw new ConnectorProtocolError(
      "The public image redirect is unavailable.",
    );
  }

  private async resolveSafeAddress(
    target: URL,
    signal: AbortSignal,
  ): Promise<string> {
    assertActive(signal);
    const literal = isIP(target.hostname);
    const addresses =
      literal === 0
        ? await this.resolveHostname(target.hostname, signal)
        : [target.hostname];
    if (
      addresses.length === 0 ||
      addresses.length > this.limits.maximumDnsAddresses
    ) {
      throw new ConnectorProtocolError("The public image host is unavailable.");
    }
    const uniqueAddresses = [...new Set(addresses)];
    if (!uniqueAddresses.every(isPublicInternetAddress)) {
      throw new ConnectorProtocolError("The public image host is unavailable.");
    }
    const selected = uniqueAddresses[0];
    if (selected === undefined) {
      throw new ConnectorProtocolError("The public image host is unavailable.");
    }
    return selected;
  }

  private async resolveHostname(
    hostname: string,
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    try {
      const addresses = await this.dnsResolver.resolve(hostname, signal);
      assertActive(signal);
      return addresses;
    } catch (error) {
      if (error instanceof ConnectorCancelledError) throw error;
      throw new ConnectorRemoteError("The public image host is unavailable.", {
        category: "network",
        retryable: true,
      });
    }
  }
}

function parseSealedEnvelope(value: string): SealedAttachmentEnvelope {
  const encoded = decodeBase64(value);
  let candidate: unknown;
  try {
    candidate = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(encoded),
    );
  } catch {
    throw new Error("invalid locator envelope");
  }
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.keys(candidate).length !== 5
  ) {
    throw new Error("invalid locator envelope");
  }
  const record = candidate as Record<string, unknown>;
  if (
    record.v !== 1 ||
    !safeKeyId(record.k) ||
    !safeBase64Text(record.n) ||
    !safeBase64Text(record.c) ||
    !safeBase64Text(record.t)
  ) {
    throw new Error("invalid locator envelope");
  }
  return {
    v: 1,
    k: record.k,
    n: record.n,
    c: record.c,
    t: record.t,
  };
}

function decodeBase64(value: string): Buffer {
  if (!safeBase64Text(value)) throw new Error("invalid base64 value");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength === 0 || decoded.toString("base64url") !== value) {
    throw new Error("invalid base64 value");
  }
  return decoded;
}

function assertKeyId(value: string): void {
  if (!safeKeyId(value)) {
    throw new TypeError(
      "Git Markdown attachment locator key configuration is invalid.",
    );
  }
}

function safeKeyId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 100 &&
    /^[A-Za-z0-9-]+$/.test(value)
  );
}

function safeBase64Text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 16_384 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function safeIdentifier(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 200 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint !== 0x7f;
    })
  );
}

function sameReference(
  left: Readonly<{
    connectorInstanceId: string;
    resourceType: string;
    externalId: string;
  }>,
  right: Readonly<{
    connectorInstanceId: string;
    resourceType: string;
    externalId: string;
  }>,
): boolean {
  return (
    left.connectorInstanceId === right.connectorInstanceId &&
    left.resourceType === right.resourceType &&
    left.externalId === right.externalId
  );
}

function parsePublicHttpsImageFetchLimits(
  overrides: Partial<PublicHttpsImageFetchLimits> | undefined,
): PublicHttpsImageFetchLimits {
  const limits = { ...defaultPublicHttpsImageFetchLimits, ...overrides };
  if (
    !Number.isSafeInteger(limits.maximumBytes) ||
    limits.maximumBytes < 1 ||
    !Number.isSafeInteger(limits.timeoutMs) ||
    limits.timeoutMs < 1 ||
    !Number.isSafeInteger(limits.maximumRedirects) ||
    limits.maximumRedirects < 0 ||
    !Number.isSafeInteger(limits.maximumDnsAddresses) ||
    limits.maximumDnsAddresses < 1
  ) {
    throw new TypeError("Public image fetch limits are invalid.");
  }
  return Object.freeze(limits);
}

function publicHttpsTarget(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    (url.port.length > 0 && url.port !== "443") ||
    url.hostname.length === 0 ||
    url.hostname.endsWith(".") ||
    url.hostname.toLowerCase().endsWith(".local")
  ) {
    throw new Error("unsafe public image target");
  }
  return url;
}

function isRedirect(statusCode: number): boolean {
  return (
    statusCode === 301 ||
    statusCode === 302 ||
    statusCode === 303 ||
    statusCode === 307 ||
    statusCode === 308
  );
}

function singleHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function requiredImageMediaType(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): string {
  const contentEncoding = singleHeader(headers, "content-encoding");
  if (
    contentEncoding !== undefined &&
    contentEncoding.toLowerCase() !== "identity"
  ) {
    throw new ConnectorProtocolError(
      "The public image response encoding is unsupported.",
    );
  }
  const contentType = singleHeader(headers, "content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === undefined || !supportedImageMediaTypes.has(mediaType)) {
    throw new ConnectorProtocolError(
      "The public image response MIME type is unsupported.",
    );
  }
  return mediaType;
}

function declaredContentLength(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  maximumBytes: number,
): number | undefined {
  const header = singleHeader(headers, "content-length");
  if (header === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(header)) {
    throw new ConnectorProtocolError(
      "The public image response length is invalid.",
    );
  }
  const value = Number(header);
  if (!Number.isSafeInteger(value) || value > maximumBytes) {
    throw new ConnectorProtocolError(
      "The public image response exceeds its configured limit.",
    );
  }
  return value;
}

async function* boundedPublicImageContent(
  response: PublicHttpsImageTransportResponse,
  signal: AbortSignal,
  maximumBytes: number,
): AsyncIterable<Uint8Array> {
  let byteLength = 0;
  try {
    for await (const value of response.body) {
      assertActive(signal);
      const chunk = new Uint8Array(value);
      byteLength += chunk.byteLength;
      if (byteLength > maximumBytes) {
        response.dispose();
        throw new ConnectorProtocolError(
          "The public image response exceeds its configured limit.",
        );
      }
      yield chunk;
    }
    assertActive(signal);
  } catch (error) {
    if (
      error instanceof ConnectorCancelledError ||
      error instanceof ConnectorProtocolError ||
      error instanceof ConnectorRemoteError
    ) {
      throw error;
    }
    throw publicImageRemoteFailure(error, signal);
  } finally {
    response.dispose();
  }
}

function publicImageRemoteFailure(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted || error instanceof ConnectorCancelledError) {
    return new ConnectorCancelledError();
  }
  if (
    error instanceof PublicImageTransportFailure &&
    error.reason === "timeout"
  ) {
    return new ConnectorRemoteError("Public image download timed out.", {
      category: "timeout",
      retryable: true,
    });
  }
  return new ConnectorRemoteError("Public image download failed.", {
    category: "network",
    retryable: true,
  });
}

function isPublicInternetAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4Address(address);
  if (family === 6) return isPublicIpv6Address(address);
  return false;
}

function isPublicIpv4Address(address: string): boolean {
  const octets = address.split(".").map(Number);
  const first = octets[0];
  const second = octets[1];
  const third = octets[2];
  if (first === undefined || second === undefined || third === undefined)
    return false;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    // The deprecated 6to4 relay-anycast block is not a public Internet
    // destination. Block the complete /24, rather than only its former
    // anycast address, so an alternate address cannot bypass SSRF screening.
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0 && third === 113)
  );
}

function isPublicIpv6Address(address: string): boolean {
  const value = parseIpv6(address);
  if (value === undefined) return false;
  return !(
    value === 0n ||
    value === 1n ||
    hasIpv6Prefix(value, 0n, 96) ||
    hasIpv6Prefix(value, 0x64ff9bn, 96) ||
    hasIpv6Prefix(value, 0x100n, 64) ||
    hasIpv6Prefix(value, 0x20010db8n, 32) ||
    hasIpv6Prefix(value, 0x2002n, 16) ||
    hasIpv6Prefix(value, 0xfcn, 7) ||
    hasIpv6Prefix(value, 0xfe80n, 10) ||
    hasIpv6Prefix(value, 0xffn, 8)
  );
}

function hasIpv6Prefix(value: bigint, prefix: bigint, bits: number): boolean {
  return value >> BigInt(128 - bits) === prefix;
}

function parseIpv6(address: string): bigint | undefined {
  const normalized = address.toLowerCase();
  if (normalized.includes("%") || normalized.split("::").length > 2)
    return undefined;
  const [head = "", tail] = normalized.split("::");
  const headParts = head.length === 0 ? [] : head.split(":");
  const tailParts =
    tail === undefined || tail.length === 0 ? [] : tail.split(":");
  const parts = [...headParts, ...tailParts];
  if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  if (tail === undefined ? parts.length !== 8 : parts.length >= 8)
    return undefined;
  const groups = [
    ...headParts,
    ...Array.from({ length: 8 - parts.length }, () => "0"),
    ...tailParts,
  ];
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

async function awaitWithCancellation<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new ConnectorCancelledError();
  return new Promise<T>((resolvePromise, reject) => {
    const cancelled = () => reject(new ConnectorCancelledError());
    signal.addEventListener("abort", cancelled, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", cancelled);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", cancelled);
        reject(error);
      },
    );
  });
}
