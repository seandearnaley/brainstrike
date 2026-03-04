import { defaultCollator } from '@brainstrike/utils';
import {
  type LocalRuntimeAvailabilityState,
  LocalRuntimeDiscoveryService,
  type LocalRuntimeId,
  type LocalRuntimeSurface,
  type ProbeLocalRuntimeOptions,
} from './local-runtime-discovery';

import {
  extractErrorMessage,
  fetchJsonWithTimeout,
  isRecord,
  sanitizeDuration,
} from './local-runtime-utils';

export type LocalRuntimeModelSource =
  | 'openai_v1_models'
  | 'ollama_api_tags'
  | 'lmstudio_api_v1_models';

export type LocalRuntimeModelFreshness = 'live' | 'stale_cached';

export type LocalRuntimeEmbeddingCapability = 'supported' | 'unsupported' | 'needs_verification';

export interface LocalRuntimeKnownDimensionsState {
  readonly endpoint: string;
  readonly state: 'known';
  readonly values: readonly number[];
  readonly verifiedAt: number;
}

export interface LocalRuntimeNeedsVerificationDimensionsState {
  readonly state: 'needs_verification';
}

export interface LocalRuntimeNotApplicableDimensionsState {
  readonly state: 'not_applicable';
}

export type LocalRuntimeDimensionsState =
  | LocalRuntimeKnownDimensionsState
  | LocalRuntimeNeedsVerificationDimensionsState
  | LocalRuntimeNotApplicableDimensionsState;

export interface LocalRuntimeNormalizedModel {
  readonly capabilities: {
    readonly llm: boolean;
    readonly embeddings: LocalRuntimeEmbeddingCapability;
  };
  readonly dimensionsKnown: LocalRuntimeDimensionsState;
  readonly displayName: string;
  readonly endpoint: string;
  readonly freshness: LocalRuntimeModelFreshness;
  readonly modelId: string;
  readonly modelKey: string;
  readonly providerId: LocalRuntimeId;
  readonly runtime: LocalRuntimeId;
  readonly source: LocalRuntimeModelSource;
}

interface LocalRuntimeModelCatalogBaseState {
  readonly availability: LocalRuntimeAvailabilityState;
  readonly checkedAt: number;
  readonly runtime: LocalRuntimeId;
}

export interface LocalRuntimeModelsLoadedNonEmptyState extends LocalRuntimeModelCatalogBaseState {
  readonly endpoint: string;
  readonly freshness: 'live';
  readonly models: readonly LocalRuntimeNormalizedModel[];
  readonly source: LocalRuntimeModelSource;
  readonly state: 'loaded_non_empty';
}

export interface LocalRuntimeModelsLoadedEmptyState extends LocalRuntimeModelCatalogBaseState {
  readonly endpoint: string;
  readonly freshness: 'live';
  readonly models: readonly [];
  readonly source: LocalRuntimeModelSource;
  readonly state: 'loaded_empty';
}

export interface LocalRuntimeModelsFailedState extends LocalRuntimeModelCatalogBaseState {
  readonly message: string;
  readonly state: 'failed';
}

export interface LocalRuntimeModelsStaleCachedState extends LocalRuntimeModelCatalogBaseState {
  readonly endpoint: string;
  readonly freshness: 'stale_cached';
  readonly lastSuccessfulAt: number;
  readonly message: string;
  readonly models: readonly LocalRuntimeNormalizedModel[];
  readonly source: LocalRuntimeModelSource;
  readonly state: 'stale_cached';
}

export type LocalRuntimeModelCatalogState =
  | LocalRuntimeModelsLoadedNonEmptyState
  | LocalRuntimeModelsLoadedEmptyState
  | LocalRuntimeModelsFailedState
  | LocalRuntimeModelsStaleCachedState;

export type LoadedRuntimeModelCatalogState = Extract<
  LocalRuntimeModelCatalogState,
  { state: 'loaded_non_empty' | 'stale_cached' }
>;

export function isLoadedRuntimeModelCatalogState(
  state: LocalRuntimeModelCatalogState | null | undefined
): state is LoadedRuntimeModelCatalogState {
  return Boolean(state && (state.state === 'loaded_non_empty' || state.state === 'stale_cached'));
}

export interface ListLocalRuntimeModelsOptions {
  readonly force?: boolean;
  readonly maxVerificationModels?: number;
  readonly signal?: AbortSignal;
  readonly surface?: LocalRuntimeSurface;
  readonly verifyEmbeddingDimensions?: boolean;
}

