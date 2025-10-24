import type { EmbeddingInput, IHostedEmbeddingProvider } from '../../interfaces/provider';
import type { EmbeddingOutput, EmbeddingProviderError, Result } from '../../provider-types';
import { STANDARD_EMBEDDING_DIMENSION } from '../../provider-types';
import type { ModelConfig } from '../../types';

type FetchLike = typeof fetch;

type OpenAIEmbeddingResponse = {
  data?: Array<{
    embedding?: number[];
    index?: number;
  }>;
  usage?: {
    // biome-ignore lint/style/useNamingConvention: OpenAI API uses snake_case keys
    prompt_tokens?: number;
    // biome-ignore lint/style/useNamingConvention: OpenAI API uses snake_case keys
    total_tokens?: number;
  };
  error?: { message?: string };
};

const OPENAI_MODELS: Record<string, ModelConfig> = {
  'text-embedding-3-small': {
    id: 'text-embedding-3-small',
    name: 'OpenAI text-embedding-3-small',
    dimensions: 1536,
    quantized: false,
    description: 'Hosted OpenAI embedding model (supports configurable dimensions).',
    tags: ['openai', 'hosted', 'embedding'],
    origin: 'OpenAI',
    size: 'hosted',
  },
  'text-embedding-3-large': {
    id: 'text-embedding-3-large',
    name: 'OpenAI text-embedding-3-large',
    dimensions: 3072,
    quantized: false,
    description: 'High-dimensional hosted OpenAI embedding model.',
    tags: ['openai', 'hosted', 'embedding'],
    origin: 'OpenAI',
    size: 'hosted',
  },
};

export interface OpenAIEmbeddingProviderOptions {
  readonly modelId: string;
  readonly targetDimensions: number;
  readonly apiKey?: string;
  readonly fetch?: FetchLike;
  readonly endpoint?: string;
}

export class OpenAIEmbeddingProvider implements IHostedEmbeddingProvider {
  readonly runtime = 'hosted' as const;
  readonly provider = 'openai' as const;

  private apiKey: string | null;
  private readonly modelId: string;
  private readonly targetDimensions: number;
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;

  constructor(options: OpenAIEmbeddingProviderOptions) {
    this.modelId = options.modelId;
    this.targetDimensions = options.targetDimensions || STANDARD_EMBEDDING_DIMENSION;
    this.apiKey = normalizeApiKey(options.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/embeddings';
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
    return OPENAI_MODELS[modelId] ?? null;
  }

  async embed(input: EmbeddingInput): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    const apiKey = this.apiKey;

    if (!apiKey) {
      return {
        ok: false,
        error: {
          type: 'missing_api_key',
          provider: 'openai',
        },
      };
    }

    if (!this.fetchImpl) {
      return {
        ok: false,
        error: {
          type: 'network_error',
          provider: 'openai',
          originalError: new Error('Fetch implementation not available'),
        },
      };
    }

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // biome-ignore lint/style/useNamingConvention: HTTP header casing is standardized
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelId,
          input: input.text,
          // biome-ignore lint/style/useNamingConvention: OpenAI API expects snake_case key
          encoding_format: 'float',
          dimensions: this.targetDimensions,
        }),
      });

      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
          const rateLimitError: Extract<EmbeddingProviderError, { type: 'rate_limit_exceeded' }> = {
            type: 'rate_limit_exceeded',
            provider: 'openai',
          };
          if (retryAfter !== undefined) {
            rateLimitError.retryAfter = retryAfter;
          }
          return {
            ok: false,
            error: rateLimitError,
          };
        }

        const errorPayload = (await safeJson(response)) as OpenAIEmbeddingResponse | undefined;
        const message =
          errorPayload?.error?.message ??
          `OpenAI embeddings request failed with status ${response.status}`;

        return {
          ok: false,
          error: {
            type: 'api_error',
            provider: 'openai',
            statusCode: response.status,
            message,
          },
        };
      }

      const payload = (await response.json()) as OpenAIEmbeddingResponse;
      const embedding = payload.data?.[0]?.embedding;

      if (!Array.isArray(embedding)) {
        return {
          ok: false,
          error: {
            type: 'api_error',
            provider: 'openai',
            statusCode: response.status,
            message: 'OpenAI response did not include an embedding array.',
          },
        };
      }

      const validation = this.validateDimensions(embedding, this.targetDimensions);
      if (!validation.ok) {
        return validation as Result<EmbeddingOutput, EmbeddingProviderError>;
      }

      const output: EmbeddingOutput = {
        embedding,
        dimensions: embedding.length,
        modelId: input.modelId,
        provider: 'openai',
      };
      const inputTokens = payload.usage?.['prompt_tokens'];
      if (typeof inputTokens === 'number') {
        output.usage = { inputTokens };
      }

      return { ok: true, value: output };
    } catch (error) {
      return {
        ok: false,
        error: {
          type: 'network_error',
          provider: 'openai',
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
    return undefined;
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
  return undefined;
}

async function safeJson(response: Response): Promise<unknown | undefined> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
