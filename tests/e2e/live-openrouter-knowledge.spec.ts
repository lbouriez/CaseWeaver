import { expect, type Locator, type Page, test } from "@playwright/test";

const composeOrigin = process.env.CASEWEAVER_E2E_COMPOSE_ORIGIN;
const runLiveOpenRouter = process.env.CASEWEAVER_E2E_LIVE_OPENROUTER === "true";
const runLiveOpenRouterEmbeddings =
  process.env.CASEWEAVER_E2E_OPENROUTER_EMBEDDINGS_AVAILABLE === "true";
const embeddingModel =
  process.env.CASEWEAVER_E2E_OPENROUTER_EMBEDDING_MODEL ??
  "openai/text-embedding-3-small";
const chatModel =
  process.env.CASEWEAVER_E2E_OPENROUTER_CHAT_MODEL ?? "openai/gpt-4o-mini";
const runId = process.env.CASEWEAVER_E2E_LIVE_RUN_ID ?? Date.now().toString(36);
const providerName = `Live OpenRouter embedding ${runId}`;
const chatProviderName = `Live OpenRouter chat ${runId}`;
const collectionId = `live-openrouter-${runId}`;
const sourceName = `Live OpenRouter documentation ${runId}`;

function section(page: Page, heading: string): Locator {
  return page
    .getByRole("heading", { name: heading, exact: true })
    .locator("xpath=ancestor::section[1]");
}

function field(scope: Page | Locator, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return scope.getByLabel(new RegExp(`^${escaped}(?:\\s|\\*|$)`, "u"));
}

