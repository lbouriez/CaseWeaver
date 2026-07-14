import type {
  ApplicationTransaction,
  Clock,
  ResourceLeaseStore,
  UnitOfWork,
} from "@caseweaver/application";
import {
  correlationId,
  causationId,
  outboxEnvelopeId,
  publicationIntentId,
  type PublicationIntent,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import type {
  AnalysisDestination,
  FindPublicationRequest,
  PublishRequest,
  PublishResult,
} from "@caseweaver/connector-sdk";
import { describe, expect, it } from "vitest";

import type {
  PublicationAttempt,
  PublicationCandidate,
  PublicationExecutionStore,
} from "./ports.js";
import { createPublicationIdentity } from "./identity.js";
import { InMemoryPublicationDestinationResolver } from "./fakes.js";
import { StructuredAnalysisPublicationRenderer } from "./renderer.js";
import { PublicationExecutor } from "./use-cases.js";

const now = utcInstant("2026-07-14T16:00:00.000Z");
const workspace = workspaceId("workspace-1");
const analysis = {
  summary: "The required service role is missing.",
  probableCauses: [
    {
      statement: "A deployment removed the required role.",
      evidenceIds: [],
      hypothesis: true,
    },
  ],
  investigation: [],
  recommendedActions: [
    {
      statement: "Restore the service role.",
      evidenceIds: [],
      hypothesis: true,
    },
  ],
  evidence: [],
  unansweredQuestions: [],
  confidence: "high" as const,
};

function candidate(
  state: PublicationIntent["state"] = "pending",
): PublicationCandidate {
  const identity = createPublicationIdentity({
    workspaceId: workspace,
    analysisResultId: "analysis-result-1",
    publicationProfileId: "profile-1",
    publicationProfileVersion: "1",
    destinationConnectorInstanceId: "helpdesk-1",
    target: {
      connectorInstanceId: "helpdesk-1",
      resourceType: "case",
      externalId: "case-1",
    },
  });
  return {
    intent: {
      id: publicationIntentId("intent-1"),
      workspaceId: workspace,
      analysisJobId: "analysis-job-1" as PublicationIntent["analysisJobId"],
      state,
      createdAt: now,
      updatedAt: now,
    },
    analysisResultId: "analysis-result-1",
    identityHash: identity.identityHash,
    marker: identity.marker,
    analysis,
    profile: {
      id: "profile-1",
      version: "1",
      destination: { connectorInstanceId: "helpdesk-1" },
      renderer: { id: "structured", version: "1", format: "markdown" },
      notices: { disclaimers: [] },
      policy: { mode: "autoPublishInternal", visibility: "internal" },
      limits: { maximumBodyCharacters: 10_000 },
    },
    target: {
      connectorInstanceId: "helpdesk-1",
      resourceType: "case",
      externalId: "case-1",
    },
  };
}

class DirectUnitOfWork implements UnitOfWork {
  public async transaction<Result>(
    operation: (transaction: ApplicationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation({} as ApplicationTransaction);
  }
}

class LeaseStore implements ResourceLeaseStore {
  public acquired = 0;

  public async acquire() {
    this.acquired += 1;
    return { fencingToken: BigInt(this.acquired), expiresAt: now };
  }

  public async complete(): Promise<boolean> {
    return true;
  }
}

class Store implements PublicationExecutionStore {
  public state: PublicationIntent["state"] = "pending";
  public attempts = 0;
  public published = 0;
  public unknown = 0;

  public async findCandidate(): Promise<PublicationCandidate> {
    return candidate(this.state);
  }

  public async prepare(
    _transaction: ApplicationTransaction,
    input: Parameters<PublicationExecutionStore["prepare"]>[1],
  ): Promise<PublicationAttempt | undefined> {
    const allowed =
      this.state === "pending" ||
      this.state === "failed" ||
      (this.state === "outcomeUnknown" && input.allowOutcomeUnknown);
    if (!allowed) return undefined;
    this.state = "publishing";
    this.attempts += 1;
    return { id: `attempt-${this.attempts}` };
  }

  public async recordPublished(): Promise<void> {
    this.state = "published";
    this.published += 1;
  }

  public async recordOutcomeUnknown(): Promise<void> {
    this.state = "outcomeUnknown";
    this.unknown += 1;
  }

  public async recordFailure(): Promise<void> {
    this.state = "failed";
  }

  public async findOutcomeUnknown(): Promise<
    readonly ReturnType<typeof publicationIntentId>[]
  > {
    return this.state === "outcomeUnknown"
      ? [publicationIntentId("intent-1")]
      : [];
  }
}

class RemoteSucceededButTimedOut implements AnalysisDestination {
  public publishes = 0;
  private existing: {
    readonly reference: {
      readonly connectorInstanceId: string;
      readonly resourceType: string;
      readonly externalId: string;
    };
    readonly marker: { readonly value: string };
  } | null = null;

  public async findPublication(request: FindPublicationRequest) {
    return this.existing?.marker.value === request.marker.value
      ? this.existing
      : null;
  }

  public async publish(request: PublishRequest): Promise<PublishResult> {
    this.publishes += 1;
    this.existing = {
      marker: request.marker,
      reference: {
        connectorInstanceId: request.target.connectorInstanceId,
        resourceType: "comment",
        externalId: "comment-1",
      },
    };
    return { status: "outcome_unknown", requestId: request.requestId };
  }
}

function command(type: "publication.execute.v1" | "publication.reconcile.v1") {
  return {
    id: outboxEnvelopeId(`outbox-${type}`),
    kind: "command" as const,
    type,
    schemaVersion: 1 as const,
    workspaceId: workspace,
    occurredAt: now,
    correlationId: correlationId("correlation-1"),
    causationId: causationId("cause-1"),
    payload: { publicationIntentId: publicationIntentId("intent-1") },
  };
}

describe("PublicationExecutor", () => {
  it("reconciles a remote-success/local-timeout before another write", async () => {
    const store = new Store();
    const destination = new RemoteSucceededButTimedOut();
    const destinations = new InMemoryPublicationDestinationResolver();
    destinations.register("helpdesk-1", destination);
    const executor = new PublicationExecutor({
      unitOfWork: new DirectUnitOfWork(),
      store,
      leases: new LeaseStore(),
      destinations,
      renderer: new StructuredAnalysisPublicationRenderer(),
      clock: { now: () => now } satisfies Clock,
      leaseMs: 1_000,
    });
    const signal = new AbortController().signal;

    await expect(
      executor.execute(command("publication.execute.v1"), signal),
    ).resolves.toEqual({
      published: false,
      attempted: true,
    });
    expect(store.state).toBe("outcomeUnknown");
    expect(destination.publishes).toBe(1);

    await expect(
      executor.execute(command("publication.reconcile.v1"), signal),
    ).resolves.toEqual({ published: true, attempted: true });
    expect(store.state).toBe("published");
    expect(destination.publishes).toBe(1);
  });

  it("does not publish a terminal intent again", async () => {
    const store = new Store();
    const destination = new RemoteSucceededButTimedOut();
    const destinations = new InMemoryPublicationDestinationResolver();
    destinations.register("helpdesk-1", destination);
    const executor = new PublicationExecutor({
      unitOfWork: new DirectUnitOfWork(),
      store,
      leases: new LeaseStore(),
      destinations,
      renderer: new StructuredAnalysisPublicationRenderer(),
      clock: { now: () => now } satisfies Clock,
      leaseMs: 1_000,
    });
    const signal = new AbortController().signal;

    await executor.execute(command("publication.execute.v1"), signal);
    await executor.execute(command("publication.reconcile.v1"), signal);
    await expect(
      executor.execute(command("publication.execute.v1"), signal),
    ).resolves.toEqual({ published: false, attempted: false });
  });
});
