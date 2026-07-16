import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiClientProvider } from "../api/context.js";
import { KnowledgeCollectionAuthoring } from "./knowledge-collection-authoring.js";

describe("KnowledgeCollectionAuthoring", () => {
  it("selects an active embedding binding and creates an immutable collection", async () => {
    const client = {
      list: vi.fn(async () => ({
        items: [
          { id: "analysis-1", label: "analysis", status: "active" },
          { id: "embedding-1", label: "embedding", status: "active" },
          { id: "embedding-draft", label: "embedding", status: "draft" },
        ],
        page: { hasNextPage: false },
      })),
      createKnowledgeCollection: vi.fn(async () => ({
        id: "support-knowledge",
        label: "support-knowledge",
        status: "active",
        fields: {},
      })),
    };
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(
      <ApiClientProvider client={client as never}>
        <KnowledgeCollectionAuthoring enabled onCreated={onCreated} />
      </ApiClientProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Active embedding binding" })
          .textContent,
      ).toContain("embedding-1"),
    );
    await user.type(
      screen.getByRole("textbox", { name: /^Collection ID/u }),
      "support-knowledge",
    );
    await user.type(
      screen.getByRole("textbox", { name: /^Embedding profile version/u }),
      "profile-v1",
    );
    await user.type(
      screen.getByRole("spinbutton", { name: /^Embedding dimensions/u }),
      "3",
    );
    await user.click(
      screen.getByRole("button", { name: "Create immutable collection" }),
    );

    await waitFor(() =>
      expect(client.createKnowledgeCollection).toHaveBeenCalledWith({
        collectionId: "support-knowledge",
        embeddingBindingId: "embedding-1",
        embeddingProfileVersion: "profile-v1",
        dimensions: 3,
      }),
    );
    expect(onCreated).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(client.createKnowledgeCollection.mock.calls),
    ).not.toMatch(/secret|token|password|locator/iu);
  });

  it("explains the permanent vector-space fields through accessible information controls", async () => {
    const client = {
      list: vi.fn(async () => ({
        items: [{ id: "embedding-1", label: "embedding", status: "active" }],
        page: { hasNextPage: false },
      })),
    };
    const user = userEvent.setup();
    render(
      <ApiClientProvider client={client as never}>
        <KnowledgeCollectionAuthoring enabled onCreated={vi.fn()} />
      </ApiClientProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Active embedding binding" })
          .textContent,
      ).toContain("embedding-1"),
    );
    await user.click(
      screen.getByRole("button", { name: "Help for Embedding dimensions" }),
    );
    expect(screen.getByText(/number of values in each vector/u)).not.toBeNull();
  });
});
