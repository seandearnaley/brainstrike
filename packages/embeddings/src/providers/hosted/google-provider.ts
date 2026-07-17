import type { EmbeddingInput, IHostedEmbeddingProvider } from '../../interfaces/provider';
import type {
  EmbeddingOutput,
  EmbeddingProviderError,
  ProviderMetadata,
  Result,
} from '../../provider-types';
import type { ModelConfig } from '../../types';

/** Default distance metric for Google embeddings */
const DEFAULT_DISTANCE_METRIC: ProviderMetadata['distance'] = 'cosine';

type FetchLike = typeof fetch;

interface GoogleEmbeddingResponse {
  embedding?: { values?: number[] };
  embeddings?: Array<{ values?: number[] }>;
  error?: { message?: string };
  predictions?: Array<{
    embeddings?: { values?: number[] } | Array<{ values?: number[] }>;
  }>;
  usageMetadata?: { totalTokenCount?: number; inputTokenCount?: number };
}

interface GoogleModelConfig extends ModelConfig {
  supportsOutputDimensionality?: boolean;
}

const GOOGLE_MODELS: Record<string, GoogleModelConfig> = {
  'gemini-embedding-001': {
    description: 'Gemini embedding model with configurable output dimensions.',
    dimensions: 3072,
    id: 'gemini-embedding-001',
    name: 'Gemini embedding-001',
    origin: 'Google Gemini',
    quantized: false,
    size: 'hosted',
    supportsOutputDimensionality: true,
    tags: ['google', 'hosted', 'embedding'],
  },
};

export interface GoogleEmbeddingProviderOptions {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly fetch?: FetchLike;
  readonly modelId: string;
  readonly outputDimensions?: number;
}

export class GoogleEmbeddingProvider implements IHostedEmbeddingProvider {
  readonly runtime = 'hosted' as const;
  readonly provider = 'google' as const;

  private apiKey: string | null;
  private readonly modelId: string;
  private readonly targetDimensions: number;
  private readonly supportsOutputDimensionality: boolean;
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;
  private readonly batchEndpoint: string;

