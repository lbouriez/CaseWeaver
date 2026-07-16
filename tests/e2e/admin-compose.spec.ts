import { expect, test } from "@playwright/test";

/**
 * This is deliberately not a fixture test.  It targets the disposable Docker
 * topology through the same-origin edge, including the real API, cookie
 * session, PostgreSQL audit store and baked Admin artifact.  It is opt-in for
 * developers but is enabled by the container workflow after Compose is ready.
 */
const composeOrigin = process.env.CASEWEAVER_E2E_COMPOSE_ORIGIN;

test.describe("disposable Compose operator journey", () => {
  test.skip(
    composeOrigin === undefined,
    "Set CASEWEAVER_E2E_COMPOSE_ORIGIN after starting compose.local.yml.",
  );

  test("uses a server cookie to author a profile, inspect its audit, and log out without browser secrets", async ({
    page,
  }) => {
    const origin = composeOrigin as string;
    await page.goto(origin);
    await page.getByLabel("Login").fill("admin");
    await page.getByLabel("Password").fill("admin");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(
      page.getByRole("link", { name: /Knowledge & Analysis/u }),
    ).toBeVisible();
    const cookies = await page.context().cookies(origin);
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "caseweaver-session",
          httpOnly: true,
          secure: false,
        }),
      ]),
    );
    const storage = await page.evaluate(() => ({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    }));
    const serializedStorage = JSON.stringify(storage).toLowerCase();
    expect(serializedStorage).not.toContain("access_token");
    expect(serializedStorage).not.toContain("refresh_token");
    expect(serializedStorage).not.toContain("id_token");
    expect(serializedStorage).not.toContain("caseweaver-session");
    expect(serializedStorage).not.toContain("admin");

    await page.getByRole("link", { name: /Knowledge & Analysis/u }).click();
    await expect(
      page.getByRole("heading", { name: "Create a retrieval profile draft" }),
    ).toBeVisible();
    await page
      .getByLabel("Retrieval profile display name")
      .fill("Compose retrieval policy");
    await page
      .getByLabel("Retrieval policy settings")
      .fill('{"policy":"hybrid","maximumResults":12}');
    await page
      .getByRole("button", { name: "Create retrieval profile draft" })
      .click();
    await expect(
      page.getByText("Draft Compose retrieval policy was created."),
    ).toBeVisible();

    // The section dashboard is a compact preview rather than a navigation
    // tree.  Navigate to the actual audited resource view so this assertion
    // exercises the backend read model as an operator would.
    await page.goto(`${origin}/#/audit-events`);
    await expect(
      page.getByText("admin.configuration.draft.created"),
    ).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(await page.context().cookies(origin)).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ name: "caseweaver-session" }),
      ]),
    );
  });
});
