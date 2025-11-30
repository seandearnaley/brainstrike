import type { EmbeddingInput, IHostedEmbeddingProvider } from '../../interfaces/provider';
import type { EmbeddingOutput, EmbeddingProviderError, Result } from '../../provider-types';
import type { ModelConfig } from '../../types';

type FetchLike = typeof fetch;

type CohereEmbeddingResponse = {
  id?: string;
  // biome-ignore lint/style/useNamingConvention: Cohere API uses snake_case
  response_type?: string;
  embeddings?: {
    float?: number[][];
    int8?: number[][];
    uint8?: number[][];
    binary?: number[][];
    ubinary?: number[][];
  };
  texts?: string[];
  error?: { message?: string };
};

const COHERE_MODELS: Record<string, ModelConfig> = {
  'embed-english-v3.0': {
    id: 'embed-english-v3.0',
    name: 'Cohere Embed English v3',
    dimensions: 1024,
    quantized: false,
    description: 'English-optimized with input_type support',
    tags: ['cohere', 'hosted', 'embedding'],
    origin: 'Cohere',
    size: 'hosted',
  },
  'embed-multilingual-v3.0': {
    id: 'embed-multilingual-v3.0',
    name: 'Cohere Embed Multilingual v3',
    dimensions: 1024,
    quantized: false,
    description: '100+ languages with cross-lingual search',
    tags: ['cohere', 'hosted', 'embedding'],
    origin: 'Cohere',
    size: 'hosted',
  },
};

export type CohereEmbeddingProviderOptions = {
  readonly modelId: string;
  readonly inputType?: 'search_document' | 'search_query' | 'classification' | 'clustering';
  readonly apiKey?: string;
  readonly fetch?: FetchLike;
  readonly endpoint?: string;
};

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

  async isAvailable(): Promise<boolean> {
    return this.hasApiKey();
  }

  getModelInfo(modelId: string): ModelConfig | null {
    return COHERE_MODELS[modelId] ?? null;
  }

  async embed(input: EmbeddingInput): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    const apiKey = this.apiKey;

    if (!apiKey) {
      return {
        ok: false,
        error: {
          type: 'missing_api_key',
          provider: 'cohere',
        },
      };
    }

    if (!this.fetchImpl) {
      return {
        ok: false,
        error: {
          type: 'network_error',
          provider: 'cohere',
          originalError: new Error('Fetch implementation not available'),
        },
      };
    }

    try {
      const fetchImpl = this.fetchImpl.bind(globalThis);
      const response = await fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // biome-ignore lint/style/useNamingConvention: HTTP header casing is standardized
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelId,
          texts: [input.text],
          // biome-ignore lint/style/useNamingConvention: Cohere API expects snake_case key
          input_type: this.inputType,
          // biome-ignore lint/style/useNamingConvention: Cohere API expects snake_case key
          embedding_types: ['float'],
        }),
      });

      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
          const rateLimitError: Extract<EmbeddingProviderError, { type: 'rate_limit_exceeded' }> = {
            type: 'rate_limit_exceeded',
            provider: 'cohere',
          };
          if (retryAfter !== undefined) {
            rateLimitError.retryAfter = retryAfter;
          }
          return {
            ok: false,
            error: rateLimitError,
          };
        }

        const errorPayload = (await safeJson(response)) as CohereEmbeddingResponse | undefined;
        const message =
          errorPayload?.error?.message ??
          `Cohere embeddings request failed with status ${response.status}`;

        return {
          ok: false,
          error: {
            type: 'api_error',
            provider: 'cohere',
            statusCode: response.status,
            message,
          },
        };
      }

      const payload = (await response.json()) as CohereEmbeddingResponse;
      const embedding = payload.embeddings?.float?.[0];

      if (!Array.isArray(embedding)) {
        return {
          ok: false,
          error: {
            type: 'api_error',
            provider: 'cohere',
            statusCode: response.status,
            message: 'Cohere response did not include an embedding array.',
          },
        };
      }

      const modelInfo = this.getModelInfo(this.modelId);
      const expectedDimensions = modelInfo?.dimensions ?? embedding.length;
      const validation = this.validateDimensions(embedding, expectedDimensions);
      if (!validation.ok) {
        return validation as Result<EmbeddingOutput, EmbeddingProviderError>;
      }

      const output: EmbeddingOutput = {
        embedding,
        dimensions: embedding.length,
        modelId: input.modelId,
        provider: 'cohere',
      };

      return { ok: true, value: output };
    } catch (error) {
      return {
        ok: false,
        error: {
          type: 'network_error',
          provider: 'cohere',
          originalError: error instanceof Error ? error : new Error(String(error)),
        },
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
