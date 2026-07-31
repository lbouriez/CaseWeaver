import { expect, type Locator, type Page, test } from "@playwright/test";

const composeOrigin = process.env.CASEWEAVER_E2E_COMPOSE_ORIGIN;
const providerModel = "caseweaver-e2e-embedding-1536";

function section(page: Page, heading: string): Locator {
  // Authoring panels have an explicit semantic section even though MUI styles
  // them as Paper components. This covers both descriptor panels and forms.
  return page
    .getByRole("heading", { name: heading, exact: true })
    .locator("xpath=ancestor::section[1]");
}

function field(scope: Page | Locator, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // Required MUI labels expose their asterisk in the accessible name. Match
  // the complete functional label while accepting that presentation suffix.
  return scope.getByLabel(new RegExp(`^${escaped}(?:\\s|\\*|$)`, "u"));
}

async function selectOption(
  page: Page,
  scope: Locator,
  label: string,
  option: string | RegExp,
): Promise<void> {
  const control = field(scope, label);
  await expect(control).toBeVisible();
  await control.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function selectFirstMatchingOption(
  page: Page,
  scope: Locator,
  label: string,
  option: RegExp,
): Promise<void> {
  const control = field(scope, label);
  await expect(control).toBeVisible();
  await control.click();
  await page.getByRole("option", { name: option }).first().click();
}

async function confirmOperation(
  page: Page,
  options: Readonly<{
    readonly expectedMessage?: RegExp;
    readonly unmountsOnSuccess?: boolean;
  }> = {},
): Promise<void> {
  const dialog = page.getByRole("dialog", {
    name: "Confirm server-reviewed operation",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm operation" }).click();
  await expect(
    dialog.getByRole("button", { name: "Confirm operation" }),
  ).toBeDisabled();
  if (options.expectedMessage !== undefined) {
    await expect(dialog.getByText(options.expectedMessage)).toBeVisible();
  }
  if (options.unmountsOnSuccess) {
    await expect(dialog).toBeHidden();
    return;
  }
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
}

test.describe("deterministic provider onboarding through the disposable stack", () => {
  // This crosses authentication, immutable configuration, a metered provider
  // request and a real Git repository. The default UI-test timeout is too
  // short for that complete, disposable Compose journey on CI.
  test.setTimeout(90_000);

  test.skip(
    composeOrigin === undefined,
    "Run through pnpm test:e2e:compose or set CASEWEAVER_E2E_COMPOSE_ORIGIN.",
  );

  test("authorizes an inventory-backed embedding provider, tests it, and synchronizes Git knowledge", async ({
    page,
  }) => {
    const origin = composeOrigin as string;
    await page.goto(origin);
    await page.getByLabel("Login").fill("admin");
    await page.getByLabel("Password").fill("admin");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("link", { name: /AI$/u })).toBeVisible();

    await page.goto(`${origin}/#/access`);
    const secretRegistration = section(page, "Register where a secret lives");
    await field(secretRegistration, "External secret reference").fill(
      "env:CASEWEAVER_E2E_OPENAI_COMPATIBLE_KEY",
    );
    await secretRegistration
      .getByRole("button", { name: "Register reference" })
      .click();
    await expect(
      secretRegistration.getByText(/is available for descriptor forms\./u),
    ).toBeVisible();

    await page.goto(`${origin}/#/ai`);
    const providerDraft = section(page, "Configure an AI provider");
    await expect(providerDraft).toBeVisible();
    await selectOption(
      page,
      providerDraft,
      "Registered type",
      /OpenAI-compatible/u,
    );
    await field(providerDraft, "Instance display name").fill(
      "E2E embedding provider",
    );
    await field(providerDraft, "HTTPS endpoint").fill(
      "https://e2e-openai-provider:8443/v1",
    );
    await selectFirstMatchingOption(
      page,
      providerDraft,
      "Provider API credential",
      /Secret reference/u,
    );
    await selectOption(page, providerDraft, "API capability", "embeddings");
    await providerDraft
      .getByRole("button", { name: "Save inactive provider" })
      .click();
    await expect(
      providerDraft.getByText(/was saved inactive\. Review and activate/u),
    ).toBeVisible();
    await providerDraft
      .getByRole("button", { name: "Review and activate provider" })
      .click();
    await confirmOperation(page, { unmountsOnSuccess: true });
    await expect(
      providerDraft.getByText(
        /is active\. Continue with the trusted model catalog/u,
      ),
    ).toBeVisible();

    const binding = section(page, "Create a model binding draft");
    await expect(binding).toBeVisible();
    await binding
      .getByRole("button", { name: "Refresh models available from provider" })
      .click();
    await expect(
      page.getByText(
        /Provider model inventory was refreshed\. 1 available models/u,
      ),
    ).toBeVisible();
    await selectOption(page, binding, "Role", "embedding");
    await expect(
      binding.getByRole("combobox", { name: "Provider inventory snapshot" }),
    ).not.toHaveText("");
    await expect(
      binding.getByRole("combobox", {
        name: "Model available from provider",
      }),
    ).toContainText(providerModel);
    await field(binding, "Maximum input tokens (optional)").fill("128");
    await binding.getByRole("button", { name: "Create binding draft" }).click();
    await expect(
      page.getByText(/Binding draft .* was created\./u),
    ).toBeVisible();
    await binding
      .getByRole("button", { name: "Activate binding draft" })
      .click();
    await expect(page.getByText(/^AI binding .* is active\.$/u)).toBeVisible();

    const roleDefault = section(page, "Set workspace role default");
    await selectOption(page, roleDefault, "Role", "embedding");
    await selectFirstMatchingOption(
      page,
      roleDefault,
      "Binding version",
      /^embedding · /u,
    );
    await roleDefault
      .getByRole("button", { name: "Save role default" })
      .click();
    await expect(page.getByText(/was updated\./u)).toBeVisible();

    const pricing = section(page, "Add a workspace pricing override");
    await selectOption(
      page,
      pricing,
      "Provider inventory model",
      providerModel,
    );
    await field(pricing, "Input price amount").fill("0.000001");
    await pricing
      .getByRole("button", { name: "Create pricing override" })
      .click();
    await expect(page.getByText(/was created\./u)).toBeVisible();

    const budget = section(page, "Replace budget policy");
    await field(budget, "Limit amount").fill("1");
    await budget.getByRole("button", { name: "Save budget policy" }).click();
    await expect(page.getByText(/was saved\./u)).toBeVisible();

    const capabilityTest = section(page, "Metered provider capability test");
    await capabilityTest
      .getByRole("button", { name: "Preview provider test impact" })
      .click();
    await expect(
      capabilityTest.getByRole("button", {
        name: "Confirm and run provider test",
      }),
    ).toBeVisible();
    await capabilityTest
      .getByRole("button", { name: "Confirm and run provider test" })
      .click();
    await expect(page.getByText("Provider test succeeded.")).toBeVisible();

    await page.goto(`${origin}/#/knowledge-analysis`);
    const collection = section(page, "Create a collection");
    await expect(collection).toBeVisible();
    await field(collection, "Collection ID").fill("e2e-support-knowledge");
    await field(collection, "Embedding profile version").fill(
      "e2e-embedding-v1",
    );
    await field(collection, "Embedding dimensions").fill("1536");
    await collection
      .getByRole("button", { name: "Create immutable collection" })
      .click();
    await expect(
      collection.getByText(/is ready for new source drafts\./u),
    ).toBeVisible();

    await page.goto(`${origin}/#/integrations`);
    const connectorDraft = section(page, "Connector configuration drafts");
    await selectOption(
      page,
      connectorDraft,
      "Registered type",
      /Git \/ Markdown/u,
    );
    await field(connectorDraft, "Instance display name").fill(
      "E2E knowledge repository",
    );
    await selectOption(
      page,
      connectorDraft,
      "Repository location",
      "Trusted local repository",
    );
    await field(connectorDraft, "Repository local path").fill(
      "/mnt/caseweaver/e2e-repository",
    );
    await field(connectorDraft, "Allowed local roots").fill("/mnt/caseweaver");
    await selectOption(page, connectorDraft, "Git reference type", "Branch");
    await field(connectorDraft, "Git reference name").fill("main");
    await connectorDraft
      .getByRole("button", { name: "Preview configuration test" })
      .click();
    await connectorDraft
      .getByRole("button", { name: "Confirm and run configuration test" })
      .click();
    await expect(
      connectorDraft.getByText("Configuration test succeeded."),
    ).toBeVisible();
    await connectorDraft
      .getByRole("button", { name: "Save inactive connector" })
      .click();
    await expect(
      connectorDraft.getByText(
        /was saved inactive\. Activate it from Connector instances/u,
      ),
    ).toBeVisible();

    await page.goto(`${origin}/#/integrations`);
    const connectorInstances = section(page, "Connector instances");
    await connectorInstances.getByRole("button", { name: "Activate" }).click();
    await confirmOperation(page, { unmountsOnSuccess: true });

    await page.goto(`${origin}/#/integrations`);
    const sourceDraft = section(page, "Create an inert source draft");
    await expect(sourceDraft).toBeVisible();
    await field(sourceDraft, "Source display name").fill(
      "E2E support knowledge source",
    );
    await selectFirstMatchingOption(
      page,
      sourceDraft,
      "Active connector instance",
      /E2E knowledge repository/u,
    );
    await selectOption(
      page,
      sourceDraft,
      "Knowledge collection",
      "e2e-support-knowledge",
    );
    await sourceDraft
      .getByRole("button", { name: "Create source draft" })
      .click();
    await expect(
      sourceDraft.getByText(
        /is inert until its server-owned lifecycle changes/u,
      ),
    ).toBeVisible();
    await sourceDraft.getByRole("button", { name: "Activate" }).click();
    const sourceActivation = page.getByRole("dialog", {
      name: "Activate source",
    });
    await expect(sourceActivation).toBeVisible();
    await sourceActivation.getByRole("button", { name: "Activate" }).click();
    await expect(sourceActivation.getByText("Activated source.")).toBeVisible();
    await sourceActivation.getByRole("button", { name: "Close" }).click();

    await page.goto(`${origin}/#/integrations`);
    const knowledgeSources = section(page, "Knowledge sources");
    await knowledgeSources.getByRole("button", { name: "Synchronize" }).click();
    await confirmOperation(page, {
      expectedMessage:
        /The source synchronization was queued with its immutable configuration version./u,
    });

    const storage = await page.evaluate(() =>
      JSON.stringify({
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
      }).toLowerCase(),
    );
    expect(storage).not.toContain("caseweaver-e2e-provider-credential");
    expect(storage).not.toContain("caseweaver_e2e_openai_compatible_key");
  });
});
