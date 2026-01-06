import type { EmbeddingInput, IHostedEmbeddingProvider } from '../../interfaces/provider';
import type {
  EmbeddingOutput,
  EmbeddingProviderError,
  ProviderMetadata,
  Result,
} from '../../provider-types';
import { STANDARD_EMBEDDING_DIMENSION } from '../../provider-types';
import type { ModelConfig } from '../../types';

/** Default distance metric for OpenAI embeddings */
const DEFAULT_DISTANCE_METRIC: ProviderMetadata['distance'] = 'cosine';

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

export type OpenAIEmbeddingProviderOptions = {
  readonly modelId: string;
  readonly targetDimensions: number;
  readonly apiKey?: string;
  readonly fetch?: FetchLike;
  readonly endpoint?: string;
};

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

  /**
   * Get unified provider metadata for embedding-set creation and validation (BST-167)
   */
  getMetadata(modelId: string): ProviderMetadata | null {
    const modelConfig = this.getModelInfo(modelId);
    if (!modelConfig) {
      return null;
    }

    return {
      providerId: 'openai',
      modelKey: modelId,
      // Use configured targetDimensions (OpenAI supports configurable dimensions)
      dimensions: this.targetDimensions,
      distance: DEFAULT_DISTANCE_METRIC,
      displayName: modelConfig.name,
      ...(modelConfig.contextWindow !== undefined && { contextWindow: modelConfig.contextWindow }),
    };
  }

  async embed(input: EmbeddingInput): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    if (!this.apiKey) {
      return { ok: false, error: { type: 'missing_api_key', provider: 'openai' } };
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
          provider: 'openai',
          originalError: error instanceof Error ? error : new Error(String(error)),
        },
      };
    }
  }

  private async makeEmbeddingRequest(text: string | string[]): Promise<Response> {
    const fetchImpl = this.fetchImpl.bind(globalThis);
    return fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // biome-ignore lint/style/useNamingConvention: HTTP header casing is standardized
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelId,
        input: text,
        // biome-ignore lint/style/useNamingConvention: OpenAI API expects snake_case key
        encoding_format: 'float',
        dimensions: this.targetDimensions,
      }),
    });
  }

  private async handleErrorResponse(
    response: Response
  ): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const error: Extract<EmbeddingProviderError, { type: 'rate_limit_exceeded' }> = {
        type: 'rate_limit_exceeded',
        provider: 'openai',
      };
      if (retryAfter !== undefined) {
        error.retryAfter = retryAfter;
      }
      return { ok: false, error };
    }

    const errorPayload = (await safeJson(response)) as OpenAIEmbeddingResponse | undefined;
    const message =
      errorPayload?.error?.message ??
      `OpenAI embeddings request failed with status ${response.status}`;

    return {
      ok: false,
      error: { type: 'api_error', provider: 'openai', statusCode: response.status, message },
    };
  }

  private async processSuccessResponse(
    response: Response,
    modelId: string
  ): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    const payload = (await response.json()) as OpenAIEmbeddingResponse;

    if (!(payload.data && Array.isArray(payload.data)) || payload.data.length === 0) {
      return {
        ok: false,
        error: {
          type: 'api_error',
          provider: 'openai',
          statusCode: response.status,
          message: 'OpenAI response did not include any embedding data.',
        },
      };
    }

    const embeddings: number[][] = [];
    for (const item of payload.data) {
      if (item.embedding && Array.isArray(item.embedding)) {
        embeddings.push(item.embedding);
      }
    }

    if (embeddings.length === 0) {
      return {
        ok: false,
        error: {
          type: 'api_error',
          provider: 'openai',
          statusCode: response.status,
          message: 'OpenAI response data contained no valid embeddings.',
        },
      };
    }

    const firstEmbedding = embeddings[0];
    if (!firstEmbedding) {
      return {
        ok: false,
        error: {
          type: 'api_error',
          provider: 'openai',
          statusCode: response.status,
          message: 'OpenAI response data contained no valid embeddings.',
        },
      };
    }

    const validation = this.validateDimensions(firstEmbedding, this.targetDimensions);
    if (!validation.ok) {
      return validation as Result<EmbeddingOutput, EmbeddingProviderError>;
    }

    const output: EmbeddingOutput = {
      embedding: firstEmbedding,
      embeddings,
      dimensions: firstEmbedding.length,
      modelId,
      provider: 'openai',
    };

    if (payload.usage) {
      const inputTokens = payload.usage.prompt_tokens ?? 0;
      const totalTokens = payload.usage.total_tokens ?? inputTokens;
      output.usage = {
        inputTokens,
        totalTokens,
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
  if (trimmed.length === 0) {
    return null;
  }
  // Basic validation: OpenAI keys typically start with "sk-" or "sess-"
  // However, we should be lenient to allow for project-scoped keys or future formats
  // Just ensuring it's not a placeholder and has reasonable length is a good start
  if (trimmed.length < 10) {
    return null; // Too short to be a valid key
  }
  return trimmed;
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
