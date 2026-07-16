import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PolicyProfileDraftForm } from "./policy-profile-draft-form.js";

describe("policy profile draft form", () => {
  it("submits a provider-neutral retrieval policy object without a secret field", async () => {
    localStorage.clear();
    const createPolicyProfileDraft = vi.fn(async () => ({
      id: "retrieval-profile-1",
      label: "Support evidence",
      status: "draft",
      version: "1",
      fields: {},
    }));
    render(
      <PolicyProfileDraftForm
        client={{ createPolicyProfileDraft } as never}
        onCompleted={vi.fn()}
        resource="retrieval-profiles"
      />,
    );
    const user = userEvent.setup();
    expect(
      (
        screen.getByLabelText(
          /^Retrieval profile display name/u,
        ) as HTMLInputElement
      ).maxLength,
    ).toBe(160);

    await user.type(
      screen.getByLabelText(/^Retrieval profile display name/u),
      "Support evidence",
    );
    fireEvent.change(screen.getByLabelText(/^Retrieval policy settings/u), {
      target: { value: '{"maximumEvidence":12}' },
    });
    await user.click(
      screen.getByRole("button", { name: "Create retrieval profile draft" }),
    );

    await waitFor(() =>
      expect(createPolicyProfileDraft).toHaveBeenCalledWith(
        "retrieval-profiles",
        {
          displayName: "Support evidence",
          settings: { maximumEvidence: 12 },
        },
      ),
    );
    expect(JSON.stringify(createPolicyProfileDraft.mock.calls)).not.toMatch(
      /secret|token|password|locator/iu,
    );
    expect(localStorage.length).toBe(0);
  });

  it("rejects credential-shaped prompt policy JSON without retaining its value", async () => {
    const createPolicyProfileDraft = vi.fn();
    render(
      <PolicyProfileDraftForm
        client={{ createPolicyProfileDraft } as never}
        onCompleted={vi.fn()}
        resource="prompt-profiles"
      />,
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/^Prompt profile display name/u),
      "Triage prompt",
    );
    fireEvent.change(screen.getByLabelText(/^Prompt policy settings/u), {
      target: { value: '{"policy":{"token":"must-not-be-retained"}}' },
    });
    await user.click(
      screen.getByRole("button", { name: "Create prompt profile draft" }),
    );

    expect(createPolicyProfileDraft).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).not.toBeNull();
    expect(document.body.textContent).not.toContain("must-not-be-retained");
    expect(
      (screen.getByLabelText(/^Prompt policy settings/u) as HTMLTextAreaElement)
        .value,
    ).toBe("{}");
  });
});
