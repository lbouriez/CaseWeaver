import { describe, expect, it } from "vitest";

import {
  parseConfigurationHistoryQuery,
  toConfigurationHistoryPageDto,
  toConfigurationInspectionDto,
  toConfigurationSurfaceDto,
} from "./configuration-inspection.js";

const timestamp = "2026-07-15T12:00:00.000Z";
const digest = "a".repeat(64);

describe("configuration inspection contracts", () => {
  it("projects only allowlisted immutable metadata without settings, secrets, locators, or URLs", () => {
    const dto = toConfigurationInspectionDto({
      id: "configuration-1",
      resourceType: "connector-instances",
      lifecycle: "active",
      revision: 2,
      updatedAt: timestamp,
      currentVersionId: "version-2",
      currentVersion: {
        id: "version-2",
        version: 2,
        createdAt: timestamp,
        canonicalSettingsSha256: digest,
        secretReferenceCount: 1,
        descriptor: { kind: "connector", type: "git-markdown", version: "v1" },
        canonicalSettings: { token: "must-not-leak" },
        secretReferenceIds: ["credential-1"],
        objectKey: "private/configuration.json",
        signedDownloadUrl: "https://storage.example/private",
      },
      rawSettings: { password: "must-not-leak" },
      credentialReference: "vault:must-not-leak",
    });

    expect(dto).toEqual({
      id: "configuration-1",
      resourceType: "connector-instances",
      lifecycle: "active",
      revision: 2,
      updatedAt: timestamp,
      currentVersionId: "version-2",
      currentVersion: {
        id: "version-2",
        version: 2,
        createdAt: timestamp,
        canonicalSettingsSha256: digest,
        secretReferenceCount: 1,
        descriptor: { kind: "connector", type: "git-markdown", version: "v1" },
      },
    });
    expect(JSON.stringify(dto)).not.toMatch(
      /must-not-leak|objectKey|signedDownloadUrl|credentialReference/u,
    );
  });

  it("rejects inconsistent current-version and lifecycle metadata", () => {
    expect(() =>
      toConfigurationInspectionDto({
        id: "configuration-1",
        resourceType: "connector-instances",
        lifecycle: "active",
        revision: 1,
        updatedAt: timestamp,
        currentVersionId: "version-2",
        currentVersion: {
          id: "version-1",
          version: 2,
          createdAt: timestamp,
          canonicalSettingsSha256: digest,
          secretReferenceCount: 0,
        },
      }),
    ).toThrow(/Current version/u);
    expect(() =>
      toConfigurationInspectionDto({
        id: "configuration-1",
        resourceType: "connector-instances",
        lifecycle: "rewritten",
        revision: 1,
        updatedAt: timestamp,
      }),
    ).toThrow();
  });

  it("requires bounded opaque history queries and newest-first immutable version pages", () => {
    expect(parseConfigurationHistoryQuery({})).toEqual({ limit: 25 });
    expect(() => parseConfigurationHistoryQuery({ limit: 101 })).toThrow();
    expect(() =>
      parseConfigurationHistoryQuery({ after: "not/a-cursor" }),
    ).toThrow();

    const page = toConfigurationHistoryPageDto({
      items: [
        {
          id: "version-2",
          version: 2,
          createdAt: timestamp,
          canonicalSettingsSha256: digest,
          secretReferenceCount: 0,
        },
        {
          id: "version-1",
          version: 1,
          createdAt: timestamp,
          canonicalSettingsSha256: digest,
          secretReferenceCount: 0,
        },
      ],
      page: { hasNextPage: true, endCursor: "cursor_2" },
    });
    expect(page.items.map((item) => item.id)).toEqual([
      "version-2",
      "version-1",
    ]);
    expect(() =>
      toConfigurationHistoryPageDto({
        items: [
          {
            id: "version-1",
            version: 1,
            createdAt: timestamp,
            canonicalSettingsSha256: digest,
            secretReferenceCount: 0,
          },
          {
            id: "version-2",
            version: 2,
            createdAt: timestamp,
            canonicalSettingsSha256: digest,
            secretReferenceCount: 0,
          },
        ],
        page: { hasNextPage: false },
      }),
    ).toThrow(/newest first/u);
  });

  it("allows only declared feature workflows and explicit safe non-managed states", () => {
    expect(
      toConfigurationSurfaceDto({
        surface: "connector-instances",
        mode: "managed",
        configurationId: "configuration-1",
        workflows: ["create_draft", "activate", "disable", "inspect_history"],
        operationalActions: [],
      }),
    ).toMatchObject({ mode: "managed" });
    expect(
      toConfigurationSurfaceDto({
        surface: "ai-budget-policies",
        mode: "managed",
        configurationId: "configuration-2",
        workflows: ["create", "replace", "inspect_history"],
        operationalActions: [],
      }),
    ).toMatchObject({
      mode: "managed",
      workflows: ["create", "replace", "inspect_history"],
    });
    expect(
      toConfigurationSurfaceDto({
        surface: "platform",
        mode: "read_only",
        reasonCode: "deployment_owned",
        reason: "Configured by the deployment.",
        workflows: [],
        operationalActions: [],
      }),
    ).toMatchObject({ mode: "read_only" });
    expect(() =>
      toConfigurationSurfaceDto({
        surface: "schedules",
        mode: "unavailable",
        reasonCode: "workflow_not_composed",
        reason: "The workflow is not available.",
        workflows: ["create_draft"],
        operationalActions: [],
      }),
    ).toThrow(/cannot advertise/u);
    expect(() =>
      toConfigurationSurfaceDto({
        surface: "platform",
        mode: "read_only",
        reasonCode: "deployment_owned",
        reason: "See https://private.example/ for details.",
        workflows: [],
        operationalActions: [],
      }),
    ).toThrow(/safe/u);
  });

  it("keeps operational commands separate from non-existent configuration forms", () => {
    expect(
      toConfigurationSurfaceDto({
        surface: "knowledge-sources",
        mode: "read_only",
        reasonCode: "workflow_not_composed",
        reason: "Source definition changes are not available.",
        workflows: [],
        operationalActions: ["source.synchronize", "source.fullRescan"],
      }),
    ).toMatchObject({
      mode: "read_only",
      workflows: [],
      operationalActions: ["source.synchronize", "source.fullRescan"],
    });
    expect(() =>
      toConfigurationSurfaceDto({
        surface: "knowledge-sources",
        mode: "read_only",
        reasonCode: "workflow_not_composed",
        reason: "Source definition changes are not available.",
        workflows: [],
        operationalActions: ["source.synchronize", "source.synchronize"],
      }),
    ).toThrow(/unique/u);
  });
});
