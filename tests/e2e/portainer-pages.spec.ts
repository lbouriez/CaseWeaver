import { expect, test } from "@playwright/test";

const apiOrigin = process.env.CASEWEAVER_E2E_PORTAINER_API_ORIGIN;
const consoleOrigin = process.env.CASEWEAVER_E2E_PORTAINER_CONSOLE_ORIGIN;
const attackerOrigin = process.env.CASEWEAVER_E2E_PORTAINER_ATTACKER_ORIGIN;

test.use({
  ignoreHTTPSErrors: true,
  launchOptions: {
    args: [
      "--host-resolver-rules=MAP api.caseweaver.test 127.0.0.1,MAP console.pages.test 127.0.0.1,MAP attacker.pages.test 127.0.0.1,MAP oidc.caseweaver.test 127.0.0.1",
    ],
  },
});

test.describe("Portainer backend with separately hosted Admin", () => {
  test.skip(
    apiOrigin === undefined ||
      consoleOrigin === undefined ||
      attackerOrigin === undefined,
    "The Portainer/Pages runner supplies the isolated HTTPS origins.",
  );

  test("completes OIDC through the API, performs an audited Admin mutation, and rejects an attacker origin", async ({
    browser,
  }) => {
    // A real authorization-code redirect, a cross-site credentialed preflight,
    // and an audited mutation are intentionally exercised here.  Keep this
    // acceptance test independent of the short component-test timeout.
    test.setTimeout(90_000);
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const apiOnly = await page.goto(apiOrigin as string);
    expect(apiOnly?.status()).toBe(404);

    await page.goto(consoleOrigin as string);
    await page
      .getByRole("button", {
        name: "Continue with configured identity provider",
      })
      .click();
    await expect(page).toHaveURL(`${consoleOrigin}/`);
    expect(page.url()).not.toMatch(/code=|state=|access_token|id_token/iu);
    await expect(
      page.getByRole("link", { name: /Knowledge & Analysis/u }),
    ).toBeVisible();

    const cookies = await context.cookies(apiOrigin as string);
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "__Host-caseweaver-session",
          httpOnly: true,
          secure: true,
          path: "/",
          sameSite: "None",
        }),
      ]),
    );

    const browserState = await page.evaluate(() => ({
      cookie: document.cookie,
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
      indexedDb: indexedDB.databases === undefined ? [] : undefined,
      location: location.href,
    }));
    expect(JSON.stringify(browserState).toLowerCase()).not.toMatch(
      /access_token|refresh_token|id_token|caseweaver-session|secret|authorization-code/iu,
    );

    await page.getByRole("link", { name: /Knowledge & Analysis/u }).click();
    await expect(
      page.getByRole("heading", { name: "Create a retrieval profile draft" }),
    ).toBeVisible();
    await page
      .getByLabel("Retrieval profile display name")
      .fill("External Pages retrieval policy");
    await page
      .getByRole("textbox", { name: "Retrieval policy settings" })
      .fill('{"policy":"hybrid","maximumResults":8}');
    await page
      .getByRole("button", { name: "Create retrieval profile draft" })
      .click();
    await expect(
      page.getByText("Draft External Pages retrieval policy was created."),
    ).toBeVisible();

    const attacker = await context.newPage();
    await attacker.goto(attackerOrigin as string);
    await expect(
      attacker.evaluate(async (api) => {
        try {
          await fetch(`${api}/v1/auth/logout`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          return "unexpected-success";
        } catch {
          return "cors-blocked";
        }
      }, apiOrigin as string),
    ).resolves.toBe("cors-blocked");

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(
      page.getByRole("button", {
        name: "Continue with configured identity provider",
      }),
    ).toBeVisible();
    expect(await context.cookies(apiOrigin as string)).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ name: "__Host-caseweaver-session" }),
      ]),
    );
    await context.close();
  });
});
