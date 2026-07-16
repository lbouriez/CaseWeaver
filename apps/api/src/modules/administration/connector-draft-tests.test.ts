import { gitMarkdownAdministrationDescriptor } from "@caseweaver/connector-git-markdown";
import { jitbitAdministrationDescriptor } from "@caseweaver/connector-jitbit";
import { describe, expect, it } from "vitest";

import { createConnectorDraftTestRegistrations } from "./connector-draft-tests.js";

describe("connector draft-test registrations", () => {
  it("pins each test operation to its adapter-owned current descriptor revision", () => {
    const versions = Object.fromEntries(
      createConnectorDraftTestRegistrations({}).map((registration) => [
        registration.descriptorType,
        registration.descriptorVersion,
      ]),
    );

    expect(versions).toEqual({
      "git-markdown": gitMarkdownAdministrationDescriptor.version,
      jitbit: jitbitAdministrationDescriptor.version,
    });
  });
});