interface ListAllLocalRuntimeModelsOptions extends Omit<ListLocalRuntimeModelsOptions, 'signal'> {
  readonly signal?: AbortSignal;
}

export interface LocalRuntimeModelCatalogServiceOptions {
  readonly defaultSurface?: LocalRuntimeSurface;
  readonly discoveryService?: LocalRuntimeDiscoveryService;
  readonly failureBaseBackoffMs?: number;
  readonly failureMaxBackoffMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  readonly successTtlMs?: number;
}

interface RuntimeModelCandidate {
  readonly id: string;
  readonly label: string;
}

interface RuntimeModelEndpointDefinition {
  readonly endpoint: string;
  readonly parser: (payload: unknown) => readonly RuntimeModelCandidate[] | null;
  readonly source: LocalRuntimeModelSource;
}

interface RuntimeModelAdapter {
  readonly embeddingProbeEndpoints: readonly string[];
  readonly modelEndpoints: readonly RuntimeModelEndpointDefinition[];
  readonly runtime: LocalRuntimeId;
}

interface RuntimeModelSuccessSnapshot {
  readonly checkedAt: number;
  readonly endpoint: string;
  readonly models: readonly LocalRuntimeNormalizedModel[];
  readonly source: LocalRuntimeModelSource;
}

interface RuntimeModelCacheEntry {
  readonly consecutiveFailures: number;
  readonly lastSuccess: RuntimeModelSuccessSnapshot | null;
  readonly nextRefreshAt: number;
  readonly status: LocalRuntimeModelCatalogState;
}

type EmbeddingProbeOutcome =
  | { readonly kind: 'verified'; readonly result: LocalRuntimeEmbeddingDimensionVerified }
  | { readonly kind: 'unsupported'; readonly message: string }
  | { readonly kind: 'failed'; readonly result: LocalRuntimeEmbeddingDimensionFailed };

type ModelEndpointAttemptOutcome =
  | {
      readonly ok: true;
      readonly models: readonly LocalRuntimeNormalizedModel[];
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

const DEFAULT_SUCCESS_TTL_MS = 30_000;
const DEFAULT_FAILURE_BASE_BACKOFF_MS = 2000;
const DEFAULT_FAILURE_MAX_BACKOFF_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2500;
// Keep verification capped because unknown model-family fallbacks can produce
// false positives that would otherwise fan out into many localhost probes.
const DEFAULT_MAX_VERIFICATION_MODELS = 4;
const DEFAULT_DIMENSION_PROBE_TEXT = 'brainstrike dimension probe';

const EMBEDDING_NAME_PATTERN =
  /(embed|embedding|text-embedding|nomic-embed|jina-embeddings|bge|e5|gte|arctic-embed|voyage)/i;
const CHAT_NAME_PATTERN =
  /(chat|instruct|llama|qwen|mistral|gemma|phi|deepseek|gpt|claude|sonnet|haiku|opus|command-r|mixtral)/i;

const OLLAMA_MODEL_ENDPOINTS: readonly RuntimeModelEndpointDefinition[] = [
  {
    endpoint: 'http://127.0.0.1:11434/v1/models',
    source: 'openai_v1_models',
    parser: parseOpenAiModelsPayload,
  },
  {
    endpoint: 'http://127.0.0.1:11434/api/tags',
    source: 'ollama_api_tags',
    parser: parseOllamaTagsPayload,
  },
];

const LM_STUDIO_MODEL_ENDPOINTS: readonly RuntimeModelEndpointDefinition[] = [
  {
    endpoint: 'http://localhost:1234/v1/models',
    source: 'openai_v1_models',
    parser: parseOpenAiModelsPayload,
  },
  {
    endpoint: 'http://localhost:1234/api/v1/models',
    source: 'lmstudio_api_v1_models',
    parser: parseLmStudioModelsPayload,
  },
];

const RUNTIME_ADAPTERS: Record<LocalRuntimeId, RuntimeModelAdapter> = {
  ollama: {
    runtime: 'ollama',
    modelEndpoints: OLLAMA_MODEL_ENDPOINTS,
    embeddingProbeEndpoints: [
      'http://127.0.0.1:11434/v1/embeddings',
      'http://127.0.0.1:11434/api/embeddings',
    ],
  },
  lmstudio: {
    runtime: 'lmstudio',
    modelEndpoints: LM_STUDIO_MODEL_ENDPOINTS,
    embeddingProbeEndpoints: ['http://localhost:1234/v1/embeddings'],
  },
};

function getOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseOpenAiModelsPayload(payload: unknown): readonly RuntimeModelCandidate[] | null {
  if (!(isRecord(payload) && Array.isArray(payload['data']))) {
    return null;
  }

  const models: RuntimeModelCandidate[] = [];
  for (const item of payload['data']) {
    if (!isRecord(item)) {
      continue;
    }
    const id = getOptionalString(item['id']);
    if (!id) {
      continue;
    }
    const label = getOptionalString(item['name']) ?? id;
    models.push({ id, label });
  }

  return models;
}

function parseOllamaTagsPayload(payload: unknown): readonly RuntimeModelCandidate[] | null {
  if (!(isRecord(payload) && Array.isArray(payload['models']))) {
    return null;
  }

  const models: RuntimeModelCandidate[] = [];
  for (const item of payload['models']) {
    if (!isRecord(item)) {
      continue;
    }
    const id =
      getOptionalString(item['name']) ??
      getOptionalString(item['model']) ??
      getOptionalString(item['id']);
    if (!id) {
      continue;
    }
    const label = getOptionalString(item['name']) ?? id;
    models.push({ id, label });
  }

  return models;
}

function parseLmStudioModelsPayload(payload: unknown): readonly RuntimeModelCandidate[] | null {
  if (Array.isArray(payload)) {
    const models: RuntimeModelCandidate[] = [];
    for (const item of payload) {
      if (!isRecord(item)) {
        continue;
      }
      const id = getOptionalString(item['id']);
      if (!id) {
        continue;
      }
      const label = getOptionalString(item['name']) ?? id;
      models.push({ id, label });
    }
    return models;
  }

  return parseOpenAiModelsPayload(payload);
}

function sanitizeVerificationLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_VERIFICATION_MODELS;
  }
  return Math.floor(value);
}

