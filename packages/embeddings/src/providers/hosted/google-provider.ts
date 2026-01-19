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
  predictions?: Array<{
    embeddings?: { values?: number[] } | Array<{ values?: number[] }>;
  }>;
  usageMetadata?: { totalTokenCount?: number; inputTokenCount?: number };
  error?: { message?: string };
}

const GOOGLE_MODELS: Record<string, ModelConfig> = {
  'gemini-embedding-001': {
    id: 'gemini-embedding-001',
    name: 'Gemini embedding-001',
    dimensions: 3072,
    quantized: false,
    description: 'Gemini embedding model with configurable output dimensions.',
    tags: ['google', 'hosted', 'embedding'],
    origin: 'Google Gemini',
    size: 'hosted',
  },
};

export interface GoogleEmbeddingProviderOptions {
  readonly modelId: string;
  readonly outputDimensions?: number;
  readonly apiKey?: string;
  readonly fetch?: FetchLike;
  readonly endpoint?: string;
}

export class GoogleEmbeddingProvider implements IHostedEmbeddingProvider {
  readonly runtime = 'hosted' as const;
  readonly provider = 'google' as const;

  private apiKey: string | null;
  private readonly modelId: string;
  private readonly targetDimensions: number;
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;
  private readonly batchEndpoint: string;

  constructor(options: GoogleEmbeddingProviderOptions) {
    this.modelId = options.modelId;
    // Use model's native dimensions if outputDimensions not specified
    const modelInfo = GOOGLE_MODELS[options.modelId];
    if (options.outputDimensions !== undefined) {
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
      providerId: 'google',
      modelKey: modelId,
      // Use configured targetDimensions (Google supports configurable output_dimensionality)
      dimensions: this.targetDimensions,
      distance: DEFAULT_DISTANCE_METRIC,
      displayName: modelConfig.name,
      ...(modelConfig.contextWindow !== undefined && { contextWindow: modelConfig.contextWindow }),
    };
  }

  async embed(input: EmbeddingInput): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    const apiKey = this.apiKey;

    if (!apiKey) {
      return {
        ok: false,
        error: {
          type: 'missing_api_key',
          provider: 'google',
        },
      };
    }

    if (!this.fetchImpl) {
      return {
        ok: false,
        error: {
          type: 'network_error',
          provider: 'google',
          originalError: new Error('Fetch implementation not available'),
        },
      };
    }

    const normalizedTexts = normalizeInputTexts(input.text);
    if (!normalizedTexts.ok) {
      return normalizedTexts;
    }

    try {
      const response = await this.requestEmbeddings(normalizedTexts.value, apiKey);
      if (!response.ok) {
        return this.handleErrorResponse(response);
      }
      return await this.handleSuccessResponse(response, normalizedTexts.value, input.modelId);
    } catch (error) {
      return {
        ok: false,
        error: {
          type: 'network_error',
          provider: 'google',
          originalError: error instanceof Error ? error : new Error(String(error)),
        },
      };
    }
  }

  private async requestEmbeddings(texts: string[], apiKey: string): Promise<Response> {
    if (texts.length > 1) {
      return this.requestBatchEmbedding(texts, apiKey);
    }
    return this.requestSingleEmbedding(texts[0] ?? '', apiKey);
  }

  private async handleErrorResponse(
    response: Response
  ): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    if (response.status === 429) {
      return {
        ok: false,
        error: {
          type: 'rate_limit_exceeded',
          provider: 'google',
        },
      };
    }

    const errPayload = (await safeJson(response)) as GoogleEmbeddingResponse | undefined;
    const message =
      (typeof errPayload?.error?.message === 'string' && errPayload.error.message) ||
      `Google embeddings request failed with status ${response.status}`;

    return {
      ok: false,
      error: {
        type: 'api_error',
        provider: 'google',
        statusCode: response.status,
        message,
      },
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
        ok: false,
        error: {
          type: 'api_error',
          provider: 'google',
          statusCode: response.status,
          message: 'Google response did not include embedding values.',
        },
      };
    }

    if (embeddings.length !== texts.length) {
      return {
        ok: false,
        error: {
          type: 'api_error',
          provider: 'google',
          statusCode: response.status,
          message: `Google response returned ${embeddings.length} embeddings for ${texts.length} inputs.`,
        },
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

  private async requestSingleEmbedding(text: string, apiKey: string): Promise<Response> {
    const fetchImpl = this.fetchImpl.bind(globalThis);
    return fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        content: buildContent(text),
        // biome-ignore lint/style/useNamingConvention: Google API expects snake_case key
        output_dimensionality: this.targetDimensions,
      }),
    });
  }

  private async requestBatchEmbedding(texts: string[], apiKey: string): Promise<Response> {
    const fetchImpl = this.fetchImpl.bind(globalThis);
    const requests = texts.map((text) => ({
      model: normalizeModelPath(this.modelId),
      content: buildContent(text),
      // biome-ignore lint/style/useNamingConvention: Google API expects snake_case key
      output_dimensionality: this.targetDimensions,
    }));

    return fetchImpl(this.batchEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({ requests }),
    });
  }

  validateDimensions(
    embedding: number[],
    expectedDimensions: number
  ): Result<void, EmbeddingProviderError> {
    const actualDimensions = embedding.length;

    if (actualDimensions !== expectedDimensions) {
      return {
        ok: false,
        error: {
          type: 'dimension_mismatch',
          expected: expectedDimensions,
          received: actualDimensions,
          modelId: this.modelId,
        },
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
      ok: false,
      error: {
        type: 'validation_error',
        field: 'text',
        message: 'At least one input string is required for embeddings.',
      },
    };
  }
  if (!texts.every((text) => typeof text === 'string')) {
    return {
      ok: false,
      error: {
        type: 'validation_error',
        field: 'text',
        message: 'Embedding inputs must be strings.',
      },
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
      ok: false,
      error: {
        type: 'api_error',
        provider: 'google',
        statusCode: 200,
        message: 'Google response did not include embedding values.',
      },
    };
  }

  const output: EmbeddingOutput = {
    embedding: primaryEmbedding,
    embeddings,
    dimensions: primaryEmbedding.length,
    modelId,
    provider: 'google',
  };
  if (typeof usageTokens === 'number') {
    output.usage = { inputTokens: usageTokens };
  }

  return { ok: true, value: output };
}
