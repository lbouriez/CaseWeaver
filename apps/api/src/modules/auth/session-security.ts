import { timingSafeEqual } from "node:crypto";

const secureSessionCookieName = "__Host-caseweaver-session";
const developmentSessionCookieName = "caseweaver-session";

function sessionCookieName(secure: boolean): string {
  return secure ? secureSessionCookieName : developmentSessionCookieName;
}

export function parseSessionCookie(
  cookieHeader: string | undefined,
  secure: boolean,
): string | undefined {
  if (cookieHeader === undefined || cookieHeader.length > 8_192)
    return undefined;
  for (const part of cookieHeader.split(";")) {
    const [name, ...values] = part.trim().split("=");
    if (name === sessionCookieName(secure)) {
      const value = values.join("=");
      return /^[A-Za-z0-9_-]{22,512}$/u.test(value) ? value : undefined;
    }
  }
  return undefined;
}

export function sessionCookie(
  value: string,
  expiresAt: Date,
  secure: boolean,
): string {
  if (!/^[A-Za-z0-9_-]{22,512}$/u.test(value))
    throw new Error("Session value is invalid.");
  return `${sessionCookieName(secure)}=${value}; Path=/; HttpOnly; SameSite=Lax; ${secure ? "Secure; " : ""}Expires=${expiresAt.toUTCString()}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${sessionCookieName(secure)}=; Path=/; HttpOnly; SameSite=Lax; ${secure ? "Secure; " : ""}Max-Age=0`;
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