function isReachableRuntimeState(state: LocalRuntimeAvailabilityState['state']): boolean {
  return state === 'available' || state === 'stale';
}

function buildRuntimeAvailabilityMessage(
  runtime: LocalRuntimeId,
  availability: LocalRuntimeAvailabilityState
): string {
  switch (availability.state) {
    case 'available':
      return `${runtime} is available.`;
    case 'stale':
      return `${runtime} probe is stale.`;
    case 'checking':
      return `Checking ${runtime} availability.`;
    case 'blocked_web':
      return availability.message;
    case 'auth_required':
      return `${runtime} requires authentication at ${availability.endpoint}.`;
    case 'incompatible':
      return availability.message;
    case 'unavailable':
      return availability.message ?? `${runtime} is unavailable.`;
    default:
      return `${runtime} availability is unknown.`;
  }
}

function inferModelCapabilities(
  modelId: string,
  displayName: string
): {
  readonly llm: boolean;
  readonly embeddings: LocalRuntimeEmbeddingCapability;
  readonly dimensionsKnown: LocalRuntimeDimensionsState;
} {
  const searchable = `${modelId} ${displayName}`.toLowerCase();
  const hasEmbeddingHint = EMBEDDING_NAME_PATTERN.test(searchable);
  const hasChatHint = CHAT_NAME_PATTERN.test(searchable);

  if (hasEmbeddingHint) {
    // Prefer embedding classification when both patterns match so "embedding"-labeled
    // models remain actionable for this catalog even if names also contain chat terms.
    return {
      llm: hasChatHint,
      embeddings: 'supported',
      dimensionsKnown: { state: 'needs_verification' },
    };
  }

  if (hasChatHint) {
    return {
      llm: true,
      embeddings: 'unsupported',
      dimensionsKnown: { state: 'not_applicable' },
    };
  }

  // Unknown model families are treated as LLM-capable and embedding-uncertain so
  // custom names still surface and can be verified through runtime probing.
  return {
    llm: true,
    embeddings: 'needs_verification',
    dimensionsKnown: { state: 'needs_verification' },
  };
}

function extractEmbeddingDimensions(payload: unknown): number | null {
  if (!isRecord(payload)) {
    return null;
  }

  const direct = payload['embedding'];
  if (Array.isArray(direct)) {
    return direct.length;
  }

  const data = payload['data'];
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const first = data[0];
  if (!(isRecord(first) && Array.isArray(first['embedding']))) {
    return null;
  }

  return first['embedding'].length;
}

