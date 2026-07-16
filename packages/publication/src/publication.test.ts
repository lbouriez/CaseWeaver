import { workspaceId } from "@caseweaver/domain";
import { describe, expect, it } from "vitest";

import {
  createPublicationIdentity,
  InMemoryAnalysisDestination,
  InMemoryPublicationDestinationResolver,
  type PublicationProfile,
  publicationProfileSchema,
  StructuredAnalysisPublicationRenderer,
} from "./index.js";

const profile = (
  overrides: Partial<PublicationProfile> = {},
): PublicationProfile => ({
  id: "internal-note",
  version: "1",
  destination: { connectorInstanceId: "helpdesk-1" },
  renderer: { id: "structured-analysis", version: "1", format: "markdown" },
  notices: {
    aiDisclosure: "This draft was generated with AI assistance.",
    disclaimers: ["Verify recommendations before applying them."],
  },
  policy: { mode: "autoPublishInternal", visibility: "internal" },
  limits: { maximumBodyCharacters: 10_000 },
  ...overrides,
});

const analysis = {
  summary: "The service account is missing a required role.",
  probableCauses: [
    {
      statement: "The service account role was removed.",
      evidenceIds: [],
      hypothesis: true,
    },
  ],
  investigation: [{ step: "Confirm the account role assignment." }],
  recommendedActions: [
    {
      statement: "Restore the required role.",
      evidenceIds: [],
      hypothesis: true,
    },
  ],
  evidence: [],
  unansweredQuestions: ["Which deployment removed the role?"],
  confidence: "high" as const,
};

describe("publication profile policy", () => {
  it("rejects customer-visible policies at configuration validation", () => {
    expect(() =>
      publicationProfileSchema.parse({
        ...profile(),
        policy: { mode: "autoPublishInternal", visibility: "public" },
      }),
    ).toThrow("Customer-visible publication is not available");
  });
});

describe("publication identity", () => {
  it("is stable for equal immutable inputs and changes with target or profile version", () => {
    const input = {
      workspaceId: "workspace-1",
      analysisResultId: "analysis-result-1",
      publicationProfileId: "internal-note",
      publicationProfileVersion: "1",
      destinationConnectorInstanceId: "helpdesk-1",
      destinationConnectorConfigurationVersionId: "helpdesk-configuration-1",
      target: {
        connectorInstanceId: "helpdesk-1",
        resourceType: "case",
        externalId: "case-1",
      },
    };

    const first = createPublicationIdentity(input);
    expect(createPublicationIdentity({ ...input })).toEqual(first);
    expect(
      createPublicationIdentity({
        ...input,
        target: { ...input.target, externalId: "case-2" },
      }).marker.value,
    ).not.toBe(first.marker.value);
    expect(
      createPublicationIdentity({
        ...input,
        publicationProfileVersion: "2",
      }).identityHash,
    ).not.toBe(first.identityHash);
    expect(
      createPublicationIdentity({
        ...input,
        destinationConnectorInstanceId: "helpdesk-2",
      }).identityHash,
    ).not.toBe(first.identityHash);
    expect(
      createPublicationIdentity({
        ...input,
        destinationConnectorConfigurationVersionId: "helpdesk-configuration-2",
      }).identityHash,
    ).not.toBe(first.identityHash);
    expect(first.marker.value).toMatch(
      /^caseweaver\.publication\.v1\.[a-f0-9]{64}$/u,
    );
  });
});

describe("StructuredAnalysisPublicationRenderer", () => {
  it("renders internal markdown with policy notices in a deterministic order", () => {
    const rendered = new StructuredAnalysisPublicationRenderer().render({
      analysis,
      profile: profile(),
    });

    expect(rendered).toMatchObject({
      format: "markdown",
      visibility: "internal",
    });
    expect(rendered.body).toContain("## Analysis summary");
    expect(rendered.body).toContain("- Restore the required role.");
    expect(rendered.body).toMatch(
      /This draft was generated with AI assistance\.\nVerify recommendations/u,
    );
  });

  it("refuses content that exceeds the configured destination limit", () => {
    expect(() =>
      new StructuredAnalysisPublicationRenderer().render({
        analysis,
        profile: profile({ limits: { maximumBodyCharacters: 10 } }),
      }),
    ).toThrow("Rendered publication exceeds the destination body limit");
  });

  it("escapes structured content before rendering HTML", () => {
    const rendered = new StructuredAnalysisPublicationRenderer().render({
      analysis,
      profile: profile({
        renderer: { id: "structured-analysis", version: "1", format: "html" },
        notices: {
          aiDisclosure: "<script>unsafe()</script>",
          disclaimers: [],
        },
      }),
    });

    expect(rendered.body).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
    expect(rendered.body).not.toContain("<script>");
  });
});

describe("publication fakes", () => {
  it("models destination marker lookup and idempotent repeated writes", async () => {
    const destination = new InMemoryAnalysisDestination();
    const resolver = new InMemoryPublicationDestinationResolver();
    resolver.register("helpdesk-1", destination);
    const identity = createPublicationIdentity({
      workspaceId: "workspace-1",
      analysisResultId: "analysis-result-1",
      publicationProfileId: "internal-note",
      publicationProfileVersion: "1",
      destinationConnectorInstanceId: "helpdesk-1",
      destinationConnectorConfigurationVersionId: "helpdesk-configuration-1",
      target: {
        connectorInstanceId: "helpdesk-1",
        resourceType: "case",
        externalId: "case-1",
      },
    });
    const request = {
      target: {
        connectorInstanceId: "helpdesk-1",
        resourceType: "case",
        externalId: "case-1",
      },
      marker: identity.marker,
      idempotencyKey: identity.idempotencyKey,
      requestHash: identity.requestHash,
      publication: {
        format: "plainText" as const,
        body: "Internal analysis",
        visibility: "internal" as const,
      },
      signal: new AbortController().signal,
    };

    const first = await destination.publish(request);
    const second = await destination.publish(request);

    await expect(
      resolver.resolve({
        workspaceId: workspaceId("workspace-1"),
        connectorRegistrationId: "helpdesk-1",
        connectorConfigurationVersionId: "helpdesk-configuration-1",
        signal: request.signal,
      }),
    ).resolves.toBe(destination);
    expect(resolver.resolveRequests).toEqual([
      {
        workspaceId: workspaceId("workspace-1"),
        connectorRegistrationId: "helpdesk-1",
        connectorConfigurationVersionId: "helpdesk-configuration-1",
      },
    ]);
    expect(first).toMatchObject({ status: "published" });
    expect(second).toEqual(first);
    await expect(
      destination.findPublication({
        target: request.target,
        marker: request.marker,
        signal: request.signal,
      }),
    ).resolves.toMatchObject({ marker: identity.marker });
  });
});
