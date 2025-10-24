import type { EmbeddingInput, IHostedEmbeddingProvider } from '../../interfaces/provider';
import type { EmbeddingOutput, EmbeddingProviderError, Result } from '../../provider-types';
import { STANDARD_EMBEDDING_DIMENSION } from '../../provider-types';
import type { ModelConfig } from '../../types';

type FetchLike = typeof fetch;

type GoogleEmbeddingResponse = {
  embedding?: { values?: number[] };
  embeddings?: Array<{ values?: number[] }>;
  predictions?: Array<{
    embeddings?: { values?: number[] } | Array<{ values?: number[] }>;
  }>;
  usageMetadata?: { totalTokenCount?: number; inputTokenCount?: number };
  error?: { message?: string };
};

const GOOGLE_MODELS: Record<string, ModelConfig> = {
  'text-embedding-004': {
    id: 'text-embedding-004',
    name: 'Google text-embedding-004',
    dimensions: 768,
    quantized: false,
    description: 'Google Vertex AI embedding model (768D).',
    tags: ['google', 'hosted', 'embedding'],
    origin: 'Google Vertex AI',
    size: 'hosted',
  },
  'gemini-embedding-001': {
    id: 'gemini-embedding-001',
    name: 'Gemini embedding-001',
    dimensions: 3072,
    quantized: false,
    description: 'Gemini high-dimensional embedding model with configurable output.',
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

  constructor(options: GoogleEmbeddingProviderOptions) {
    this.modelId = options.modelId;
    this.targetDimensions = options.outputDimensions || STANDARD_EMBEDDING_DIMENSION;
    this.apiKey = normalizeApiKey(options.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.endpoint =
      options.endpoint ??
      `https://generativelanguage.googleapis.com/v1beta/models/${this.modelId}:embedContent`;
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

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          content: {
            parts: [{ text: input.text }],
          },
          // biome-ignore lint/style/useNamingConvention: Google API expects snake_case key
          output_dimensionality: this.targetDimensions,
        }),
      });

      if (!response.ok) {
        if (response.status === 429) {
          return {
            ok: false,
            error: {
              type: 'rate_limit_exceeded',
              provider: 'google',
            },
          };
        }

        const errPayload = await safeJson(response);
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

      const payload = (await response.json()) as GoogleEmbeddingResponse;
      const embedding = extractEmbeddingValues(payload);

      if (!Array.isArray(embedding)) {
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

      const validation = this.validateDimensions(embedding, this.targetDimensions);
      if (!validation.ok) {
        return validation as Result<EmbeddingOutput, EmbeddingProviderError>;
      }

      const usageTokens = (payload as { usageMetadata?: { totalTokenCount?: number } })
        .usageMetadata?.totalTokenCount;

      const output: EmbeddingOutput = {
        embedding,
        dimensions: embedding.length,
        modelId: input.modelId,
        provider: 'google',
      };
      if (typeof usageTokens === 'number') {
        output.usage = { inputTokens: usageTokens };
      }

      return { ok: true, value: output };
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
    return undefined;
  }
}

function extractEmbeddingValues(payload: GoogleEmbeddingResponse): number[] | undefined {
  if (!payload) {
    return undefined;
  }

  if (Array.isArray(payload.embeddings) && payload.embeddings[0]?.values) {
    return payload.embeddings[0].values;
  }

  if (payload.embedding?.values) {
    return payload.embedding.values;
  }

  if (Array.isArray(payload.predictions)) {
    const first = payload.predictions[0];
    if (!first) return undefined;
    const embeddings = first.embeddings;
    if (!embeddings) return undefined;
    if (Array.isArray(embeddings)) {
      return embeddings[0]?.values;
    }
    return embeddings.values;
  }

  return undefined;
}

function normalizeApiKey(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