function setModelFreshness(
  model: LocalRuntimeNormalizedModel,
  freshness: LocalRuntimeModelFreshness
): LocalRuntimeNormalizedModel {
  if (model.freshness === freshness) {
    return model;
  }
  return { ...model, freshness };
}

export interface LocalRuntimeEmbeddingDimensionVerified {
  readonly checkedAt: number;
  readonly dimensions: number;
  readonly endpoint: string;
  readonly state: 'verified';
}

export interface LocalRuntimeEmbeddingDimensionUnsupported {
  readonly checkedAt: number;
  readonly endpoint: string;
  readonly message: string;
  readonly state: 'unsupported';
}

export interface LocalRuntimeEmbeddingDimensionFailed {
  readonly checkedAt: number;
  readonly message: string;
  readonly state: 'failed';
}

export type LocalRuntimeEmbeddingDimensionProbeResult =
  | LocalRuntimeEmbeddingDimensionVerified
  | LocalRuntimeEmbeddingDimensionUnsupported
  | LocalRuntimeEmbeddingDimensionFailed;

export class LocalRuntimeModelCatalogService {
  private readonly discoveryService: LocalRuntimeDiscoveryService;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly successTtlMs: number;
  private readonly failureBaseBackoffMs: number;
  private readonly failureMaxBackoffMs: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<LocalRuntimeId, RuntimeModelCacheEntry>();

  public constructor(options: LocalRuntimeModelCatalogServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.successTtlMs = sanitizeDuration(options.successTtlMs, DEFAULT_SUCCESS_TTL_MS);
    this.failureBaseBackoffMs = sanitizeDuration(
      options.failureBaseBackoffMs,
      DEFAULT_FAILURE_BASE_BACKOFF_MS
    );
    this.failureMaxBackoffMs = sanitizeDuration(
      options.failureMaxBackoffMs,
      DEFAULT_FAILURE_MAX_BACKOFF_MS
    );
    this.requestTimeoutMs = sanitizeDuration(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);

    if (options.discoveryService) {
      this.discoveryService = options.discoveryService;
    } else {
      this.discoveryService = new LocalRuntimeDiscoveryService({
        fetchImpl: this.fetchImpl,
        ...(options.defaultSurface ? { defaultSurface: options.defaultSurface } : {}),
        now: this.now,
      });
    }
  }

  public clearCache(runtime?: LocalRuntimeId): void {
    if (runtime) {
      this.cache.delete(runtime);
      return;
    }
    this.cache.clear();
  }

  public getCachedState(runtime: LocalRuntimeId): LocalRuntimeModelCatalogState | null {
    return this.cache.get(runtime)?.status ?? null;
  }

  public async listAllModels(
    options: ListAllLocalRuntimeModelsOptions = {}
  ): Promise<Record<LocalRuntimeId, LocalRuntimeModelCatalogState>> {
    const [ollama, lmstudio] = await Promise.all([
      this.listRuntimeModels('ollama', options),
      this.listRuntimeModels('lmstudio', options),
    ]);

    return {
      ollama,
      lmstudio,
    };
  }

  public async listRuntimeModels(
    runtime: LocalRuntimeId,
    options: ListLocalRuntimeModelsOptions = {}
  ): Promise<LocalRuntimeModelCatalogState> {
    const now = this.now();
    const cached = this.cache.get(runtime);

    if (!(options.force ?? false) && cached && now < cached.nextRefreshAt) {
      return cached.status;
    }

    const probeOptions: ProbeLocalRuntimeOptions = {
      ...(options.force ? { force: true } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.surface ? { surface: options.surface } : {}),
    };

    const availability = await this.discoveryService.probeRuntime(runtime, probeOptions);
    const checkedAt = this.now();

    if (!isReachableRuntimeState(availability.state)) {
      return this.persistFailure(runtime, checkedAt, availability, cached);
    }

    const adapter = RUNTIME_ADAPTERS[runtime];
    const endpoints = this.resolveEndpointOrder(adapter, availability);

    const loaded = await this.fetchAndNormalizeModels(runtime, availability, endpoints, {
      ...(options.signal ? { signal: options.signal } : {}),
      verifyEmbeddingDimensions: options.verifyEmbeddingDimensions ?? false,
      maxVerificationModels: sanitizeVerificationLimit(options.maxVerificationModels),
    });

    if (loaded.ok) {
      const shared = {
        runtime,
        checkedAt,
        availability,
        endpoint: loaded.endpoint.endpoint,
        source: loaded.endpoint.source,
        freshness: 'live' as const,
      };

      const state: LocalRuntimeModelCatalogState =
        loaded.models.length > 0
          ? { ...shared, state: 'loaded_non_empty' as const, models: loaded.models }
          : { ...shared, state: 'loaded_empty' as const, models: [] as const };

      this.cache.set(runtime, {
        status: state,
        nextRefreshAt: now + this.successTtlMs,
        consecutiveFailures: 0,
        lastSuccess: {
          checkedAt,
          endpoint: shared.endpoint,
          source: shared.source,
          models: loaded.models,
        },
      });

      return state;
    }

    return this.persistFailure(runtime, checkedAt, availability, cached, loaded.message);
  }

