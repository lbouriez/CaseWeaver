import {
  ConnectorCancelledError,
  ConnectorProtocolError,
  type ConnectorSecretResolver,
  type ConnectorSecretReference,
  type ResolvedSecret,
} from "@caseweaver/connector-sdk";

import {
  type GitMarkdownConfiguration,
  gitMarkdownConfigurationSchema,
} from "./config.js";
import type {
  DiffGitRepositoryRequest,
  GitRepository,
  GitRepositoryDelta,
  GitRepositoryFile,
  GitRepositorySnapshot,
  InspectGitRepositoryRequest,
  ReadGitRepositoryFileRequest,
} from "./git-repository.js";

export interface FakeGitFile {
  readonly path: string;
  readonly blobOid: string;
  readonly content: string;
}

export interface FakeGitSnapshot {
  readonly ref: `${"branch" | "tag"}:${string}`;
  readonly commitSha: string;
  readonly files: readonly FakeGitFile[];
}

export class FakeGitRepository implements GitRepository {
  public readonly inspectCalls: Array<
    Readonly<{ ref: string; authenticated: boolean }>
  > = [];
  public readonly readCalls: Array<
    Readonly<{
      ref: string;
      path: string;
      commitSha: string;
      authenticated: boolean;
    }>
  > = [];

  private readonly snapshots = new Map<string, FakeGitSnapshot>();
  private readonly history = new Map<string, FakeGitSnapshot>();

  public constructor(snapshots: readonly FakeGitSnapshot[]) {
    for (const snapshot of snapshots) {
      this.setSnapshot(snapshot);
    }
  }

  public setSnapshot(snapshot: FakeGitSnapshot): void {
    this.snapshots.set(snapshot.ref, snapshot);
    this.history.set(snapshot.commitSha, snapshot);
  }

  public async inspect(
    request: InspectGitRepositoryRequest,
  ): Promise<GitRepositorySnapshot> {
    this.assertActive(request.signal);
    const ref = `${request.ref.kind}:${request.ref.name}`;
    this.inspectCalls.push({
      ref,
      authenticated: request.authentication.kind === "token",
    });
    const snapshot = this.snapshots.get(ref);
    if (snapshot === undefined) {
      throw new ConnectorProtocolError("The fake Git reference was not found.");
    }
    return {
      commitSha: snapshot.commitSha,
      files: snapshot.files.map(({ path, blobOid }) => ({ path, blobOid })),
    };
  }

  public async readFile(
    request: ReadGitRepositoryFileRequest,
  ): Promise<GitRepositoryFile> {
    this.assertActive(request.signal);
    const ref = `${request.ref.kind}:${request.ref.name}`;
    this.readCalls.push({
      ref,
      path: request.path,
      commitSha: request.commitSha,
      authenticated: request.authentication.kind === "token",
    });
    const snapshot = this.history.get(request.commitSha);
    const file = snapshot?.files.find((entry) => entry.path === request.path);
    if (
      snapshot === undefined ||
      snapshot.ref !== ref ||
      snapshot.commitSha !== request.commitSha ||
      file === undefined
    ) {
      throw new ConnectorProtocolError("The fake Git file was not found.");
    }
    return {
      path: file.path,
      blobOid: file.blobOid,
      commitSha: snapshot.commitSha,
      content: file.content,
    };
  }

  public async diff(
    request: DiffGitRepositoryRequest,
  ): Promise<GitRepositoryDelta> {
    this.assertActive(request.signal);
    const ref = `${request.ref.kind}:${request.ref.name}`;
    const current = this.snapshots.get(ref);
    const previous = this.history.get(request.fromCommitSha);
    if (current === undefined || previous === undefined) {
      throw new ConnectorProtocolError(
        "The fake Git diff could not be resolved.",
      );
    }

    const previousFiles = new Map(
      previous.files.map((file) => [file.path, file]),
    );
    const currentFiles = new Map(
      current.files.map((file) => [file.path, file]),
    );
    const changes = [
      ...current.files.flatMap((file) => {
        const prior = previousFiles.get(file.path);
        return prior?.blobOid === file.blobOid
          ? []
          : [
              {
                kind: "upsert" as const,
                path: file.path,
                blobOid: file.blobOid,
              },
            ];
      }),
      ...previous.files.flatMap((file) =>
        currentFiles.has(file.path)
          ? []
          : [{ kind: "tombstone" as const, path: file.path }],
      ),
    ];
    return {
      fromCommitSha: request.fromCommitSha,
      commitSha: current.commitSha,
      changes,
    };
  }

  private assertActive(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new ConnectorCancelledError();
    }
  }
}

export class FakeGitSecretResolver implements ConnectorSecretResolver {
  public readonly references: ConnectorSecretReference[] = [];

  public constructor(private readonly value: string) {}

  public async resolve(
    reference: ConnectorSecretReference,
    signal: AbortSignal,
  ): Promise<ResolvedSecret> {
    if (signal.aborted) throw new ConnectorCancelledError();
    this.references.push(reference);
    return Object.freeze({ value: this.value });
  }
}

export function fixtureOid(character: string): string {
  return character.repeat(40);
}

export function createGitMarkdownConfiguration(
  overrides: Record<string, unknown> = {},
): GitMarkdownConfiguration {
  const { secrets, ...settings } = overrides;
  return gitMarkdownConfigurationSchema.parse({
    schemaVersion: 1,
    connectorType: "git-markdown",
    secrets: secrets ?? {},
    settings: {
      connectorInstanceId: "git-docs",
      repository: {
        kind: "remote",
        url: "https://github.example.invalid/example/docs.git",
      },
      ref: { kind: "branch", name: "main" },
      ...settings,
    },
  });
}
