import { sha256CanonicalJson } from "@caseweaver/connector-sdk";
import { describe, expect, it } from "vitest";

import { JitbitClient } from "./client.js";
import { JitbitAnalysisDestination } from "./jitbit-destination.js";
import {
  createJitbitConfiguration,
  createJitbitSecretResolver,
  jsonResponse,
} from "./fakes.js";

function destinationFor(
  responder: (url: URL, init: RequestInit) => Response | Promise<Response>,
): JitbitAnalysisDestination {
  const configuration = createJitbitConfiguration();
  return new JitbitAnalysisDestination({
    configuration,
    client: new JitbitClient({
      configuration,
      secrets: createJitbitSecretResolver(),
      fetch: async (url, init) => responder(new URL(String(url)), init),
    }),
  });
}

function publishRequest(visibility: "internal" | "public" = "internal") {
  return {
    target: {
      connectorInstanceId: "jitbit-helpdesk",
      resourceType: "case",
      externalId: "7",
    },
    marker: { value: "analysis-7" },
    idempotencyKey: "publication-7",
    requestHash: sha256CanonicalJson({ request: 7 }),
    publication: { format: "markdown" as const, body: "Diagnosis", visibility },
    signal: new AbortController().signal,
    requestId: "caseweaver-request-7",
  };
}

describe("JitbitAnalysisDestination", () => {
  it("looks up an exact marker before writing an internal comment and returns its receipt", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const destination = destinationFor((url, init) => {
      calls.push({ url, init });
      return url.pathname === "/api/comments"
        ? jsonResponse([])
        : jsonResponse({ CommentID: 44 });
    });

    await expect(destination.publish(publishRequest())).resolves.toEqual({
      status: "published",
      receipt: {
        reference: {
          connectorInstanceId: "jitbit-helpdesk",
          resourceType: "comment",
          externalId: "44",
        },
        marker: { value: "analysis-7" },
        requestId: "caseweaver-request-7",
      },
    });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/api/comments",
      "/api/comment",
    ]);
    expect(String(calls[1]?.init.body)).toContain("forTechsOnly=true");
    expect(String(calls[1]?.init.body)).toContain(
      "caseweaver-publication%3Aanalysis-7",
    );

    const existing = destinationFor((url) =>
      url.pathname === "/api/comments"
        ? jsonResponse([
            {
              CommentID: 12,
              CommentDate: "2026-07-13T12:00:00Z",
              Body: "Done <!-- caseweaver-publication:analysis-7 -->",
            },
          ])
        : (() => {
            throw new Error("write must not occur");
          })(),
    );
    await expect(existing.publish(publishRequest())).resolves.toMatchObject({
      status: "published",
      receipt: { reference: { externalId: "12" } },
    });
  });

  it("rejects public publication and reports a network-uncertain write without retrying it", async () => {
    const destination = destinationFor(() => jsonResponse([]));
    await expect(destination.publish(publishRequest("public"))).rejects.toThrow(
      /internal comments/,
    );

    const calls: string[] = [];
    const uncertain = destinationFor((url) => {
      calls.push(url.pathname);
      if (url.pathname === "/api/comments") return jsonResponse([]);
      throw new TypeError("connection reset");
    });
    await expect(uncertain.publish(publishRequest())).resolves.toEqual({
      status: "outcome_unknown",
      requestId: "caseweaver-request-7",
    });
    expect(calls).toEqual(["/api/comments", "/api/comment"]);
  });
});