async function selectOption(
  page: Page,
  scope: Page | Locator,
  label: string,
  option: string | RegExp,
): Promise<void> {
  const control = field(scope, label);
  await expect(control).toBeVisible();
  await control.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** Local validation preserves PostgreSQL volumes, so reuse the existing
 * workspace-wide policy when a prior opt-in run created one. A fresh Compose
 * volume deliberately takes the create path. */
async function selectExistingWorkspaceBudget(
  page: Page,
  scope: Page | Locator,
): Promise<void> {
  await field(scope, "Existing policy (optional)").click();
  const existing = page.getByRole("option", { name: "workspace · all" });
  if ((await existing.count()) === 0) {
    await page.keyboard.press("Escape");
    return;
  }
  await existing.first().click();
}

async function confirmOperation(
  page: Page,
  options: Readonly<{ readonly unmountsOnSuccess?: boolean }> = {},
): Promise<void> {
  const dialog = page.getByRole("dialog", {
    name: "Confirm server-reviewed operation",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm operation" }).click();
  if (options.unmountsOnSuccess) {
    await expect(dialog).toBeHidden();
    return;
  }
  await dialog.getByRole("button", { name: "Close" }).click();
}

/**
 * A provider capability test deliberately resolves the workspace role default
 * to an immutable binding version. The local PostgreSQL volume survives test
 * runs, so selecting the first role option can accidentally select a binding
 * that belongs to a previously-created provider. Read the newly activated
 * aggregate identifier from the server response and select its exact first
 * immutable version instead.
 */
async function activateBindingAndGetVersionId(
  page: Page,
  binding: Locator,
): Promise<string> {
  await binding.getByRole("button", { name: "Activate binding draft" }).click();
  const activated = page
    .getByText(/^AI binding ai-binding-[a-f0-9]+ is active\.$/u)
    .last();
  await expect(activated).toBeVisible();
  const text = await activated.textContent();
  const match = /^AI binding (ai-binding-[a-f0-9]+) is active\.$/u.exec(
    text ?? "",
  );
  if (match?.[1] === undefined) {
    throw new Error(
      "The activated binding response did not identify a binding.",
    );
  }
  return `${match[1]}:1`;
}

async function setExactRoleDefault(
  page: Page,
  role: "analysis" | "embedding",
  bindingVersionId: string,
): Promise<void> {
  const roleDefault = section(page, "Set workspace role default");
  await selectOption(page, roleDefault, "Role", role);
  await field(roleDefault, "Binding version").click();
  await page
    .getByRole("option", {
      name: `${role} · ${bindingVersionId}`,
      exact: true,
    })
    .click();
  await roleDefault.getByRole("button", { name: "Save role default" }).click();
  await expect(page.getByText(/was updated\./u)).toBeVisible();
}

function requireLoopbackOrigin(origin: string): void {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")
  ) {
    throw new Error(
      "Live OpenRouter validation is restricted to loopback Compose.",
    );
  }
}

test.describe("live OpenRouter knowledge onboarding", () => {
  test.skip(
    !runLiveOpenRouter || composeOrigin === undefined,
    "Set CASEWEAVER_E2E_LIVE_OPENROUTER=true and a loopback CASEWEAVER_E2E_COMPOSE_ORIGIN to opt into a metered local validation.",
  );

  test.setTimeout(180_000);

  test("uses a server-only key for an inventory-backed, budgeted chat capability test", async ({
    page,
  }) => {
    const origin = composeOrigin as string;
    requireLoopbackOrigin(origin);

    await page.goto(origin);
    await page.getByLabel("Login").fill("admin");
    await page.getByLabel("Password").fill("admin");
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.goto(`${origin}/#/access`);
    const secretRegistration = section(page, "Register where a secret lives");
    await field(secretRegistration, "External secret reference").fill(
      "env:CASEWEAVER_OPENROUTER_KEY",
    );
    await secretRegistration
      .getByRole("button", { name: "Register reference" })
      .click();
    await expect(
      secretRegistration.getByText(/is available for descriptor forms\./u),
    ).toBeVisible();

    await page.goto(`${origin}/#/ai`);
    const providerDraft = section(page, "Configure an AI provider");
    await selectOption(
      page,
      providerDraft,
      "Registered type",
      /OpenAI-compatible/u,
    );
    await field(providerDraft, "Instance display name").fill(chatProviderName);
    await field(providerDraft, "HTTPS endpoint").fill(
      "https://openrouter.ai/api/v1",
    );
    await selectOption(
      page,
      providerDraft,
      "Provider API credential",
      /Secret reference/u,
    );
    await selectOption(
      page,
      providerDraft,
      "API capability",
      "chatCompletions",
    );
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

    const binding = section(page, "Create a model binding draft");
    await selectOption(
      page,
      binding,
      "Active provider instance",
      chatProviderName,
    );
    await binding
      .getByRole("button", { name: "Refresh models available from provider" })
      .click();
    await expect(
      page.getByText(/Provider model inventory was refreshed\./u),
    ).toBeVisible({ timeout: 60_000 });
    await selectOption(page, binding, "Role", "analysis");
    await field(binding, "Filter provider models").fill(chatModel);
    await expect(field(binding, "Model available from provider")).toContainText(
      chatModel,
      { timeout: 30_000 },
    );
    await selectOption(
      page,
      binding,
      "Model available from provider",
      chatModel,
    );
    await field(binding, "Maximum input tokens (optional)").fill("128");
    await binding.getByRole("button", { name: "Create binding draft" }).click();
    await expect(
      page.getByText(/Binding draft .* was created\./u),
    ).toBeVisible();
    const bindingVersionId = await activateBindingAndGetVersionId(
      page,
      binding,
    );
    await setExactRoleDefault(page, "analysis", bindingVersionId);

    const pricing = section(page, "Add a workspace pricing override");
    await selectOption(page, pricing, "Provider inventory model", chatModel);
    await field(pricing, "Input price amount").fill("0.000001");
    await field(pricing, "Output price amount").fill("0.000002");
    await pricing
      .getByRole("button", { name: "Create pricing override" })
      .click();
    await expect(page.getByText(/was created\./u)).toBeVisible();

    const budget = section(page, "Replace budget policy");
    await selectExistingWorkspaceBudget(page, budget);
    await field(budget, "Limit amount").fill("0.05");
    await budget.getByRole("button", { name: "Save budget policy" }).click();
    await expect(page.getByText(/was saved\./u)).toBeVisible();

    const capabilityTest = section(page, "Metered provider capability test");
    await selectOption(
      page,
      capabilityTest,
      "Active provider instance",
      chatProviderName,
    );
    const previewResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/capability-tests/provider.test/previews"),
    );
    await capabilityTest
      .getByRole("button", { name: "Preview provider test impact" })
      .click();
    await expect((await previewResponse).status()).toBe(200);
    await expect(
      capabilityTest.getByRole("button", {
        name: "Confirm and run provider test",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await capabilityTest
      .getByRole("button", { name: "Confirm and run provider test" })
      .click();
    await expect(page.getByText("Provider test succeeded.")).toBeVisible({
      timeout: 60_000,
    });

    const storage = await page.evaluate(() =>
      JSON.stringify({
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
      }).toLowerCase(),
    );
    expect(storage).not.toContain("caseweaver_openrouter_key");
    expect(storage).not.toContain("access_token");
    expect(storage).not.toContain("refresh_token");
  });

  test("uses a server-only key for an inventory-backed embedding binding and local knowledge sync", async ({
    page,
  }) => {
    test.skip(
      !runLiveOpenRouterEmbeddings,
      "Set CASEWEAVER_E2E_OPENROUTER_EMBEDDINGS_AVAILABLE=true only after confirming that the configured account exposes the selected embedding model.",
    );

    const origin = composeOrigin as string;
    requireLoopbackOrigin(origin);

    await page.goto(origin);
    await page.getByLabel("Login").fill("admin");
    await page.getByLabel("Password").fill("admin");
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.goto(`${origin}/#/access`);
    const secretRegistration = section(page, "Register where a secret lives");
    await field(secretRegistration, "External secret reference").fill(
      "env:CASEWEAVER_OPENROUTER_KEY",
    );
    await secretRegistration
      .getByRole("button", { name: "Register reference" })
      .click();
    await expect(
      secretRegistration.getByText(/is available for descriptor forms\./u),
    ).toBeVisible();

    await page.goto(`${origin}/#/ai`);
    const providerDraft = section(page, "Configure an AI provider");
    await selectOption(
      page,
      providerDraft,
      "Registered type",
      /OpenAI-compatible/u,
    );
    await field(providerDraft, "Instance display name").fill(providerName);
    await field(providerDraft, "HTTPS endpoint").fill(
      "https://openrouter.ai/api/v1",
    );
    await selectOption(
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

    const binding = section(page, "Create a model binding draft");
    await selectOption(page, binding, "Active provider instance", providerName);
    await binding
      .getByRole("button", { name: "Refresh models available from provider" })
      .click();
    await expect(
      page.getByText(/Provider model inventory was refreshed\./u),
    ).toBeVisible({ timeout: 60_000 });
    await selectOption(page, binding, "Role", "embedding");
    await field(binding, "Filter provider models").fill(embeddingModel);
    await expect(field(binding, "Model available from provider")).toContainText(
      embeddingModel,
      { timeout: 30_000 },
    );
    await selectOption(
      page,
      binding,
      "Model available from provider",
      embeddingModel,
    );
    await field(binding, "Maximum input tokens (optional)").fill("128");
    await binding.getByRole("button", { name: "Create binding draft" }).click();
    await expect(
      page.getByText(/Binding draft .* was created\./u),
    ).toBeVisible();
    const bindingVersionId = await activateBindingAndGetVersionId(
      page,
      binding,
    );
    await setExactRoleDefault(page, "embedding", bindingVersionId);

    const pricing = section(page, "Add a workspace pricing override");
    await selectOption(
      page,
      pricing,
      "Provider inventory model",
      embeddingModel,
    );
    await field(pricing, "Input price amount").fill("0.000001");
    await pricing
      .getByRole("button", { name: "Create pricing override" })
      .click();
    await expect(page.getByText(/was created\./u)).toBeVisible();

    const budget = section(page, "Replace budget policy");
    await selectExistingWorkspaceBudget(page, budget);
    await field(budget, "Limit amount").fill("0.05");
    await budget.getByRole("button", { name: "Save budget policy" }).click();
    await expect(page.getByText(/was saved\./u)).toBeVisible();

    const capabilityTest = section(page, "Metered provider capability test");
    await selectOption(
      page,
      capabilityTest,
      "Active provider instance",
      providerName,
    );
    const previewResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/capability-tests/provider.test/previews"),
    );
    await capabilityTest
      .getByRole("button", { name: "Preview provider test impact" })
      .click();
    await expect((await previewResponse).status()).toBe(200);
    await expect(
      capabilityTest.getByRole("button", {
        name: "Confirm and run provider test",
      }),
    ).toBeVisible();
    await capabilityTest
      .getByRole("button", { name: "Confirm and run provider test" })
      .click();
    await expect(page.getByText("Provider test succeeded.")).toBeVisible({
      timeout: 60_000,
    });

    await page.goto(`${origin}/#/knowledge-analysis`);
    const collection = section(page, "Create a collection");
    await field(collection, "Collection ID").fill(collectionId);
    await field(collection, "Embedding profile version").fill("live-v1");
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
    await field(connectorDraft, "Instance display name").fill(sourceName);
    await selectOption(
      page,
      connectorDraft,
      "Repository location",
      "Trusted local repository",
    );
    await field(connectorDraft, "Repository local path").fill(
      "/mnt/caseweaver/repositories/documentation",
    );
    await field(connectorDraft, "Allowed local roots").fill(
      "/mnt/caseweaver/repositories",
    );
    await selectOption(page, connectorDraft, "Git reference type", "Branch");
    await field(connectorDraft, "Git reference name").fill("main");
    await connectorDraft
      .getByRole("button", { name: /^Content .*advanced$/u })
      .click();
    await field(connectorDraft, "Path filters").fill(
      '{"include":["Cloud/docs/AllAnswered/development/pages/automation/automation-test-knowledge-base/autoit.md"],"exclude":[]}',
    );
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

    const connectorInstances = section(page, "Connector instances");
    await connectorInstances.getByRole("button", { name: "Activate" }).click();
    await confirmOperation(page, { unmountsOnSuccess: true });

    const sourceDraft = section(page, "Create an inert source draft");
    await field(sourceDraft, "Source display name").fill(sourceName);
    await selectOption(
      page,
      sourceDraft,
      "Active connector instance",
      sourceName,
    );
    await selectOption(page, sourceDraft, "Knowledge collection", collectionId);
    const sourceDraftResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/knowledge-sources/drafts"),
    );
    await sourceDraft
      .getByRole("button", { name: "Create source draft" })
      .click();
    const createdSourceDetail: unknown = await (
      await sourceDraftResponse
    ).json();
    if (
      typeof createdSourceDetail !== "object" ||
      createdSourceDetail === null ||
      !("id" in createdSourceDetail) ||
      typeof createdSourceDetail.id !== "string"
    ) {
      throw new Error("The source-draft response did not identify its source.");
    }
    const sourceId = createdSourceDetail.id;
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

    const knowledgeSources = section(page, "Knowledge sources");
    const sourceEntry = knowledgeSources.getByRole("listitem").filter({
      has: page.getByRole("link", {
        name: new RegExp(`^${sourceId}\\s`, "u"),
      }),
    });
    await expect(sourceEntry).toHaveCount(1);
    await sourceEntry.getByRole("button", { name: "Synchronize" }).click();
    await confirmOperation(page);
    await expect(
      page.getByText(
        /The source synchronization was queued with its immutable configuration version\./u,
      ),
    ).toBeVisible();

    const storage = await page.evaluate(() =>
      JSON.stringify({
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
      }).toLowerCase(),
    );
    expect(storage).not.toContain("caseweaver_openrouter_key");
    expect(storage).not.toContain("access_token");
    expect(storage).not.toContain("refresh_token");
  });
});
