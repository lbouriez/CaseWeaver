import { timingSafeEqual } from "node:crypto";

const secureSessionCookieName = "__Host-caseweaver-session";
const developmentSessionCookieName = "caseweaver-session";

export type SessionCookieSameSite = "lax" | "none";

/** Deployment-owned HTTP cookie attributes. They are never sent to the browser as data. */
export interface SessionCookieConfiguration {
  readonly secure: boolean;
  readonly sameSite: SessionCookieSameSite;
}

export function assertValidSessionCookieConfiguration(
  configuration: SessionCookieConfiguration,
): void {
  if (configuration.sameSite === "none" && !configuration.secure) {
    throw new Error("Cross-site session cookies must be secure.");
  }
}

function sessionCookieName(configuration: SessionCookieConfiguration): string {
  return configuration.secure
    ? secureSessionCookieName
    : developmentSessionCookieName;
}

function sessionCookieAttributes(
  configuration: SessionCookieConfiguration,
): string {
  assertValidSessionCookieConfiguration(configuration);
  const sameSite = configuration.sameSite === "none" ? "None" : "Lax";
  return `Path=/; HttpOnly; SameSite=${sameSite}; ${configuration.secure ? "Secure; " : ""}`;
}

export function parseSessionCookie(
  cookieHeader: string | undefined,
  configuration: SessionCookieConfiguration,
): string | undefined {
  assertValidSessionCookieConfiguration(configuration);
  if (cookieHeader === undefined || cookieHeader.length > 8_192)
    return undefined;
  for (const part of cookieHeader.split(";")) {
    const [name, ...values] = part.trim().split("=");
    if (name === sessionCookieName(configuration)) {
      const value = values.join("=");
      return /^[A-Za-z0-9_-]{22,512}$/u.test(value) ? value : undefined;
    }
  }
  return undefined;
}

export function sessionCookie(
  value: string,
  expiresAt: Date,
  configuration: SessionCookieConfiguration,
): string {
  if (!/^[A-Za-z0-9_-]{22,512}$/u.test(value))
    throw new Error("Session value is invalid.");
  return `${sessionCookieName(configuration)}=${value}; ${sessionCookieAttributes(configuration)}Expires=${expiresAt.toUTCString()}`;
}

export function clearedSessionCookie(
  configuration: SessionCookieConfiguration,
): string {
  return `${sessionCookieName(configuration)}=; ${sessionCookieAttributes(configuration)}Max-Age=0`;
}

export function requiresTrustedOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  return origin === undefined || !allowedOrigins.includes(origin);
}

export function csrfMatches(
  supplied: string | undefined,
  expected: string,
): boolean {
  if (supplied === undefined) return false;
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