  public async verifyEmbeddingDimensions(
    runtime: LocalRuntimeId,
    modelId: string,
    options: {
      readonly signal?: AbortSignal;
      readonly probeText?: string;
    } = {}
  ): Promise<LocalRuntimeEmbeddingDimensionProbeResult> {
    if (!this.fetchImpl) {
      return {
        state: 'failed',
        checkedAt: this.now(),
        message: 'Fetch implementation is not available',
      };
    }

    const adapter = RUNTIME_ADAPTERS[runtime];
    const probePayload = JSON.stringify({
      model: modelId,
      input: options.probeText ?? DEFAULT_DIMENSION_PROBE_TEXT,
    });

    const unsupportedMessages: string[] = [];

    for (const endpoint of adapter.embeddingProbeEndpoints) {
      const outcome = await this.probeEmbeddingEndpoint(endpoint, probePayload, options.signal);
      if (outcome.kind === 'verified') {
        return outcome.result;
      }
      if (outcome.kind === 'failed') {
        return outcome.result;
      }
      unsupportedMessages.push(outcome.message);
    }

    if (unsupportedMessages.length > 0) {
      return this.buildUnsupportedProbeResult(adapter.embeddingProbeEndpoints, unsupportedMessages);
    }

    return {
      state: 'failed',
      checkedAt: this.now(),
      message: `No embedding probe endpoint configured for ${runtime}`,
    };
  }

  private async probeEmbeddingEndpoint(
    endpoint: string,
    payload: string,
    signal?: AbortSignal
  ): Promise<EmbeddingProbeOutcome> {
    if (!this.fetchImpl) {
      return {
        kind: 'failed',
        result: {
          state: 'failed',
          checkedAt: this.now(),
          message: 'Fetch implementation is not available',
        },
      };
    }

    const checkedAt = this.now();
    try {
      const result = await fetchJsonWithTimeout(endpoint, {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.requestTimeoutMs,
        ...(signal ? { signal } : {}),
        method: 'POST',
        body: payload,
      });

      if (!result.response.ok) {
        if ([400, 404, 405, 422, 501].includes(result.response.status)) {
          return {
            kind: 'unsupported',
            message: `Embedding probe unsupported (${result.response.status}) at ${endpoint}`,
          };
        }

        return {
          kind: 'failed',
          result: {
            state: 'failed',
            checkedAt,
            message: `Embedding probe failed (${result.response.status}) at ${endpoint}`,
          },
        };
      }

      if (result.parseError) {
        return {
          kind: 'unsupported',
          message: `Embedding probe returned invalid JSON at ${endpoint}`,
        };
      }

      const dimensions = extractEmbeddingDimensions(result.payload);
      if (typeof dimensions === 'number' && dimensions > 0) {
        return {
          kind: 'verified',
          result: {
            state: 'verified',
            checkedAt,
            endpoint,
            dimensions,
          },
        };
      }

      return {
        kind: 'unsupported',
        message: `Embedding probe returned no embedding vector at ${endpoint}`,
      };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      return {
        kind: 'unsupported',
        message: `Embedding probe error at ${endpoint}: ${extractErrorMessage(error)}`,
      };
    }
  }

  private buildUnsupportedProbeResult(
    endpoints: readonly string[],
    unsupportedMessages: readonly string[]
  ): LocalRuntimeEmbeddingDimensionUnsupported {
    return {
      state: 'unsupported',
      checkedAt: this.now(),
      endpoint: endpoints[0] ?? 'unknown',
      message: unsupportedMessages.at(-1) ?? 'Embedding probe reported unsupported response shape',
    };
  }

