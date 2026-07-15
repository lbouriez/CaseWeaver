import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiClientProvider } from "../api/context.js";
import { DiagnosticExportPanel } from "./diagnostic-export.js";

const status = {
  id: "diagnostic-export-1",
  status: "requested" as const,
  eventCutoffAt: "2026-07-15T12:00:00.000Z",
  expiresAt: "2026-07-15T13:00:00.000Z",
};

describe("diagnostic export panel", () => {
  it("queues a bounded export and exposes download only after a refreshed ready status", async () => {
    const client = {
      requestDiagnosticExport: vi.fn(async () => status),
      diagnosticExportStatus: vi.fn(async () => ({
        ...status,
        status: "ready" as const,
        generatedAt: "2026-07-15T12:01:00.000Z",
      })),
      downloadDiagnosticExport: vi.fn(async () => new Blob(["{}"])),
    };
    render(
      <ApiClientProvider client={client as never}>
        <DiagnosticExportPanel />
      </ApiClientProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Request diagnostic export" }),
    );
    await screen.findByText("Export diagnostic-export-1: requested");
    expect(
      screen.queryByRole("button", { name: "Download redacted export" }),
    ).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Refresh export status" }),
    );
    await screen.findByText("Export diagnostic-export-1: ready");
    expect(
      screen.getByRole("button", { name: "Download redacted export" }),
    ).toBeTruthy();
    expect(client.requestDiagnosticExport).toHaveBeenCalledOnce();
    expect(client.diagnosticExportStatus).toHaveBeenCalledWith(
      "diagnostic-export-1",
    );
  });
});
