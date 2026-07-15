import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, resolve, sep } from "node:path";

import { expect, test } from "@playwright/test";

import { createOidcAdministrationApiFixture } from "../../apps/api/src/test-support/administration-oidc-fixture.js";

const apiOrigin = "http://127.0.0.1:43100";
/** An already-running static host (including the Docker bridge) can be used
 * for the same browser contract without starting the lightweight test host. */
const externalAdminOrigin = process.env.CASEWEAVER_E2E_ADMIN_ORIGIN;
const adminOrigin = externalAdminOrigin ?? "http://127.0.0.1:43101";
const adminDist = resolve(process.cwd(), "apps/admin/dist");

function contentType(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css";
    case ".js":
      return "text/javascript";
    case ".json":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    default:
      return "text/html";
  }
}

async function startAdminStaticServer(): Promise<Server> {
  await access(resolve(adminDist, "index.html"));
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", adminOrigin).pathname;
    if (pathname === "/runtime-config.json") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          apiBaseUrl: apiOrigin,
          uiTitle: "CaseWeaver E2E Control Room",
        }),
      );
      return;
    }
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const candidate = resolve(adminDist, relative);
    const safePath =
      candidate === adminDist || candidate.startsWith(`${adminDist}${sep}`);
    const file = safePath ? candidate : resolve(adminDist, "index.html");
    try {
      await access(file);
      response.writeHead(200, { "content-type": contentType(file) });
      createReadStream(file).pipe(response);
    } catch {
      const index = resolve(adminDist, "index.html");
      response.writeHead(200, { "content-type": "text/html" });
      createReadStream(index).pipe(response);
    }
  });
  await new Promise<void>((complete, fail) => {
    server.once("error", fail);
    server.listen(43101, "127.0.0.1", () => {
      server.off("error", fail);
      complete();
    });
  });
  return server;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return;
  await new Promise<void>((complete, fail) => {
    server.close((error) => (error === undefined ? complete() : fail(error)));
  });
}

test.describe.configure({ mode: "serial" });

test.describe("operator console browser session", () => {
  const fixture = createOidcAdministrationApiFixture({
    allowedAdminOrigins: [adminOrigin],
  });
  let adminServer: Server | undefined;

  test.beforeAll(async () => {
    if (externalAdminOrigin === undefined) {
      adminServer = await startAdminStaticServer();
    }
    await fixture.app.listen({ host: "127.0.0.1", port: 43100 });
    fixture.setCallbackOrigin(apiOrigin);
  });

  test.afterAll(async () => {
    await fixture.app.close();
    await closeServer(adminServer);
  });

  test("authenticates through the API callback, switches workspace with CSRF, and logs out without browser tokens", async ({
    page,
  }) => {
    await page.goto(adminOrigin);
    await page
      .getByRole("button", {
        name: "Continue with configured identity provider",
      })
      .click();
    await expect(page).toHaveURL(`${adminOrigin}/`);
    expect(page.url()).not.toContain("authorization-code-for-test");
    expect(page.url()).not.toContain("state=");
    expect(page.url()).not.toContain("token");

    const cookies = await page.context().cookies(apiOrigin);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({
      name: "caseweaver-session",
      httpOnly: true,
      secure: false,
    });

    const workspaceSelector = page.getByLabel("Active workspace");
    await expect(workspaceSelector).toHaveText("Operations");
    const browserStorage = await page.evaluate(() => ({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    }));
    const serializedStorage = JSON.stringify(browserStorage).toLowerCase();
    expect(serializedStorage).not.toContain("access_token");
    expect(serializedStorage).not.toContain("refresh_token");
    expect(serializedStorage).not.toContain("id_token");
    expect(serializedStorage).not.toContain("caseweaver-session");

    // The descriptor is registered only in the API fixture.  Rendering and
    // submission here proves the static console has no connector-name branch
    // and sends its draft through the cookie/CSRF API boundary.
    await page.getByRole("link", { name: /Integrations/u }).click();
    await expect(
      page.getByRole("heading", { name: "Connector configuration drafts" }),
    ).toBeVisible();
    await page.getByLabel("Endpoint").fill("https://source.example.test");
    await page
      .getByRole("button", { name: "Create server-validated draft" })
      .click();
    await expect(
      page.getByText(/Draft Fixture source is awaiting server validation/u),
    ).toBeVisible();
    expect(fixture.drafts).toEqual([
      {
        descriptorType: "fixture-source",
        displayName: "Fixture source",
        settings: { endpoint: "https://source.example.test" },
      },
    ]);

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(workspaceSelector).toBeVisible();
    await workspaceSelector.click();
    await page.getByRole("option", { name: "Research" }).click();
    await expect(workspaceSelector).toHaveText("Research");

    await page.getByRole("button", { name: "Sign out" }).click();
    await page
      .getByRole("button", {
        name: "Continue with configured identity provider",
      })
      .waitFor();
    expect(await page.context().cookies(apiOrigin)).toHaveLength(0);
    expect(fixture.auditPlans.map((plan) => plan.event.action)).toEqual(
      expect.arrayContaining([
        "auth.login.initiated",
        "auth.login.succeeded",
        "auth.session.read",
        "auth.workspace.switch.succeeded",
        "auth.logout.succeeded",
      ]),
    );
  });
});