  private persistFailure(
    runtime: LocalRuntimeId,
    checkedAt: number,
    availability: LocalRuntimeAvailabilityState,
    cached: RuntimeModelCacheEntry | undefined,
    message?: string
  ): LocalRuntimeModelCatalogState {
    const failureMessage = message ?? buildRuntimeAvailabilityMessage(runtime, availability);
    const nextFailures = (cached?.consecutiveFailures ?? 0) + 1;
    const backoffMs = Math.min(
      this.failureMaxBackoffMs,
      this.failureBaseBackoffMs * 2 ** Math.max(0, nextFailures - 1)
    );

    const staleState = this.toStaleState(runtime, checkedAt, availability, failureMessage, cached);
    const nextStatus: LocalRuntimeModelCatalogState = staleState ?? {
      state: 'failed',
      runtime,
      checkedAt,
      availability,
      message: failureMessage,
    };

    this.cache.set(runtime, {
      status: nextStatus,
      nextRefreshAt: this.now() + backoffMs,
      consecutiveFailures: nextFailures,
      lastSuccess: cached?.lastSuccess ?? null,
    });

    return nextStatus;
  }

  private toStaleState(
    runtime: LocalRuntimeId,
    checkedAt: number,
    availability: LocalRuntimeAvailabilityState,
    message: string,
    cached: RuntimeModelCacheEntry | undefined
  ): LocalRuntimeModelsStaleCachedState | null {
    const lastSuccess = cached?.lastSuccess;
    if (!lastSuccess) {
      return null;
    }

    return {
      state: 'stale_cached',
      runtime,
      checkedAt,
      availability,
      message,
      endpoint: lastSuccess.endpoint,
      source: lastSuccess.source,
      freshness: 'stale_cached',
      lastSuccessfulAt: lastSuccess.checkedAt,
      models: lastSuccess.models.map((model) => setModelFreshness(model, 'stale_cached')),
    };
  }

  private resolveEndpointOrder(
    adapter: RuntimeModelAdapter,
    availability: LocalRuntimeAvailabilityState
  ): readonly RuntimeModelEndpointDefinition[] {
    if (!('endpoint' in availability && availability.endpoint)) {
      return adapter.modelEndpoints;
    }

    const preferred = adapter.modelEndpoints.find(
      (endpoint) => endpoint.endpoint === availability.endpoint
    );

    if (!preferred) {
      return adapter.modelEndpoints;
    }

    return [preferred, ...adapter.modelEndpoints.filter((endpoint) => endpoint !== preferred)];
  }

  private async fetchAndNormalizeModels(
    runtime: LocalRuntimeId,
    availability: LocalRuntimeAvailabilityState,
    endpoints: readonly RuntimeModelEndpointDefinition[],
    options: {
      readonly signal?: AbortSignal;
      readonly verifyEmbeddingDimensions: boolean;
      readonly maxVerificationModels: number;
    }
  ): Promise<
    | {
        readonly ok: true;
        readonly endpoint: RuntimeModelEndpointDefinition;
        readonly models: readonly LocalRuntimeNormalizedModel[];
      }
    | {
        readonly ok: false;
        readonly message: string;
      }
  > {
    if (!this.fetchImpl) {
      return {
        ok: false,
        message: 'Fetch implementation is not available',
      };
    }

    const errors: string[] = [];

    for (const endpoint of endpoints) {
      const attempt = await this.attemptModelEndpoint(runtime, endpoint, options);
      if (attempt.ok) {
        return {
          ok: true,
          endpoint,
          models: attempt.models,
        };
      }
      errors.push(attempt.message);
    }

    return {
      ok: false,
      message: errors.at(-1) ?? buildRuntimeAvailabilityMessage(runtime, availability),
    };
  }

