import { expect, test } from "@playwright/test";

const origin = process.env.CASEWEAVER_E2E_PRODUCTION_ORIGIN;
const httpOrigin = process.env.CASEWEAVER_E2E_PRODUCTION_HTTP_ORIGIN;
const login = process.env.CASEWEAVER_E2E_PRODUCTION_LOGIN;
const password = process.env.CASEWEAVER_E2E_PRODUCTION_PASSWORD;

test.use({
  ignoreHTTPSErrors: true,
  launchOptions: {
    args: [
      "--host-resolver-rules=MAP caseweaver.test 127.0.0.1,MAP oidc.caseweaver.test 127.0.0.1",
    ],
  },
});

test.describe("production Compose TLS operator journey", () => {
  test.skip(
    origin === undefined ||
      httpOrigin === undefined ||
      login === undefined ||
      password === undefined,
    "The production Compose runner supplies the isolated TLS origin and ephemeral login.",
  );

  test("terminates TLS, rejects browser secret storage, and completes password and OIDC sessions", async ({
    page,
    request,
  }) => {
    const insecureUrl = new URL(httpOrigin as string);
    const insecure = await request.get(`http://127.0.0.1:${insecureUrl.port}`, {
      maxRedirects: 0,
      headers: { host: insecureUrl.host },
    });
    expect(insecure.status()).toBe(308);
    expect(insecure.headers().location).toBe(`${origin}/`);

    const response = await page.goto(origin as string);
    expect(response?.headers()["strict-transport-security"]).toContain(
      "max-age=",
    );
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

    await page.getByLabel("Login").fill(login as string);
    await page.getByLabel("Password").fill(password as string);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page.getByRole("link", { name: /Knowledge & Analysis/u }),
    ).toBeVisible();

    const passwordCookies = await page.context().cookies(origin as string);
    expect(passwordCookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "__Host-caseweaver-session",
          httpOnly: true,
          secure: true,
          path: "/",
        }),
      ]),
    );
    const storage = await page.evaluate(() => ({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
      config: document.querySelector('script[src*="runtime-config"]')
        ?.textContent,
    }));
    const serialized = JSON.stringify(storage).toLowerCase();
    expect(serialized).not.toMatch(
      /access_token|refresh_token|id_token|caseweaver-session|password|secret/iu,
    );

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

    await page
      .getByRole("button", {
        name: "Continue with configured identity provider",
      })
      .click();
    await expect(page).toHaveURL(`${origin}/`);
    expect(page.url()).not.toMatch(/code=|state=|token/iu);
    await expect(page.getByRole("link", { name: /Operations/u })).toBeVisible();

    await page.goto(`${origin}/#/audit-events`);
    await expect(page.getByText("auth.login.succeeded").first()).toBeVisible();
  });
});
