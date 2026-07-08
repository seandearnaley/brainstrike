import type { EmbeddingInput, IHostedEmbeddingProvider } from '../../interfaces/provider';
import type {
  EmbeddingOutput,
  EmbeddingProviderError,
  HostedProviderType,
  ProviderMetadata,
  Result,
} from '../../provider-types';
import { STANDARD_EMBEDDING_DIMENSION } from '../../provider-types';
import type { ModelConfig } from '../../types';

/** Default distance metric for OpenAI embeddings */
const DEFAULT_DISTANCE_METRIC: ProviderMetadata['distance'] = 'cosine';

type FetchLike = typeof fetch;

interface OpenAIEmbeddingResponse {
  data?: Array<{
    embedding?: number[];
    index?: number;
  }>;
  error?: { message?: string };
  usage?: {
    // biome-ignore lint/style/useNamingConvention: OpenAI API uses snake_case keys
    prompt_tokens?: number;
    // biome-ignore lint/style/useNamingConvention: OpenAI API uses snake_case keys
    total_tokens?: number;
  };
}

const OPENAI_MODELS: Record<string, ModelConfig> = {
  'text-embedding-3-large': {
    description: 'High-dimensional hosted OpenAI embedding model.',
    dimensions: 3072,
    id: 'text-embedding-3-large',
    name: 'OpenAI text-embedding-3-large',
    origin: 'OpenAI',
    quantized: false,
    size: 'hosted',
    tags: ['openai', 'hosted', 'embedding'],
  },
  'text-embedding-3-small': {
    description: 'Hosted OpenAI embedding model (supports configurable dimensions).',
    dimensions: 1536,
    id: 'text-embedding-3-small',
    name: 'OpenAI text-embedding-3-small',
    origin: 'OpenAI',
    quantized: false,
    size: 'hosted',
    tags: ['openai', 'hosted', 'embedding'],
  },
};

type OpenAiCompatibleProvider = Extract<HostedProviderType, 'openai' | 'ollama' | 'lmstudio'>;

const OPENAI_COMPATIBLE_ENDPOINTS: Record<OpenAiCompatibleProvider, string> = {
  lmstudio: 'http://localhost:1234/v1/embeddings',
  ollama: 'http://127.0.0.1:11434/v1/embeddings',
  openai: 'https://api.openai.com/v1/embeddings',
};

const OPENAI_COMPATIBLE_LABELS: Record<OpenAiCompatibleProvider, string> = {
  lmstudio: 'LM Studio',
  ollama: 'Ollama',
  openai: 'OpenAI',
};

export interface OpenAIEmbeddingProviderOptions {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly fetch?: FetchLike;
  readonly includeDimensions?: boolean;
  readonly modelId: string;
  readonly provider?: OpenAiCompatibleProvider;
  readonly requiresApiKey?: boolean;
  readonly targetDimensions: number;
}

export class OpenAIEmbeddingProvider implements IHostedEmbeddingProvider {
  readonly runtime = 'hosted' as const;
  readonly provider: OpenAiCompatibleProvider;

  private apiKey: string | null;
  private readonly modelId: string;
  private readonly targetDimensions: number;
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;
  private readonly requiresApiKey: boolean;
  private readonly includeDimensions: boolean;

  constructor(options: OpenAIEmbeddingProviderOptions) {
    this.provider = options.provider ?? 'openai';
    this.modelId = options.modelId;
    this.targetDimensions = resolveTargetDimensions(options.targetDimensions);
    this.apiKey = normalizeApiKey(options.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.endpoint = options.endpoint ?? OPENAI_COMPATIBLE_ENDPOINTS[this.provider];
    this.requiresApiKey = options.requiresApiKey ?? this.provider === 'openai';
    this.includeDimensions = options.includeDimensions ?? this.provider === 'openai';
  }

  setApiKey(apiKey: string): void {
    this.apiKey = normalizeApiKey(apiKey);
  }

  hasApiKey(): boolean {
    if (!this.requiresApiKey) {
      return true;
    }
    return this.apiKey !== null;
  }

  async isAvailable(): Promise<boolean> {
    return this.hasApiKey();
  }

  getModelInfo(modelId: string): ModelConfig | null {
    const knownModel = OPENAI_MODELS[modelId];
    if (knownModel) {
      return knownModel;
    }

    if (modelId !== this.modelId) {
      return null;
    }

    const providerLabel = OPENAI_COMPATIBLE_LABELS[this.provider];
    return {
      description: `${providerLabel} OpenAI-compatible embedding model.`,
      dimensions: this.targetDimensions,
      id: modelId,
      name: `${providerLabel} ${modelId}`,
      origin: providerLabel,
      quantized: false,
      size: 'hosted',
      tags: [this.provider, 'embedding', 'openai-compatible'],
    };
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
      // Use configured targetDimensions (OpenAI supports configurable dimensions)
      dimensions: this.targetDimensions,
      displayName: modelConfig.name,
      distance: DEFAULT_DISTANCE_METRIC,
      modelKey: modelId,
      providerId: this.provider,
      ...(modelConfig.contextWindow !== undefined && { contextWindow: modelConfig.contextWindow }),
    };
  }

