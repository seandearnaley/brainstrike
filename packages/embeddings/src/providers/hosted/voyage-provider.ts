import type { EmbeddingInput, IHostedEmbeddingProvider } from '../../interfaces/provider';
import type { EmbeddingOutput, EmbeddingProviderError, Result } from '../../provider-types';
import type { ModelConfig } from '../../types';

type FetchLike = typeof fetch;

type VoyageEmbeddingResponse = {
  data?: Array<{
    object?: string;
    embedding?: number[];
    index?: number;
  }>;
  object?: string;
  model?: string;
  usage?: {
    // biome-ignore lint/style/useNamingConvention: Voyage API uses snake_case keys
    total_tokens?: number;
  };
  error?: { message?: string };
};

const VOYAGE_MODELS: Record<string, ModelConfig> = {
  'voyage-3': {
    id: 'voyage-3',
    name: 'Voyage 3',
    dimensions: 1024,
    quantized: false,
    description: 'General-purpose multilingual retrieval (32k context)',
    tags: ['voyage', 'hosted', 'embedding'],
    origin: 'Voyage AI',
    size: 'hosted',
  },
  'voyage-3-lite': {
    id: 'voyage-3-lite',
    name: 'Voyage 3 Lite',
    dimensions: 512,
    quantized: false,
    description: 'Budget-friendly with long context support',
    tags: ['voyage', 'hosted', 'embedding'],
    origin: 'Voyage AI',
    size: 'hosted',
  },
};

export interface VoyageEmbeddingProviderOptions {
  readonly modelId: string;
  readonly inputType?: 'document' | 'query';
  readonly apiKey?: string;
  readonly fetch?: FetchLike;
  readonly endpoint?: string;
}

export class VoyageEmbeddingProvider implements IHostedEmbeddingProvider {
  readonly runtime = 'hosted' as const;
  readonly provider = 'voyage' as const;

  private apiKey: string | null;
  private readonly modelId: string;
  private readonly inputType: 'document' | 'query' | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;

  constructor(options: VoyageEmbeddingProviderOptions) {
    this.modelId = options.modelId;
    this.inputType = options.inputType;
    this.apiKey = normalizeApiKey(options.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.endpoint = options.endpoint ?? 'https://api.voyageai.com/v1/embeddings';
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
    return VOYAGE_MODELS[modelId] ?? null;
  }

  async embed(input: EmbeddingInput): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    const validationError = this.validateBeforeEmbed();
    if (validationError) return validationError;

    try {
      const response = await this.makeEmbeddingRequest(input.text);
      if (!response.ok) {
        return this.handleErrorResponse(response);
      }

      return this.processSuccessResponse(response, input.modelId);
    } catch (error) {
      return {
        ok: false,
        error: {
          type: 'network_error',
          provider: 'voyage',
          originalError: error instanceof Error ? error : new Error(String(error)),
        },
      };
    }
  }

  private validateBeforeEmbed(): Result<EmbeddingOutput, EmbeddingProviderError> | null {
    if (!this.apiKey) {
      return {
        ok: false,
        error: { type: 'missing_api_key', provider: 'voyage' },
      };
    }
    if (!this.fetchImpl) {
      return {
        ok: false,
        error: {
          type: 'network_error',
          provider: 'voyage',
          originalError: new Error('Fetch implementation not available'),
        },
      };
    }
    return null;
  }

  private async makeEmbeddingRequest(text: string | string[]): Promise<Response> {
    const requestBody: Record<string, unknown> = {
      input: Array.isArray(text) ? text : [text],
      model: this.modelId,
    };
    if (this.inputType) {
      requestBody['input_type'] = this.inputType;
    }

    const fetchImpl = this.fetchImpl.bind(globalThis);
    return fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // biome-ignore lint/style/useNamingConvention: HTTP header casing is standardized
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
  }

  private async handleErrorResponse(
    response: Response
  ): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const error: Extract<EmbeddingProviderError, { type: 'rate_limit_exceeded' }> = {
        type: 'rate_limit_exceeded',
        provider: 'voyage',
      };
      if (retryAfter !== undefined) {
        error.retryAfter = retryAfter;
      }
      return { ok: false, error };
    }

    const errorPayload = (await safeJson(response)) as VoyageEmbeddingResponse | undefined;
    const message =
      errorPayload?.error?.message ??
      `Voyage embeddings request failed with status ${response.status}`;

    return {
      ok: false,
      error: { type: 'api_error', provider: 'voyage', statusCode: response.status, message },
    };
  }

  private async processSuccessResponse(
    response: Response,
    modelId: string
  ): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    const payload = (await response.json()) as VoyageEmbeddingResponse;

    if (!payload.data || !Array.isArray(payload.data) || payload.data.length === 0) {
      return {
        ok: false,
        error: {
          type: 'api_error',
          provider: 'voyage',
          statusCode: response.status,
          message: 'Voyage response did not include data array.',
        },
      };
    }

    const embeddings = payload.data
      .map((d) => d.embedding)
      .filter((e): e is number[] => Array.isArray(e));

    if (embeddings.length === 0) {
      return {
        ok: false,
        error: {
          type: 'api_error',
          provider: 'voyage',
          statusCode: response.status,
          message: 'Voyage response did not include valid embeddings.',
        },
      };
    }

    const modelInfo = this.getModelInfo(this.modelId);
    const expectedDimensions = modelInfo?.dimensions ?? embeddings[0]?.length ?? 0;

    for (const embedding of embeddings) {
      const validation = this.validateDimensions(embedding, expectedDimensions);
      if (!validation.ok) {
        return validation as Result<EmbeddingOutput, EmbeddingProviderError>;
      }
    }

    const output: EmbeddingOutput = {
      embedding: embeddings[0] ?? [], // For backward compatibility
      embeddings: embeddings,
      dimensions: embeddings[0]?.length ?? 0,
      modelId,
      provider: 'voyage',
    };

    const usageTokens = payload.usage?.['total_tokens'];
    if (typeof usageTokens === 'number') {
      output.usage = {
        inputTokens: usageTokens,
        totalTokens: usageTokens,
      };
    }

    return { ok: true, value: output };
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
