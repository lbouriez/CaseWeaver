import { describe, expect, it } from "vitest";

import {
  clearedSessionCookie,
  csrfMatches,
  parseSessionCookie,
  requiresTrustedOrigin,
  sessionCookie,
} from "./session-security.js";

const session = "a".repeat(32);

describe("cookie and CSRF boundary", () => {
  it("accepts only the host session cookie and issues secure HttpOnly cookies", () => {
    expect(
      parseSessionCookie(`other=x; __Host-caseweaver-session=${session}`, true),
    ).toBe(session);
    expect(
      parseSessionCookie("__Host-caseweaver-session=invalid", true),
    ).toBeUndefined();
    expect(
      sessionCookie(session, new Date("2027-01-01T00:00:00.000Z"), true),
    ).toContain("Secure");
    expect(clearedSessionCookie(true)).toContain("Max-Age=0");
    expect(
      sessionCookie(session, new Date("2027-01-01T00:00:00.000Z"), false),
    ).toContain("caseweaver-session=");
    expect(
      sessionCookie(session, new Date("2027-01-01T00:00:00.000Z"), false),
    ).not.toContain("__Host-");
  });

  it("fails closed for missing/untrusted origins and mismatched CSRF tokens", () => {
    expect(requiresTrustedOrigin(undefined, ["https://admin.example"])).toBe(
      true,
    );
    expect(
      requiresTrustedOrigin("https://admin.example", ["https://admin.example"]),
    ).toBe(false);
    expect(csrfMatches("token", "token")).toBe(true);
    expect(csrfMatches("token", "other")).toBe(false);
  });
});