  constructor(options: GoogleEmbeddingProviderOptions) {
    this.modelId = options.modelId;
    // Use model's native dimensions if outputDimensions not specified
    const modelInfo = GOOGLE_MODELS[options.modelId];
    this.supportsOutputDimensionality = Boolean(modelInfo?.supportsOutputDimensionality);
    if (options.outputDimensions !== undefined) {
      if (
        !this.supportsOutputDimensionality &&
        modelInfo?.dimensions !== undefined &&
        options.outputDimensions !== modelInfo.dimensions
      ) {
        throw new Error(`Google model '${options.modelId}' does not support custom dimensions.`);
      }
      this.targetDimensions = options.outputDimensions;
    } else if (modelInfo?.dimensions) {
      this.targetDimensions = modelInfo.dimensions;
    } else {
      throw new Error(`Unknown Google model '${options.modelId}' - cannot determine dimensions`);
    }
    this.apiKey = normalizeApiKey(options.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    const defaultEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelId}:embedContent`;
    this.endpoint = options.endpoint ?? defaultEndpoint;
    this.batchEndpoint = resolveBatchEndpoint(this.endpoint);
  }

  setApiKey(apiKey: string): void {
    this.apiKey = normalizeApiKey(apiKey);
  }

  hasApiKey(): boolean {
    return this.apiKey !== null;
  }

  async isAvailable(): Promise<boolean> {
    return this.hasApiKey();
  }

  getModelInfo(modelId: string): ModelConfig | null {
    return GOOGLE_MODELS[modelId] ?? null;
  }

  /**
   * Get unified provider metadata for embedding-set creation and validation (BST-167)
   */
  getMetadata(modelId: string): ProviderMetadata | null {
    const modelConfig = this.getModelInfo(modelId);
    if (!modelConfig) {
      return null;
    }

    return {
      // Use configured targetDimensions (Google supports configurable outputDimensionality)
      dimensions: this.targetDimensions,
      displayName: modelConfig.name,
      distance: DEFAULT_DISTANCE_METRIC,
      modelKey: modelId,
      providerId: 'google',
      ...(modelConfig.contextWindow !== undefined && { contextWindow: modelConfig.contextWindow }),
    };
  }

  async embed(input: EmbeddingInput): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    const apiKey = this.apiKey;

    if (!apiKey) {
      return {
        error: {
          provider: 'google',
          type: 'missing_api_key',
        },
        ok: false,
      };
    }

    if (!this.fetchImpl) {
      return {
        error: {
          originalError: new Error('Fetch implementation not available'),
          provider: 'google',
          type: 'network_error',
        },
        ok: false,
      };
    }

    const normalizedTexts = normalizeInputTexts(input.text);
    if (!normalizedTexts.ok) {
      return normalizedTexts;
    }

    try {
      const response = await this.requestEmbeddings(normalizedTexts.value, apiKey, input.signal);
      if (!response.ok) {
        return this.handleErrorResponse(response);
      }
      return await this.handleSuccessResponse(response, normalizedTexts.value, input.modelId);
    } catch (error) {
      return {
        error: {
          originalError: error instanceof Error ? error : new Error(String(error)),
          provider: 'google',
          type: 'network_error',
        },
        ok: false,
      };
    }
  }

  private async requestEmbeddings(
    texts: string[],
    apiKey: string,
    signal?: AbortSignal
  ): Promise<Response> {
    if (texts.length > 1) {
      return this.requestBatchEmbedding(texts, apiKey, signal);
    }
    return this.requestSingleEmbedding(texts[0] ?? '', apiKey, signal);
  }

  private async handleErrorResponse(
    response: Response
  ): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    if (response.status === 429) {
      return {
        error: {
          provider: 'google',
          type: 'rate_limit_exceeded',
        },
        ok: false,
      };
    }

    const errPayload = (await safeJson(response)) as GoogleEmbeddingResponse | undefined;
    const message =
      (typeof errPayload?.error?.message === 'string' && errPayload.error.message) ||
      `Google embeddings request failed with status ${response.status}`;

    return {
      error: {
        message,
        provider: 'google',
        statusCode: response.status,
        type: 'api_error',
      },
      ok: false,
    };
  }

  private async handleSuccessResponse(
    response: Response,
    texts: string[],
    modelId: string
  ): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    const payload = (await response.json()) as GoogleEmbeddingResponse;
    const embeddings = extractEmbeddingVectors(payload);

    if (!embeddings || embeddings.length === 0) {
      return {
        error: {
          message: 'Google response did not include embedding values.',
          provider: 'google',
          statusCode: response.status,
          type: 'api_error',
        },
        ok: false,
      };
    }

    if (embeddings.length !== texts.length) {
      return {
        error: {
          message: `Google response returned ${embeddings.length} embeddings for ${texts.length} inputs.`,
          provider: 'google',
          statusCode: response.status,
          type: 'api_error',
        },
        ok: false,
      };
    }

    for (const embedding of embeddings) {
      const validation = this.validateDimensions(embedding, this.targetDimensions);
      if (!validation.ok) {
        return validation as Result<EmbeddingOutput, EmbeddingProviderError>;
      }
    }

    const usageTokens = (payload as { usageMetadata?: { totalTokenCount?: number } }).usageMetadata
      ?.totalTokenCount;
    return buildEmbeddingOutput(embeddings, modelId, usageTokens);
  }

  private async requestSingleEmbedding(
    text: string,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const fetchImpl = this.fetchImpl.bind(globalThis);
    const body: {
      model: string;
      content: { parts: Array<{ text: string }> };
      outputDimensionality?: number;
    } = {
      content: buildContent(text),
      model: normalizeModelPath(this.modelId),
    };
    if (this.supportsOutputDimensionality) {
      // Gemini embeddings use outputDimensionality (camelCase) in JSON requests.
      body.outputDimensionality = this.targetDimensions;
    }

    return fetchImpl(this.endpoint, {
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      method: 'POST',
      ...(signal ? { signal } : {}),
    });
  }

  private async requestBatchEmbedding(
    texts: string[],
    apiKey: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const fetchImpl = this.fetchImpl.bind(globalThis);
    const model = normalizeModelPath(this.modelId);
    const requests = texts.map((text) => ({
      content: buildContent(text),
      model,
      // Gemini embeddings use outputDimensionality (camelCase) in JSON requests.
      ...(this.supportsOutputDimensionality ? { outputDimensionality: this.targetDimensions } : {}),
    }));

    return fetchImpl(this.batchEndpoint, {
      body: JSON.stringify({ model, requests }),
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      method: 'POST',
      ...(signal ? { signal } : {}),
    });
  }

  validateDimensions(
    embedding: number[],
    expectedDimensions: number
  ): Result<void, EmbeddingProviderError> {
    const actualDimensions = embedding.length;

    if (actualDimensions !== expectedDimensions) {
      return {
        error: {
          expected: expectedDimensions,
          modelId: this.modelId,
          received: actualDimensions,
          type: 'dimension_mismatch',
        },
        ok: false,
      };
    }

    return { ok: true, value: undefined };
  }
}

async function safeJson(response: Response): Promise<unknown | undefined> {
  try {
    return await response.json();
  } catch {
    return;
  }
}

function normalizeApiKey(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeInputTexts(input: string | string[]): Result<string[], EmbeddingProviderError> {
  const texts = Array.isArray(input) ? input : [input];
  if (texts.length === 0) {
    return {
      error: {
        field: 'text',
        message: 'At least one input string is required for embeddings.',
        type: 'validation_error',
      },
      ok: false,
    };
  }
  if (!texts.every((text) => typeof text === 'string')) {
    return {
      error: {
        field: 'text',
        message: 'Embedding inputs must be strings.',
        type: 'validation_error',
      },
      ok: false,
    };
  }
  return { ok: true, value: texts };
}

function buildContent(text: string): { parts: Array<{ text: string }> } {
  return {
    parts: [{ text }],
  };
}

function extractEmbeddingVectors(payload: GoogleEmbeddingResponse): number[][] | undefined {
  if (!payload) {
    return;
  }

  if (Array.isArray(payload.embeddings)) {
    const values = payload.embeddings
      .map((embedding) => embedding.values)
      .filter((embedding): embedding is number[] => Array.isArray(embedding));
    return values.length > 0 ? values : undefined;
  }

  if (payload.embedding?.values && Array.isArray(payload.embedding.values)) {
    return [payload.embedding.values];
  }

  if (Array.isArray(payload.predictions)) {
    const first = payload.predictions[0];
    if (!first) {
      return;
    }
    const embeddings = first.embeddings;
    if (!embeddings) {
      return;
    }
    if (Array.isArray(embeddings)) {
      const values = embeddings
        .map((embedding) => embedding.values)
        .filter((embedding): embedding is number[] => Array.isArray(embedding));
      return values.length > 0 ? values : undefined;
    }
    if (Array.isArray(embeddings.values)) {
      return [embeddings.values];
    }
  }
  return;
}

function resolveBatchEndpoint(embedEndpoint: string): string {
  if (embedEndpoint.includes(':embedContent')) {
    return embedEndpoint.replace(':embedContent', ':batchEmbedContents');
  }
  return `${embedEndpoint}:batchEmbedContents`;
}

function normalizeModelPath(modelId: string): string {
  if (modelId.startsWith('models/')) {
    return modelId;
  }
  return `models/${modelId}`;
}

function buildEmbeddingOutput(
  embeddings: number[][],
  modelId: string,
  usageTokens?: number
): Result<EmbeddingOutput, EmbeddingProviderError> {
  const primaryEmbedding = embeddings[0];
  if (!primaryEmbedding) {
    return {
      error: {
        message: 'Google response did not include embedding values.',
        provider: 'google',
        statusCode: 200,
        type: 'api_error',
      },
      ok: false,
    };
  }

  const output: EmbeddingOutput = {
    dimensions: primaryEmbedding.length,
    embedding: primaryEmbedding,
    embeddings,
    modelId,
    provider: 'google',
  };
  if (typeof usageTokens === 'number') {
    output.usage = { inputTokens: usageTokens };
  }

  return { ok: true, value: output };
}
