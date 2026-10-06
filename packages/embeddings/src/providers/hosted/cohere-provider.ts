import type { EmbeddingInput, IHostedEmbeddingProvider } from '../../interfaces/provider.js';
import type {
  EmbeddingOutput,
  EmbeddingProviderError,
  ProviderMetadata,
  Result,
} from '../../provider-types.js';
import type { ModelConfig } from '../../types.js';

/** Default distance metric for Cohere embeddings */
const DEFAULT_DISTANCE_METRIC: ProviderMetadata['distance'] = 'cosine';

type FetchLike = typeof fetch;

interface CohereEmbeddingResponse {
  embeddings?: {
    float?: number[][];
    int8?: number[][];
    uint8?: number[][];
    binary?: number[][];
    ubinary?: number[][];
  };
  error?: { message?: string };
  id?: string;
  // biome-ignore lint/style/useNamingConvention: Cohere API uses snake_case
  response_type?: string;
  texts?: string[];
}

const COHERE_MODELS: Record<string, ModelConfig> = {
  'embed-english-v3.0': {
    description: 'English-optimized with input_type support',
    dimensions: 1024,
    id: 'embed-english-v3.0',
    name: 'Cohere Embed English v3',
    origin: 'Cohere',
    quantized: false,
    size: 'hosted',
    tags: ['cohere', 'hosted', 'embedding'],
  },
  'embed-multilingual-v3.0': {
    description: '100+ languages with cross-lingual search',
    dimensions: 1024,
    id: 'embed-multilingual-v3.0',
    name: 'Cohere Embed Multilingual v3',
    origin: 'Cohere',
    quantized: false,
    size: 'hosted',
    tags: ['cohere', 'hosted', 'embedding'],
  },
};

export interface CohereEmbeddingProviderOptions {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly fetch?: FetchLike;
  readonly inputType?: 'search_document' | 'search_query' | 'classification' | 'clustering';
  readonly modelId: string;
}

export class CohereEmbeddingProvider implements IHostedEmbeddingProvider {
  readonly runtime = 'hosted' as const;
  readonly provider = 'cohere' as const;

  private apiKey: string | null;
  private readonly modelId: string;
  private readonly inputType: 'search_document' | 'search_query' | 'classification' | 'clustering';
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;

  constructor(options: CohereEmbeddingProviderOptions) {
    this.modelId = options.modelId;
    this.inputType = options.inputType || 'search_document';
    this.apiKey = normalizeApiKey(options.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.endpoint = options.endpoint ?? 'https://api.cohere.com/v2/embed';
  }

  setApiKey(apiKey: string): void {
    this.apiKey = normalizeApiKey(apiKey);
  }

  hasApiKey(): boolean {
    return this.apiKey !== null;
  }

  private validateBatch(
    embeddings: readonly number[][],
    dimensions: number
  ): EmbeddingProviderError | undefined {
    for (const vector of embeddings) {
      const validation = this.validateDimensions(vector, dimensions);
      if (!validation.ok) {
        return validation.error;
      }
      if (!vector.every(Number.isFinite)) {
        return {
          field: 'embedding',
          message: 'Cohere returned nonfinite embedding values.',
          type: 'validation_error',
        };
      }
    }
    return undefined;
  }

  async isAvailable(): Promise<boolean> {
    return this.hasApiKey();
  }

  getModelInfo(modelId: string): ModelConfig | null {
    return COHERE_MODELS[modelId] ?? null;
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
      dimensions: modelConfig.dimensions,
      displayName: modelConfig.name,
      distance: DEFAULT_DISTANCE_METRIC,
      modelKey: modelId,
      providerId: 'cohere',
      ...(modelConfig.contextWindow !== undefined && { contextWindow: modelConfig.contextWindow }),
    };
  }

  async embed(input: EmbeddingInput): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    const apiKey = this.apiKey;

    if (!apiKey) {
      return {
        error: {
          provider: 'cohere',
          type: 'missing_api_key',
        },
        ok: false,
      };
    }

    if (!this.fetchImpl) {
      return {
        error: {
          originalError: new Error('Fetch implementation not available'),
          provider: 'cohere',
          type: 'network_error',
        },
        ok: false,
      };
    }

    try {
      const fetchImpl = this.fetchImpl.bind(globalThis);
      const response = await fetchImpl(this.endpoint, {
        body: JSON.stringify({
          // biome-ignore lint/style/useNamingConvention: Cohere API expects snake_case key
          embedding_types: ['float'],
          // biome-ignore lint/style/useNamingConvention: Cohere API expects snake_case key
          input_type: this.inputType,
          model: this.modelId,
          texts: Array.isArray(input.text) ? input.text : [input.text],
        }),
        headers: {
          // biome-ignore lint/style/useNamingConvention: HTTP header casing is standardized
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        ...(input.signal ? { signal: input.signal } : {}),
      });

      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
          const rateLimitError: Extract<EmbeddingProviderError, { type: 'rate_limit_exceeded' }> = {
            provider: 'cohere',
            type: 'rate_limit_exceeded',
          };
          if (retryAfter !== undefined) {
            rateLimitError.retryAfter = retryAfter;
          }
          return {
            error: rateLimitError,
            ok: false,
          };
        }

        const errorPayload = (await safeJson(response)) as CohereEmbeddingResponse | undefined;
        const message =
          errorPayload?.error?.message ??
          `Cohere embeddings request failed with status ${response.status}`;

        return {
          error: {
            message,
            provider: 'cohere',
            statusCode: response.status,
            type: 'api_error',
          },
          ok: false,
        };
      }

      const payload = (await response.json()) as CohereEmbeddingResponse;
      const embeddings = payload.embeddings?.float;
      const embedding = embeddings?.[0];

      if (
        !(
          Array.isArray(embeddings) &&
          Array.isArray(embedding) &&
          embeddings.length === (Array.isArray(input.text) ? input.text.length : 1)
        )
      ) {
        return {
          error: {
            message: 'Cohere response did not include an embedding array.',
            provider: 'cohere',
            statusCode: response.status,
            type: 'api_error',
          },
          ok: false,
        };
      }

      const modelInfo = this.getModelInfo(this.modelId);
      const expectedDimensions = modelInfo?.dimensions ?? embedding.length;
      const batchError = this.validateBatch(embeddings, expectedDimensions);
      if (batchError) {
        return { error: batchError, ok: false };
      }

      const output: EmbeddingOutput = {
        dimensions: embedding.length,
        embedding,
        embeddings,
        modelId: input.modelId,
        provider: 'cohere',
      };

      return { ok: true, value: output };
    } catch (error) {
      return {
        error: {
          originalError: error instanceof Error ? error : new Error(String(error)),
          provider: 'cohere',
          type: 'network_error',
        },
        ok: false,
      };
    }
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

function normalizeApiKey(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) {
    return;
  }
  const numeric = Number(headerValue);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const parsed = Date.parse(headerValue);
  if (!Number.isNaN(parsed)) {
    const delta = parsed - Date.now();
    return delta > 0 ? Math.round(delta / 1000) : undefined;
  }
  return;
}

async function safeJson(response: Response): Promise<unknown | undefined> {
  try {
    return await response.json();
  } catch {
    return;
  }
}