  async embed(input: EmbeddingInput): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    if (this.requiresApiKey && !this.apiKey) {
      return { error: { provider: this.provider, type: 'missing_api_key' }, ok: false };
    }
    if (!this.fetchImpl) {
      return {
        error: {
          originalError: new Error('Fetch implementation not available'),
          provider: this.provider,
          type: 'network_error',
        },
        ok: false,
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
        error: {
          originalError: error instanceof Error ? error : new Error(String(error)),
          provider: this.provider,
          type: 'network_error',
        },
        ok: false,
      };
    }
  }

  private async makeEmbeddingRequest(text: string | string[]): Promise<Response> {
    const fetchImpl = this.fetchImpl.bind(globalThis);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const body: {
      model: string;
      input: string | string[];
      // biome-ignore lint/style/useNamingConvention: OpenAI-compatible APIs expect snake_case key
      encoding_format: 'float';
      dimensions?: number;
    } = {
      // biome-ignore lint/style/useNamingConvention: OpenAI-compatible APIs expect snake_case key
      encoding_format: 'float',
      input: text,
      model: this.modelId,
    };

    if (this.includeDimensions) {
      body.dimensions = this.targetDimensions;
    }

    return fetchImpl(this.endpoint, {
      body: JSON.stringify(body),
      headers,
      method: 'POST',
    });
  }

  private async handleErrorResponse(
    response: Response
  ): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const error: Extract<EmbeddingProviderError, { type: 'rate_limit_exceeded' }> = {
        provider: this.provider,
        type: 'rate_limit_exceeded',
      };
      if (retryAfter !== undefined) {
        error.retryAfter = retryAfter;
      }
      return { error, ok: false };
    }

    const errorPayload = (await safeJson(response)) as OpenAIEmbeddingResponse | undefined;
    const message =
      errorPayload?.error?.message ??
      `${OPENAI_COMPATIBLE_LABELS[this.provider]} embeddings request failed with status ${response.status}`;

    return {
      error: { message, provider: this.provider, statusCode: response.status, type: 'api_error' },
      ok: false,
    };
  }

  private async processSuccessResponse(
    response: Response,
    modelId: string
  ): Promise<Result<EmbeddingOutput, EmbeddingProviderError>> {
    const payload = (await response.json()) as OpenAIEmbeddingResponse;

    if (!(payload.data && Array.isArray(payload.data)) || payload.data.length === 0) {
      return {
        error: {
          message: 'OpenAI response did not include any embedding data.',
          provider: this.provider,
          statusCode: response.status,
          type: 'api_error',
        },
        ok: false,
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
        error: {
          message: 'OpenAI response data contained no valid embeddings.',
          provider: this.provider,
          statusCode: response.status,
          type: 'api_error',
        },
        ok: false,
      };
    }

    const firstEmbedding = embeddings[0];
    if (!firstEmbedding) {
      return {
        error: {
          message: 'OpenAI response data contained no valid embeddings.',
          provider: this.provider,
          statusCode: response.status,
          type: 'api_error',
        },
        ok: false,
      };
    }

    const validation = this.validateDimensions(firstEmbedding, this.targetDimensions);
    if (!validation.ok) {
      return validation as Result<EmbeddingOutput, EmbeddingProviderError>;
    }

    const output: EmbeddingOutput = {
      dimensions: firstEmbedding.length,
      embedding: firstEmbedding,
      embeddings,
      modelId,
      provider: this.provider,
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
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed;
}

function resolveTargetDimensions(value: number | undefined): number {
  const targetDimensions = value ?? STANDARD_EMBEDDING_DIMENSION;
  if (!Number.isFinite(targetDimensions) || targetDimensions <= 0) {
    throw new Error(
      `OpenAI-compatible embedding dimensions must be a positive number. Received: ${String(value)}`
    );
  }
  return Math.floor(targetDimensions);
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
