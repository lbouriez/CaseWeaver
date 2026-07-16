import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiClientProvider } from "../api/context.js";
import { SecretReferenceRegistration } from "./secret-reference-registration.js";

describe("SecretReferenceRegistration", () => {
  it("submits only an opaque locator and clears the transient field after success", async () => {
    const client = {
      createSecretReference: vi.fn(async () => ({
        id: "credential-1",
        label: "Secret reference credential-1",
        status: "active",
        fields: {},
      })),
    };
    const onRegistered = vi.fn();
    const user = userEvent.setup();
    render(
      <ApiClientProvider client={client as never}>
        <SecretReferenceRegistration onRegistered={onRegistered} />
      </ApiClientProvider>,
    );

    const reference = screen.getByRole("textbox", {
      name: "External secret reference",
    });
    await user.type(reference, "env:GITHUB_TOKEN");
    await user.click(
      screen.getByRole("button", { name: "Register reference" }),
    );

    await waitFor(() =>
      expect(client.createSecretReference).toHaveBeenCalledWith({
        reference: "env:GITHUB_TOKEN",
      }),
    );
    expect(onRegistered).toHaveBeenCalledOnce();
    expect((reference as HTMLInputElement).value).toBe("");
    expect(screen.queryByDisplayValue("env:GITHUB_TOKEN")).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: /password|credential value/iu }),
    ).toBeNull();
  });

  it("clears the locator after a rejected registration without offering a secret-value field", async () => {
    const client = {
      createSecretReference: vi.fn(async () => {
        throw new Error("registration rejected");
      }),
    };
    const user = userEvent.setup();
    render(
      <ApiClientProvider client={client as never}>
        <SecretReferenceRegistration onRegistered={vi.fn()} />
      </ApiClientProvider>,
    );

    const reference = screen.getByRole("textbox", {
      name: "External secret reference",
    });
    await user.type(reference, "env:JITBIT_API_TOKEN");
    await user.click(
      screen.getByRole("button", { name: "Register reference" }),
    );

    await waitFor(() => expect((reference as HTMLInputElement).value).toBe(""));
    expect(client.createSecretReference).toHaveBeenCalledWith({
      reference: "env:JITBIT_API_TOKEN",
    });
    expect(
      screen.queryByRole("textbox", { name: /password|credential value/iu }),
    ).toBeNull();
  });
});
