import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiClientProvider } from "../api/context.js";
import type { RepositoryAnalysisOptions } from "../api/contracts.js";
import { RepositoryAnalysisWorkflows } from "./repository-analysis-workflows.js";

const option = (id: string) => ({
  id,
  versionId: `${id}-v1`,
  label: id,
  lifecycle: "active" as const,
  eligibleForDraft: true,
  eligibleForActivation: true,
});

const options: RepositoryAnalysisOptions = {
  codeRepositories: [],
  repositoryExecutionPolicies: [],
  attachmentPolicies: [],
  analysisProfiles: [],
  retrievalProfiles: [],
  promptProfiles: [],
  publicationProfiles: [],
  repositoryAgentBindings: [],
  analysisBindings: [],
  visionBindings: [],
  analysisRecipes: [],
  caseAnalysisTriggers: [],
  caseSources: [],
  webhookEndpoints: [],
  checkoutSecretReferences: [
    {
      secretReferenceId: "checkout-reference",
      label: "Registered checkout access",
      lifecycle: "active",
      eligibleForDraft: true,
      eligibleForActivation: true,
    },
  ],
  mountedRepositories: [
    {
      id: "support-mount",
      label: "Support repository mount",
      eligibleForDraft: true,
      eligibleForActivation: true,
    },
  ],
  sandboxPolicies: [
    {
      id: "sandbox-policy",
      label: "Read-only sandbox",
      eligibleForDraft: true,
      eligibleForActivation: true,
    },
  ],
  attachmentProcessorSecurityPolicies: [
    {
      id: "attachment-security",
      label: "Attachment security policy",
      eligibleForDraft: true,
      eligibleForActivation: true,
    },
  ],
};

describe("RepositoryAnalysisWorkflows", () => {
  it("submits the typed immutable repository command and clears the transient URL", async () => {
    const user = userEvent.setup();
    const createRepositoryAnalysisDraft = vi.fn(async () => ({
      id: "repository-1",
      versionId: "repository-version-1",
      lifecycle: "draft" as const,
      revision: 1,
      idempotency: "created" as const,
    }));
    const client = {
      repositoryAnalysisOptions: vi.fn(async () => options),
      createRepositoryAnalysisDraft,
    };
    render(
      <ApiClientProvider client={client as never}>
        <RepositoryAnalysisWorkflows section="repository" />
      </ApiClientProvider>,
    );

    await screen.findByText("Create a code repository draft");
    await user.type(
      screen.getByRole("textbox", { name: "Repository display name" }),
      "Support service",
    );
    const url = "https://code.example.org/support/service.git";
    await user.type(
      screen.getByRole("textbox", { name: "Remote repository URL" }),
      url,
    );
    await user.click(
      screen.getByRole("button", { name: "Create repository draft" }),
    );

    await waitFor(() =>
      expect(createRepositoryAnalysisDraft).toHaveBeenCalledWith({
        resource: "code-repositories",
        displayName: "Support service",
        location: { mode: "remoteHttps", remoteUrl: url },
        allowedRefKinds: ["branch"],
        checkoutRef: { kind: "branch", name: "main" },
      }),
    );
    expect(
      (
        screen.getByRole("textbox", {
          name: "Remote repository URL",
        }) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(document.body.textContent).not.toContain(url);
  }, 20_000);

  it("offers the vision role, never the analysis role, to attachment policies", async () => {
    const client = {
      repositoryAnalysisOptions: vi.fn(async () => ({
        ...options,
        analysisBindings: [option("analysis-binding")],
        visionBindings: [option("vision-binding")],
      })),
    };
    render(
      <ApiClientProvider client={client as never}>
        <RepositoryAnalysisWorkflows section="knowledge" />
      </ApiClientProvider>,
    );

    await screen.findByText("Create an attachment handling policy draft");
    await userEvent
      .setup()
      .click(screen.getByRole("combobox", { name: "Vision binding" }));
    expect(
      await screen.findByRole("option", { name: "vision-binding" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("option", { name: "analysis-binding" }),
    ).toBeNull();
  });
});
