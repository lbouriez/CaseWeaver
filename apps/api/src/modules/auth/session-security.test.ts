import { describe, expect, it } from "vitest";

import {
  clearedSessionCookie,
  csrfMatches,
  parseSessionCookie,
  requiresTrustedOrigin,
  sessionCookie,
} from "./session-security.js";

const session = "a".repeat(32);
const secureLax = { secure: true, sameSite: "lax" } as const;
const developmentLax = { secure: false, sameSite: "lax" } as const;
const secureNone = { secure: true, sameSite: "none" } as const;

describe("cookie and CSRF boundary", () => {
  it("accepts only the host session cookie and issues secure HttpOnly cookies", () => {
    expect(
      parseSessionCookie(
        `other=x; __Host-caseweaver-session=${session}`,
        secureLax,
      ),
    ).toBe(session);
    expect(
      parseSessionCookie("__Host-caseweaver-session=invalid", secureLax),
    ).toBeUndefined();
    expect(
      sessionCookie(session, new Date("2027-01-01T00:00:00.000Z"), secureLax),
    ).toContain("Secure");
    expect(clearedSessionCookie(secureLax)).toContain("Max-Age=0");
    expect(
      sessionCookie(
        session,
        new Date("2027-01-01T00:00:00.000Z"),
        developmentLax,
      ),
    ).toContain("caseweaver-session=");
    expect(
      sessionCookie(
        session,
        new Date("2027-01-01T00:00:00.000Z"),
        developmentLax,
      ),
    ).not.toContain("__Host-");
  });

  it("uses matching secure SameSite=None attributes for an external console", () => {
    expect(
      sessionCookie(session, new Date("2027-01-01T00:00:00.000Z"), secureNone),
    ).toContain("SameSite=None; Secure");
    expect(clearedSessionCookie(secureNone)).toContain("SameSite=None; Secure");
    expect(() =>
      sessionCookie(session, new Date("2027-01-01T00:00:00.000Z"), {
        secure: false,
        sameSite: "none",
      }),
    ).toThrow("Cross-site session cookies must be secure");
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
