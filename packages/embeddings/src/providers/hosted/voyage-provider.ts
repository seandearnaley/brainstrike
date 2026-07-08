import type { EmbeddingInput, IHostedEmbeddingProvider } from '../../interfaces/provider';
import type {
  EmbeddingOutput,
  EmbeddingProviderError,
  ProviderMetadata,
  Result,
} from '../../provider-types';
import type { ModelConfig } from '../../types';

/** Default distance metric for Voyage embeddings */
const DEFAULT_DISTANCE_METRIC: ProviderMetadata['distance'] = 'cosine';

type FetchLike = typeof fetch;

interface VoyageEmbeddingResponse {
  data?: Array<{
    object?: string;
    embedding?: number[];
    index?: number;
  }>;
  error?: { message?: string };
  model?: string;
  object?: string;
  usage?: {
    // biome-ignore lint/style/useNamingConvention: Voyage API uses snake_case keys
    total_tokens?: number;
  };
}

const VOYAGE_MODELS: Record<string, ModelConfig> = {
  'voyage-3': {
    description: 'General-purpose multilingual retrieval (32k context)',
    dimensions: 1024,
    id: 'voyage-3',
    name: 'Voyage 3',
    origin: 'Voyage AI',
    quantized: false,
    size: 'hosted',
    tags: ['voyage', 'hosted', 'embedding'],
  },
  'voyage-3-lite': {
    description: 'Budget-friendly with long context support',
    dimensions: 512,
    id: 'voyage-3-lite',
    name: 'Voyage 3 Lite',
    origin: 'Voyage AI',
    quantized: false,
    size: 'hosted',
    tags: ['voyage', 'hosted', 'embedding'],
  },
};

export interface VoyageEmbeddingProviderOptions {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly fetch?: FetchLike;
  readonly inputType?: 'document' | 'query';
  readonly modelId: string;
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
      providerId: 'voyage',
      ...(modelConfig.contextWindow !== undefined && { contextWindow: modelConfig.contextWindow }),
    };
  }

  async embed(input: EmbeddingInput): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    const validationError = this.validateBeforeEmbed();
    if (validationError) {
      return validationError;
    }

    try {
      const response = await this.makeEmbeddingRequest(input.text);
      if (!response.ok) {
        return this.handleErrorResponse(response);
      }

      return this.processSuccessResponse(response, input.modelId);
    } catch (error) {
      return {
        error: {
          originalError: error instanceof Error ? error : new Error(String(error)),
          provider: 'voyage',
          type: 'network_error',
        },
        ok: false,
      };
    }
  }

  private validateBeforeEmbed(): Result<EmbeddingOutput, EmbeddingProviderError> | null {
    if (!this.apiKey) {
      return {
        error: { provider: 'voyage', type: 'missing_api_key' },
        ok: false,
      };
    }
    if (!this.fetchImpl) {
      return {
        error: {
          originalError: new Error('Fetch implementation not available'),
          provider: 'voyage',
          type: 'network_error',
        },
        ok: false,
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
      body: JSON.stringify(requestBody),
      headers: {
        // biome-ignore lint/style/useNamingConvention: HTTP header casing is standardized
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
  }

  private async handleErrorResponse(
    response: Response
  ): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const error: Extract<EmbeddingProviderError, { type: 'rate_limit_exceeded' }> = {
        provider: 'voyage',
        type: 'rate_limit_exceeded',
      };
      if (retryAfter !== undefined) {
        error.retryAfter = retryAfter;
      }
      return { error, ok: false };
    }

    const errorPayload = (await safeJson(response)) as VoyageEmbeddingResponse | undefined;
    const message =
      errorPayload?.error?.message ??
      `Voyage embeddings request failed with status ${response.status}`;

    return {
      error: { message, provider: 'voyage', statusCode: response.status, type: 'api_error' },
      ok: false,
    };
  }

  private async processSuccessResponse(
    response: Response,
    modelId: string
  ): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    const payload = (await response.json()) as VoyageEmbeddingResponse;

    if (!(payload.data && Array.isArray(payload.data)) || payload.data.length === 0) {
      return {
        error: {
          message: 'Voyage response did not include data array.',
          provider: 'voyage',
          statusCode: response.status,
          type: 'api_error',
        },
        ok: false,
      };
    }

    const embeddings = payload.data
      .map((d) => d.embedding)
      .filter((e): e is number[] => Array.isArray(e));

    if (embeddings.length === 0) {
      return {
        error: {
          message: 'Voyage response did not include valid embeddings.',
          provider: 'voyage',
          statusCode: response.status,
          type: 'api_error',
        },
        ok: false,
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
      dimensions: embeddings[0]?.length ?? 0,
      embedding: embeddings[0] ?? [], // For backward compatibility
      embeddings,
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