  private async attemptModelEndpoint(
    runtime: LocalRuntimeId,
    endpoint: RuntimeModelEndpointDefinition,
    options: {
      readonly signal?: AbortSignal;
      readonly verifyEmbeddingDimensions: boolean;
      readonly maxVerificationModels: number;
    }
  ): Promise<ModelEndpointAttemptOutcome> {
    if (!this.fetchImpl) {
      return {
        ok: false,
        message: 'Fetch implementation is not available',
      };
    }

    try {
      const result = await fetchJsonWithTimeout(endpoint.endpoint, {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.requestTimeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });

      if (!result.response.ok) {
        return {
          ok: false,
          message: `Model list failed (${result.response.status}) at ${endpoint.endpoint}`,
        };
      }

      if (result.parseError) {
        return {
          ok: false,
          message: `Model list returned invalid JSON at ${endpoint.endpoint}`,
        };
      }

      const parsed = endpoint.parser(result.payload);
      if (!parsed) {
        return {
          ok: false,
          message: `Unexpected model list payload at ${endpoint.endpoint}`,
        };
      }

      const dedupedCandidates = this.dedupeCandidates(parsed);
      let normalized = this.normalizeModels(runtime, endpoint, dedupedCandidates);

      if (options.verifyEmbeddingDimensions) {
        normalized = await this.applyEmbeddingVerification(runtime, normalized, {
          ...(options.signal ? { signal: options.signal } : {}),
          maxVerificationModels: options.maxVerificationModels,
        });
      }

      return {
        ok: true,
        models: normalized.map((model) => ({
          ...model,
          freshness: 'live',
        })),
      };
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      return {
        ok: false,
        message: `Model list probe error at ${endpoint.endpoint}: ${extractErrorMessage(error)}`,
      };
    }
  }

  private dedupeCandidates(
    candidates: readonly RuntimeModelCandidate[]
  ): readonly RuntimeModelCandidate[] {
    const byId = new Map<string, RuntimeModelCandidate>();
    for (const candidate of candidates) {
      const id = candidate.id.trim();
      if (id.length === 0 || byId.has(id)) {
        continue;
      }
      byId.set(id, {
        id,
        label: candidate.label.trim().length > 0 ? candidate.label.trim() : id,
      });
    }

    return Array.from(byId.values()).sort((a, b) => defaultCollator.compare(a.id, b.id));
  }

  private normalizeModels(
    runtime: LocalRuntimeId,
    endpoint: RuntimeModelEndpointDefinition,
    candidates: readonly RuntimeModelCandidate[]
  ): readonly LocalRuntimeNormalizedModel[] {
    const normalized = candidates.map((candidate) => {
      const inferred = inferModelCapabilities(candidate.id, candidate.label);
      return {
        runtime,
        providerId: runtime,
        modelId: candidate.id,
        modelKey: `${runtime}::${candidate.id}`,
        displayName: candidate.label,
        endpoint: endpoint.endpoint,
        source: endpoint.source,
        freshness: 'live' as const,
        capabilities: {
          llm: inferred.llm,
          embeddings: inferred.embeddings,
        },
        dimensionsKnown: inferred.dimensionsKnown,
      } satisfies LocalRuntimeNormalizedModel;
    });

    return normalized.sort((a, b) => defaultCollator.compare(a.modelKey, b.modelKey));
  }

  private async applyEmbeddingVerification(
    runtime: LocalRuntimeId,
    models: readonly LocalRuntimeNormalizedModel[],
    options: {
      readonly signal?: AbortSignal;
      readonly maxVerificationModels: number;
    }
  ): Promise<readonly LocalRuntimeNormalizedModel[]> {
    const result: LocalRuntimeNormalizedModel[] = [];
    let remaining = options.maxVerificationModels;

    // Verify sequentially to avoid overwhelming local runtimes with concurrent
    // embedding requests during initial catalog hydration.
    for (const model of models) {
      const shouldVerify =
        remaining > 0 &&
        (model.capabilities.embeddings === 'supported' ||
          model.capabilities.embeddings === 'needs_verification');

      if (!shouldVerify) {
        result.push(model);
        continue;
      }

      remaining -= 1;
      const verification = await this.verifyEmbeddingDimensions(runtime, model.modelId, {
        ...(options.signal ? { signal: options.signal } : {}),
      });

      if (verification.state === 'verified') {
        result.push({
          ...model,
          capabilities: {
            ...model.capabilities,
            embeddings: 'supported',
          },
          dimensionsKnown: {
            state: 'known',
            values: [verification.dimensions],
            verifiedAt: verification.checkedAt,
            endpoint: verification.endpoint,
          },
        });
        continue;
      }

      if (verification.state === 'unsupported') {
        result.push({
          ...model,
          capabilities: {
            ...model.capabilities,
            embeddings: 'unsupported',
          },
          dimensionsKnown: { state: 'not_applicable' },
        });
        continue;
      }

      result.push(model);
    }

    return result;
  }
}
