import type {
  AiProviderDispatcher,
  EmbeddingRequest,
  EmbeddingResult,
  GenerationRequest,
  GenerationResult,
  ProviderInvocation,
  ProviderResult,
  RepositoryAgentRequest,
  RepositoryAgentResult,
  RerankerRequest,
  RerankerResult,
  VisionRequest,
  VisionResult,
} from "./contracts.js";

type Handler<TRequest, TResult> = (
  invocation: ProviderInvocation<TRequest>,
) => Promise<ProviderResult<TResult>>;

export interface DeterministicProviderHandlers {
  readonly embed?: Handler<EmbeddingRequest, EmbeddingResult>;
  readonly analyzeVision?: Handler<VisionRequest, VisionResult>;
  readonly generate?: Handler<GenerationRequest, GenerationResult>;
  readonly rerank?: Handler<RerankerRequest, RerankerResult>;
  readonly runRepositoryAgent?: Handler<
    RepositoryAgentRequest,
    RepositoryAgentResult
  >;
}

export interface DeterministicProviderCall {
  readonly operation: string;
  readonly bindingVersionId: string;
}

export class DeterministicAiProviderDispatcher implements AiProviderDispatcher {
  public readonly calls: DeterministicProviderCall[] = [];

  public constructor(
    private readonly handlers: DeterministicProviderHandlers,
  ) {}

  public embed(
    invocation: ProviderInvocation<EmbeddingRequest>,
  ): Promise<ProviderResult<EmbeddingResult>> {
    return this.call("embedding", invocation, this.handlers.embed);
  }

  public analyzeVision(
    invocation: ProviderInvocation<VisionRequest>,
  ): Promise<ProviderResult<VisionResult>> {
    return this.call("vision", invocation, this.handlers.analyzeVision);
  }

  public generate(
    invocation: ProviderInvocation<GenerationRequest>,
  ): Promise<ProviderResult<GenerationResult>> {
    return this.call("generation", invocation, this.handlers.generate);
  }

  public rerank(
    invocation: ProviderInvocation<RerankerRequest>,
  ): Promise<ProviderResult<RerankerResult>> {
    return this.call("reranker", invocation, this.handlers.rerank);
  }

  public runRepositoryAgent(
    invocation: ProviderInvocation<RepositoryAgentRequest>,
  ): Promise<ProviderResult<RepositoryAgentResult>> {
    return this.call(
      "repositoryAgent",
      invocation,
      this.handlers.runRepositoryAgent,
    );
  }

  private async call<TRequest, TResult>(
    operation: string,
    invocation: ProviderInvocation<TRequest>,
    handler: Handler<TRequest, TResult> | undefined,
  ): Promise<ProviderResult<TResult>> {
    this.calls.push(
      Object.freeze({
        operation,
        bindingVersionId: invocation.binding.bindingVersionId,
      }),
    );
    if (handler === undefined) {
      throw new Error(
        `No deterministic handler was configured for ${operation}.`,
      );
    }
    return handler(invocation);
  }
}
