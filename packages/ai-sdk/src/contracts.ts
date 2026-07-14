export type AiRole =
  | "embedding"
  | "vision"
  | "analysis"
  | "repositoryAgent"
  | "keywordExtraction"
  | "reranker"
  | "chat";

export type AiOperationKind =
  | "embedding"
  | "vision"
  | "generation"
  | "reranker"
  | "repositoryAgent"
  | "repositoryAgentTurn";

export type AiCapability =
  | "vision"
  | "structuredOutput"
  | "tools"
  | "promptCaching"
  | "reranking"
  | "repositoryAgent";

export type AiWireApi =
  | "embeddings"
  | "chatCompletions"
  | "responses"
  | "custom";

export interface AiProviderBinding {
  readonly bindingVersionId: string;
  readonly providerInstanceVersionId: string;
  readonly providerType: string;
  readonly endpoint: string;
  readonly canonicalModel: string;
  readonly wireApi: AiWireApi;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly capabilities: ReadonlySet<AiCapability>;
  readonly secretReference: string;
}

export interface AiSecret {
  readonly value: string;
}

export interface SecretResolver {
  resolve(reference: string, signal: AbortSignal): Promise<AiSecret>;
}

export interface NormalizedUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly imageUnits?: number;
  readonly audioUnits?: number;
}

export interface ProviderReportedCost {
  readonly amount: string;
  readonly currency: string;
}

export interface ProviderResponseMetadata {
  readonly providerRequestId?: string;
  readonly effectiveModel?: string;
  readonly latencyMs?: number;
  readonly retryCount: number;
  readonly rawRedacted?: Readonly<Record<string, unknown>>;
}

export interface ProviderResult<TResult> {
  readonly value: TResult;
  readonly usage?: NormalizedUsage;
  readonly providerCost?: ProviderReportedCost;
  readonly metadata: ProviderResponseMetadata;
}

export interface ProviderInvocation<TRequest> {
  readonly binding: AiProviderBinding;
  readonly secret: AiSecret;
  readonly request: TRequest;
  readonly signal: AbortSignal;
}

export interface EmbeddingRequest {
  readonly input: readonly string[];
  readonly dimensions?: number;
}

export interface EmbeddingResult {
  readonly vectors: readonly (readonly number[])[];
}

export interface VisionImage {
  readonly url: string;
  readonly mediaType?: string;
}

export interface VisionRequest {
  readonly prompt: string;
  readonly images: readonly VisionImage[];
  readonly maxOutputTokens?: number;
}

export interface VisionResult {
  readonly text: string;
  readonly finishReason?: string;
}

export type GenerationMessageRole = "system" | "user" | "assistant";

export interface GenerationMessage {
  readonly role: GenerationMessageRole;
  readonly content: string;
}

export interface GenerationRequest {
  readonly messages: readonly GenerationMessage[];
  readonly maxOutputTokens?: number;
  readonly responseFormat?: "text" | "jsonObject";
}

export interface GenerationResult {
  readonly text: string;
  readonly finishReason?: string;
}

export interface RerankerRequest {
  readonly query: string;
  readonly documents: readonly string[];
}

export interface RerankerResult {
  readonly scores: readonly number[];
}

export interface RepositoryAgentRequest {
  readonly instruction: string;
  readonly maximumTurns: number;
  /**
   * Limits one model turn. The execution gateway reserves the product of these
   * limits and `maximumTurns` before an agent is allowed to run.
   */
  readonly maximumInputTokensPerTurn: number;
  readonly maximumOutputTokensPerTurn: number;
}

export interface RepositoryAgentTurn {
  readonly turn: number;
  readonly usage: NormalizedUsage;
  readonly metadata?: ProviderResponseMetadata;
}

export type RepositoryAgentMetering =
  | {
      readonly mode: "aggregate";
    }
  | {
      readonly mode: "observableTurns";
      readonly turns: readonly RepositoryAgentTurn[];
    };

export interface RepositoryAgentResult {
  readonly summary: string;
  readonly metering: RepositoryAgentMetering;
}

export interface EmbeddingProvider {
  embed(
    invocation: ProviderInvocation<EmbeddingRequest>,
  ): Promise<ProviderResult<EmbeddingResult>>;
}

export interface VisionProvider {
  analyzeVision(
    invocation: ProviderInvocation<VisionRequest>,
  ): Promise<ProviderResult<VisionResult>>;
}

export interface GenerationProvider {
  generate(
    invocation: ProviderInvocation<GenerationRequest>,
  ): Promise<ProviderResult<GenerationResult>>;
}

export interface RerankerProvider {
  rerank(
    invocation: ProviderInvocation<RerankerRequest>,
  ): Promise<ProviderResult<RerankerResult>>;
}

export interface RepositoryAgentProvider {
  runRepositoryAgent(
    invocation: ProviderInvocation<RepositoryAgentRequest>,
  ): Promise<ProviderResult<RepositoryAgentResult>>;
}

export interface AiProviderDispatcher
  extends EmbeddingProvider,
    VisionProvider,
    GenerationProvider,
    RerankerProvider,
    RepositoryAgentProvider {}
