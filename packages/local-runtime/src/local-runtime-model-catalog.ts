import {
  type LocalRuntimeAvailabilityState,
  LocalRuntimeDiscoveryService,
  type LocalRuntimeId,
  type ProbeLocalRuntimeOptions,
  resolveRuntimeBaseUrl,
} from './local-runtime-discovery.js';
import type {
  ListAllLocalRuntimeModelsOptions,
  ListLocalRuntimeModelsOptions,
  LocalRuntimeEmbeddingDimensionProbeResult,
  LocalRuntimeEmbeddingDimensionUnsupported,
  LocalRuntimeModelCatalogServiceOptions,
  LocalRuntimeModelCatalogState,
  LocalRuntimeModelsStaleCachedState,
  LocalRuntimeNormalizedModel,
  LocalRuntimeOllamaCapabilitiesResolved,
  LocalRuntimeOllamaCapabilitiesResult,
} from './local-runtime-model-catalog-types.js';
import {
  buildRuntimeAvailabilityMessage,
  buildRuntimeEmbeddingProbeEndpoints,
  buildRuntimeModelEndpoints,
  DEFAULT_DIMENSION_PROBE_TEXT,
  DEFAULT_FAILURE_BASE_BACKOFF_MS,
  DEFAULT_FAILURE_MAX_BACKOFF_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SUCCESS_TTL_MS,
  defaultCollator,
  type EmbeddingProbeOutcome,
  extractEmbeddingDimensions,
  isReachableRuntimeState,
  type ModelEndpointAttemptOutcome,
  OLLAMA_CAPABILITIES_CACHE_MAX_ENTRIES,
  OLLAMA_SHOW_PATH,
  type OllamaCapabilitiesCacheEntry,
  parseOllamaCapabilityList,
  parseOllamaContextLength,
  type RuntimeModelCacheEntry,
  type RuntimeModelCandidate,
  type RuntimeModelEndpointDefinition,
  resolveCandidateCapabilities,
  sanitizeVerificationLimit,
  setModelFreshness,
} from './local-runtime-model-parsing.js';
import { hydrateOllamaModelCapabilities } from './local-runtime-ollama-capabilities.js';
import {
  buildRuntimeAuthHeaders,
  buildRuntimeEndpoint,
  extractErrorMessage,
  fetchJsonWithTimeout,
  isRecord,
  type LocalRuntimeEndpointConfig,
  type LocalRuntimeLogger,
  noopLocalRuntimeLogger,
  sanitizeDuration,
} from './local-runtime-utils.js';

export {
  isLoadedRuntimeModelCatalogState,
  type ListLocalRuntimeModelsOptions,
  type LoadedRuntimeModelCatalogState,
  type LocalRuntimeCapabilitySource,
  type LocalRuntimeDimensionsState,
  type LocalRuntimeEmbeddingCapability,
  type LocalRuntimeEmbeddingDimensionFailed,
  type LocalRuntimeEmbeddingDimensionProbeResult,
  type LocalRuntimeEmbeddingDimensionUnsupported,
  type LocalRuntimeEmbeddingDimensionVerified,
  type LocalRuntimeKnownDimensionsState,
  type LocalRuntimeModelCatalogServiceOptions,
  type LocalRuntimeModelCatalogState,
  type LocalRuntimeModelFreshness,
  type LocalRuntimeModelSource,
  type LocalRuntimeModelsFailedState,
  type LocalRuntimeModelsLoadedEmptyState,
  type LocalRuntimeModelsLoadedNonEmptyState,
  type LocalRuntimeModelsStaleCachedState,
  type LocalRuntimeModelType,
  type LocalRuntimeNeedsVerificationDimensionsState,
  type LocalRuntimeNormalizedModel,
  type LocalRuntimeNotApplicableDimensionsState,
  type LocalRuntimeOllamaCapabilitiesResolved,
  type LocalRuntimeOllamaCapabilitiesResult,
  type LocalRuntimeOllamaCapabilitiesUnavailable,
  type OllamaModelCapability,
} from './local-runtime-model-catalog-types.js';

export class LocalRuntimeModelCatalogService {
  private readonly discoveryService: LocalRuntimeDiscoveryService;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly successTtlMs: number;
  private readonly failureBaseBackoffMs: number;
  private readonly failureMaxBackoffMs: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly logger: LocalRuntimeLogger;
  private readonly cache = new Map<LocalRuntimeId, RuntimeModelCacheEntry>();
  private readonly inFlightLists = new Map<string, Promise<LocalRuntimeModelCatalogState>>();
  // Per-model cache of resolved Ollama capabilities, keyed by
  // `${baseUrl}::${modelId}`. A short TTL keeps answers fresh when users
  // pull new model revisions locally. Bounded at
  // OLLAMA_CAPABILITIES_CACHE_MAX_ENTRIES because we also key on baseUrl —
  // a user cycling through many remote hosts or renaming models could
  // otherwise grow the map monotonically until `clearCache()`. We track
  // insertion order via `Map`'s iteration contract and evict the oldest
  // entry when we exceed the cap.
  private readonly ollamaCapabilitiesCache = new Map<string, OllamaCapabilitiesCacheEntry>();

  public constructor(options: LocalRuntimeModelCatalogServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    // Bind the ambient default: `globalThis.fetch` captured bare loses its
    // receiver, and the browser rejects the call (BST-964). Only the fallback
    // is bound — a caller-supplied impl keeps whatever `this` it was written
    // against.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
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
    this.logger = options.logger ?? noopLocalRuntimeLogger;

    if (options.discoveryService) {
      this.discoveryService = options.discoveryService;
    } else {
      this.discoveryService = new LocalRuntimeDiscoveryService({
        fetchImpl: this.fetchImpl,
        ...(options.defaultSurface ? { defaultSurface: options.defaultSurface } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
        now: this.now,
      });
    }
  }

  public clearCache(runtime?: LocalRuntimeId): void {
    if (runtime) {
      this.cache.delete(runtime);
      for (const key of this.inFlightLists.keys()) {
        if (key.startsWith(`${runtime}\u0000`)) {
          this.inFlightLists.delete(key);
        }
      }
      return;
    }
    this.cache.clear();
    this.inFlightLists.clear();
    this.ollamaCapabilitiesCache.clear();
  }

  public getCachedState(runtime: LocalRuntimeId): LocalRuntimeModelCatalogState | null {
    return this.cache.get(runtime)?.status ?? null;
  }

  /**
   * Resolve a model's capability set by calling Ollama's `POST /api/show`.
   *
   * `/api/show` is Ollama's authoritative source for per-model capabilities —
   * it returns an array like `["completion", "tools", "vision"]` directly, so
   * this method avoids the regex-on-name heuristics used during bulk listing.
   * Results are cached per model id using the catalog's `successTtlMs` budget
   * so repeated lookups do not refetch on every render.
   */
  public async resolveOllamaCapabilities(
    modelId: string,
    options: {
      readonly endpoint?: LocalRuntimeEndpointConfig;
      readonly force?: boolean;
      readonly signal?: AbortSignal;
    } = {}
  ): Promise<LocalRuntimeOllamaCapabilitiesResult> {
    const baseUrl = resolveRuntimeBaseUrl('ollama', options.endpoint?.baseUrl);
    const showEndpoint = buildRuntimeEndpoint(baseUrl, OLLAMA_SHOW_PATH);
    const trimmed = modelId.trim();
    if (trimmed.length === 0) {
      return {
        checkedAt: this.now(),
        endpoint: showEndpoint,
        message: 'modelId is required',
        modelId,
        state: 'unavailable',
      };
    }

    // Key the cache by `baseUrl + NUL + modelId` so switching hosts does not
    // return a stale capability set from a different server that happened to
    // ship the same model id. A null-byte separator avoids the theoretical
    // collision where a baseUrl containing `::` or a modelId containing
    // `::` could map to the same key as a different (baseUrl, modelId)
    // pair. Real Ollama names use `:` but never `::` or NUL, so this is
    // purely belt-and-braces — the collision has never been observed.
    const cacheKey = `${baseUrl}\u0000${trimmed}`;
    if (!options.force) {
      const cached = this.ollamaCapabilitiesCache.get(cacheKey);
      if (cached && this.now() < cached.expiresAt) {
        // Promote on hit so eviction is true LRU rather than FIFO. `Map`
        // iterates in insertion order, so delete-then-set moves the entry
        // to the back of the line and guarantees a frequently-used model
        // survives pressure from one-off lookups at different baseUrls.
        this.ollamaCapabilitiesCache.delete(cacheKey);
        this.ollamaCapabilitiesCache.set(cacheKey, cached);
        return cached.result;
      }
    }

    if (!this.fetchImpl) {
      return {
        checkedAt: this.now(),
        endpoint: showEndpoint,
        message: 'Fetch implementation is not available',
        modelId: trimmed,
        state: 'unavailable',
      };
    }

    const authHeaders = buildRuntimeAuthHeaders(options.endpoint);
    const checkedAt = this.now();
    try {
      const result = await fetchJsonWithTimeout(showEndpoint, {
        body: JSON.stringify({ model: trimmed }),
        fetchImpl: this.fetchImpl,
        method: 'POST',
        timeoutMs: this.requestTimeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(authHeaders ? { headers: authHeaders } : {}),
      });

      if (!result.response.ok) {
        return {
          checkedAt,
          endpoint: showEndpoint,
          message: `Ollama /api/show responded with ${result.response.status}`,
          modelId: trimmed,
          state: 'unavailable',
          status: result.response.status,
        };
      }

      if (result.parseError) {
        return {
          checkedAt,
          endpoint: showEndpoint,
          message: 'Ollama /api/show returned non-JSON payload',
          modelId: trimmed,
          state: 'unavailable',
        };
      }

      if (!(isRecord(result.payload) && Array.isArray(result.payload['capabilities']))) {
        return {
          checkedAt,
          endpoint: showEndpoint,
          message:
            'Ollama /api/show returned no capabilities array. Update Ollama to a version that exposes the documented capabilities field, then retry discovery.',
          modelId: trimmed,
          state: 'unavailable',
        };
      }

      const capabilities = parseOllamaCapabilityList(result.payload);
      const resolved: LocalRuntimeOllamaCapabilitiesResolved = {
        capabilities,
        checkedAt,
        contextLength: parseOllamaContextLength(result.payload),
        embedding: capabilities.includes('embedding'),
        endpoint: showEndpoint,
        insert: capabilities.includes('insert'),
        llm: capabilities.includes('completion'),
        modelId: trimmed,
        state: 'resolved',
        thinking: capabilities.includes('thinking'),
        tools: capabilities.includes('tools'),
        vision: capabilities.includes('vision'),
      };
      // Evict the least-recently-used entry once we exceed the cap. Map
      // iterates in insertion order, so the first key is the oldest — but
      // cache hits promote entries via delete+reinsert (see the hit-path
      // above) so the iteration-order truly tracks access order, not just
      // insertion time. Refreshed entries also move to the back on this
      // .set(), keeping the LRU semantics consistent across both paths.
      if (this.ollamaCapabilitiesCache.size >= OLLAMA_CAPABILITIES_CACHE_MAX_ENTRIES) {
        const oldestKey = this.ollamaCapabilitiesCache.keys().next().value;
        if (typeof oldestKey === 'string') {
          this.ollamaCapabilitiesCache.delete(oldestKey);
        }
      }
      this.ollamaCapabilitiesCache.set(cacheKey, {
        expiresAt: checkedAt + this.successTtlMs,
        result: resolved,
      });
      return resolved;
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      return {
        checkedAt,
        endpoint: showEndpoint,
        message: `Ollama /api/show request failed: ${extractErrorMessage(error)}`,
        modelId: trimmed,
        state: 'unavailable',
      };
    }
  }

  public async listAllModels(
    options: ListAllLocalRuntimeModelsOptions = {}
  ): Promise<Record<LocalRuntimeId, LocalRuntimeModelCatalogState>> {
    const [ollama, lmstudio] = await Promise.all([
      this.listRuntimeModels('ollama', options),
      this.listRuntimeModels('lmstudio', options),
    ]);

    return {
      lmstudio,
      ollama,
    };
  }

  public async listRuntimeModels(
    runtime: LocalRuntimeId,
    options: ListLocalRuntimeModelsOptions = {}
  ): Promise<LocalRuntimeModelCatalogState> {
    const now = this.now();
    const cached = this.cache.get(runtime);
    const effectiveBaseUrl = resolveRuntimeBaseUrl(runtime, options.endpoint?.baseUrl);

    // Cache is keyed by the resolved origin so switching hosts (auto → remote
    // GPU box, or toggling the user-configured baseUrl) invalidates any stale
    // entry from the previous target. Matching the discovery service's
    // behaviour keeps the two caches coherent.
    const cacheFresh =
      cached !== undefined && cached.baseUrl === effectiveBaseUrl && now < cached.nextRefreshAt;
    if (!(options.force ?? false) && cacheFresh && cached) {
      return cached.status;
    }

    const inFlightKey = this.getInFlightListKey(runtime, effectiveBaseUrl, options);
    if (inFlightKey) {
      const inFlight = this.inFlightLists.get(inFlightKey);
      if (inFlight) {
        return inFlight;
      }
    }

    const listPromise = this.listRuntimeModelsUnshared(runtime, options, {
      cached,
      effectiveBaseUrl,
      now,
    });

    if (!inFlightKey) {
      return listPromise;
    }

    this.inFlightLists.set(inFlightKey, listPromise);
    try {
      return await listPromise;
    } finally {
      if (this.inFlightLists.get(inFlightKey) === listPromise) {
        this.inFlightLists.delete(inFlightKey);
      }
    }
  }

  private getInFlightListKey(
    runtime: LocalRuntimeId,
    effectiveBaseUrl: string,
    options: ListLocalRuntimeModelsOptions
  ): string | null {
    if (options.signal || options.endpoint?.apiToken) {
      return null;
    }

    const surface = options.surface ?? 'default';
    const force = options.force ? 'force' : 'cache';
    const verify = options.verifyEmbeddingDimensions ? 'verify' : 'no-verify';
    const maxVerificationModels = options.maxVerificationModels ?? 'default';
    return [
      runtime,
      effectiveBaseUrl,
      surface,
      force,
      verify,
      String(maxVerificationModels),
      options.diagnosticLogLevel ?? 'warn',
    ].join('\u0000');
  }

  private async listRuntimeModelsUnshared(
    runtime: LocalRuntimeId,
    options: ListLocalRuntimeModelsOptions,
    context: {
      readonly cached: RuntimeModelCacheEntry | undefined;
      readonly effectiveBaseUrl: string;
      readonly now: number;
    }
  ): Promise<LocalRuntimeModelCatalogState> {
    const { cached, effectiveBaseUrl, now } = context;
    const probeOptions: ProbeLocalRuntimeOptions = {
      ...(options.force ? { force: true } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.surface ? { surface: options.surface } : {}),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.diagnosticLogLevel ? { diagnosticLogLevel: options.diagnosticLogLevel } : {}),
    };

    const availability = await this.discoveryService.probeRuntime(runtime, probeOptions);
    const checkedAt = this.now();

    if (!isReachableRuntimeState(availability.state)) {
      return this.persistFailure(
        runtime,
        checkedAt,
        availability,
        cached,
        undefined,
        effectiveBaseUrl,
        options.diagnosticLogLevel
      );
    }

    // Keep model endpoints in adapter authority order. Discovery may succeed
    // first through an OpenAI-compatible health probe, but that must not demote
    // richer native catalog endpoints that expose model type/capabilities.
    const endpoints = buildRuntimeModelEndpoints(runtime, options.endpoint);

    const loaded = await this.fetchAndNormalizeModels(runtime, availability, endpoints, {
      ...(options.force ? { force: true } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      maxVerificationModels: sanitizeVerificationLimit(options.maxVerificationModels),
      verifyEmbeddingDimensions: options.verifyEmbeddingDimensions ?? false,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    });

    if (loaded.ok) {
      const shared = {
        availability,
        checkedAt,
        endpoint: loaded.endpoint.endpoint,
        freshness: 'live' as const,
        runtime,
        source: loaded.endpoint.source,
      };

      const state: LocalRuntimeModelCatalogState =
        loaded.models.length > 0
          ? { ...shared, models: loaded.models, state: 'loaded_non_empty' as const }
          : { ...shared, models: [] as const, state: 'loaded_empty' as const };

      this.cache.set(runtime, {
        baseUrl: effectiveBaseUrl,
        consecutiveFailures: 0,
        lastSuccess: {
          checkedAt,
          endpoint: shared.endpoint,
          models: loaded.models,
          source: shared.source,
        },
        nextRefreshAt: now + this.successTtlMs,
        status: state,
      });

      return state;
    }

    return this.persistFailure(
      runtime,
      checkedAt,
      availability,
      cached,
      loaded.message,
      effectiveBaseUrl,
      options.diagnosticLogLevel
    );
  }

  public async verifyEmbeddingDimensions(
    runtime: LocalRuntimeId,
    modelId: string,
    options: {
      readonly endpoint?: LocalRuntimeEndpointConfig;
      readonly probeText?: string;
      readonly signal?: AbortSignal;
    } = {}
  ): Promise<LocalRuntimeEmbeddingDimensionProbeResult> {
    if (!this.fetchImpl) {
      return {
        checkedAt: this.now(),
        message: 'Fetch implementation is not available',
        state: 'failed',
      };
    }

    const probeEndpoints = buildRuntimeEmbeddingProbeEndpoints(runtime, options.endpoint);
    const probePayload = JSON.stringify({
      input: options.probeText ?? DEFAULT_DIMENSION_PROBE_TEXT,
      model: modelId,
    });

    const unsupportedMessages: string[] = [];

    // Rename the loop variable from `endpoint` to `probeUrl` so it no longer
    // shadows the surrounding `options.endpoint` (a `LocalRuntimeEndpointConfig`,
    // not a URL string). Reviewer flagged this as bug-adjacent because both
    // were named `endpoint` but carried completely different meanings.
    for (const probeUrl of probeEndpoints) {
      const outcome = await this.probeEmbeddingEndpoint(probeUrl, probePayload, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.endpoint ? { endpointConfig: options.endpoint } : {}),
      });
      if (outcome.kind === 'verified') {
        return outcome.result;
      }
      if (outcome.kind === 'failed') {
        return outcome.result;
      }
      unsupportedMessages.push(outcome.message);
    }

    if (unsupportedMessages.length > 0) {
      return this.buildUnsupportedProbeResult(probeEndpoints, unsupportedMessages);
    }

    return {
      checkedAt: this.now(),
      message: `No embedding probe endpoint configured for ${runtime}`,
      state: 'failed',
    };
  }

  private async probeEmbeddingEndpoint(
    probeUrl: string,
    payload: string,
    options: {
      readonly endpointConfig?: LocalRuntimeEndpointConfig;
      readonly signal?: AbortSignal;
    }
  ): Promise<EmbeddingProbeOutcome> {
    if (!this.fetchImpl) {
      return {
        kind: 'failed',
        result: {
          checkedAt: this.now(),
          message: 'Fetch implementation is not available',
          state: 'failed',
        },
      };
    }

    const { signal } = options;
    const authHeaders = buildRuntimeAuthHeaders(options.endpointConfig);
    const checkedAt = this.now();
    try {
      const result = await fetchJsonWithTimeout(probeUrl, {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.requestTimeoutMs,
        ...(signal ? { signal } : {}),
        ...(authHeaders ? { headers: authHeaders } : {}),
        body: payload,
        method: 'POST',
      });

      if (!result.response.ok) {
        if ([400, 404, 405, 422, 501].includes(result.response.status)) {
          return {
            kind: 'unsupported',
            message: `Embedding probe unsupported (${result.response.status}) at ${probeUrl}`,
          };
        }

        return {
          kind: 'failed',
          result: {
            checkedAt,
            message: `Embedding probe failed (${result.response.status}) at ${probeUrl}`,
            state: 'failed',
          },
        };
      }

      if (result.parseError) {
        return {
          kind: 'unsupported',
          message: `Embedding probe returned invalid JSON at ${probeUrl}`,
        };
      }

      const dimensions = extractEmbeddingDimensions(result.payload);
      if (typeof dimensions === 'number' && dimensions > 0) {
        return {
          kind: 'verified',
          result: {
            checkedAt,
            dimensions,
            endpoint: probeUrl,
            state: 'verified',
          },
        };
      }

      return {
        kind: 'unsupported',
        message: `Embedding probe returned no embedding vector at ${probeUrl}`,
      };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      return {
        kind: 'unsupported',
        message: `Embedding probe error at ${probeUrl}: ${extractErrorMessage(error)}`,
      };
    }
  }

  private buildUnsupportedProbeResult(
    endpoints: readonly string[],
    unsupportedMessages: readonly string[]
  ): LocalRuntimeEmbeddingDimensionUnsupported {
    return {
      checkedAt: this.now(),
      endpoint: endpoints[0] ?? 'unknown',
      message: unsupportedMessages.at(-1) ?? 'Embedding probe reported unsupported response shape',
      state: 'unsupported',
    };
  }

  private persistFailure(
    runtime: LocalRuntimeId,
    checkedAt: number,
    availability: LocalRuntimeAvailabilityState,
    cached: RuntimeModelCacheEntry | undefined,
    message?: string,
    baseUrl?: string,
    diagnosticLogLevel?: ListLocalRuntimeModelsOptions['diagnosticLogLevel']
  ): LocalRuntimeModelCatalogState {
    const failureMessage = message ?? buildRuntimeAvailabilityMessage(runtime, availability);
    const nextFailures = (cached?.consecutiveFailures ?? 0) + 1;
    const backoffMs = Math.min(
      this.failureMaxBackoffMs,
      this.failureBaseBackoffMs * 2 ** Math.max(0, nextFailures - 1)
    );

    const staleState = this.toStaleState(runtime, checkedAt, availability, failureMessage, cached);
    const nextStatus: LocalRuntimeModelCatalogState = staleState ?? {
      availability,
      checkedAt,
      message: failureMessage,
      runtime,
      state: 'failed',
    };

    const effectiveBaseUrl =
      baseUrl ?? cached?.baseUrl ?? resolveRuntimeBaseUrl(runtime, undefined);
    this.cache.set(runtime, {
      baseUrl: effectiveBaseUrl,
      consecutiveFailures: nextFailures,
      lastSuccess: cached?.lastSuccess ?? null,
      nextRefreshAt: this.now() + backoffMs,
      status: nextStatus,
    });

    // Surface the first catalog failure so "empty model dropdown while runtime
    // is reachable" is diagnosable without DevTools. Demote stale-cache and
    // repeated failures because unavailable local runtimes are normal when the
    // user does not run Ollama or LM Studio.
    const catalogFailurePayload = {
      availability: availability.state,
      consecutiveFailures: nextFailures,
      message: failureMessage,
      runtime,
      state: nextStatus.state,
    };
    if (nextStatus.state === 'stale_cached' || nextFailures > 1 || diagnosticLogLevel === 'debug') {
      this.logger.debug('local runtime model catalog failed', catalogFailurePayload);
    } else {
      this.logger.warn('local runtime model catalog failed', catalogFailurePayload);
    }

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
      availability,
      checkedAt,
      endpoint: lastSuccess.endpoint,
      freshness: 'stale_cached',
      lastSuccessfulAt: lastSuccess.checkedAt,
      message,
      models: lastSuccess.models.map((model) => setModelFreshness(model, 'stale_cached')),
      runtime,
      source: lastSuccess.source,
      state: 'stale_cached',
    };
  }

  private async fetchAndNormalizeModels(
    runtime: LocalRuntimeId,
    availability: LocalRuntimeAvailabilityState,
    endpoints: readonly RuntimeModelEndpointDefinition[],
    options: {
      readonly endpoint?: LocalRuntimeEndpointConfig;
      readonly force?: boolean;
      readonly maxVerificationModels: number;
      readonly signal?: AbortSignal;
      readonly verifyEmbeddingDimensions: boolean;
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
        message: 'Fetch implementation is not available',
        ok: false,
      };
    }

    const errors: string[] = [];

    for (const endpoint of endpoints) {
      const attempt = await this.attemptModelEndpoint(runtime, endpoint, options);
      if (attempt.ok) {
        return {
          endpoint,
          models: attempt.models,
          ok: true,
        };
      }
      errors.push(attempt.message);
      if (attempt.terminal) {
        return attempt;
      }
    }

    return {
      message: errors.at(-1) ?? buildRuntimeAvailabilityMessage(runtime, availability),
      ok: false,
    };
  }

  private async attemptModelEndpoint(
    runtime: LocalRuntimeId,
    endpoint: RuntimeModelEndpointDefinition,
    options: {
      readonly endpoint?: LocalRuntimeEndpointConfig;
      readonly force?: boolean;
      readonly maxVerificationModels: number;
      readonly signal?: AbortSignal;
      readonly verifyEmbeddingDimensions: boolean;
    }
  ): Promise<ModelEndpointAttemptOutcome> {
    if (!this.fetchImpl) {
      return {
        message: 'Fetch implementation is not available',
        ok: false,
      };
    }

    const authHeaders = buildRuntimeAuthHeaders(options.endpoint);
    try {
      const result = await fetchJsonWithTimeout(endpoint.endpoint, {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.requestTimeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(authHeaders ? { headers: authHeaders } : {}),
      });

      if (!result.response.ok) {
        return {
          message: `Model list failed (${result.response.status}) at ${endpoint.endpoint}`,
          ok: false,
        };
      }

      if (result.parseError) {
        return {
          message: `Model list returned invalid JSON at ${endpoint.endpoint}`,
          ok: false,
        };
      }

      const parsed = endpoint.parser(result.payload);
      if (!parsed) {
        return {
          message: `Unexpected model list payload at ${endpoint.endpoint}`,
          ok: false,
        };
      }

      const dedupedCandidates = this.dedupeCandidates(parsed);
      let normalized = this.normalizeModels(runtime, endpoint, dedupedCandidates);

      if (runtime === 'ollama' && endpoint.source === 'ollama_api_tags') {
        const reportedCapabilities = await hydrateOllamaModelCapabilities(normalized, (modelId) =>
          this.resolveOllamaCapabilities(modelId, {
            ...(options.endpoint ? { endpoint: options.endpoint } : {}),
            ...(options.force ? { force: true } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
          })
        );
        if (!reportedCapabilities.ok) {
          return { ...reportedCapabilities, terminal: true };
        }
        normalized = reportedCapabilities.models;
      }

      if (options.verifyEmbeddingDimensions) {
        normalized = await this.applyEmbeddingVerification(runtime, normalized, {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.endpoint ? { endpoint: options.endpoint } : {}),
          maxVerificationModels: options.maxVerificationModels,
        });
      }

      return {
        models: normalized.map((model) => ({
          ...model,
          freshness: 'live',
        })),
        ok: true,
      };
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      return {
        message: `Model list probe error at ${endpoint.endpoint}: ${extractErrorMessage(error)}`,
        ok: false,
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
      // Pick explicitly rather than spreading the candidate. Parsers build
      // candidates from untrusted JSON bodies; a future Ollama or LM Studio
      // response field would otherwise silently ride through into
      // `LocalRuntimeNormalizedModel` via `normalizeModels`'s own spread.
      byId.set(id, {
        id,
        label: candidate.label.trim().length > 0 ? candidate.label.trim() : id,
        ...(candidate.families ? { families: candidate.families } : {}),
        ...(candidate.modelType ? { modelType: candidate.modelType } : {}),
        ...(typeof candidate.loaded === 'boolean' ? { loaded: candidate.loaded } : {}),
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
      const resolved = resolveCandidateCapabilities(candidate);
      return {
        capabilities: {
          embeddings: resolved.embeddings,
          llm: resolved.llm,
          vision: resolved.vision,
        },
        capabilitySource: resolved.capabilitySource,
        dimensionsKnown: resolved.dimensionsKnown,
        displayName: candidate.label,
        endpoint: endpoint.endpoint,
        freshness: 'live' as const,
        modelId: candidate.id,
        modelKey: `${runtime}::${candidate.id}`,
        providerId: runtime,
        runtime,
        source: endpoint.source,
        ...(candidate.modelType ? { modelType: candidate.modelType } : {}),
        ...(typeof candidate.loaded === 'boolean' ? { loaded: candidate.loaded } : {}),
      } satisfies LocalRuntimeNormalizedModel;
    });

    return normalized.sort((a, b) => defaultCollator.compare(a.modelKey, b.modelKey));
  }

  private async applyEmbeddingVerification(
    runtime: LocalRuntimeId,
    models: readonly LocalRuntimeNormalizedModel[],
    options: {
      readonly endpoint?: LocalRuntimeEndpointConfig;
      readonly maxVerificationModels: number;
      readonly signal?: AbortSignal;
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
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      });

      if (verification.state === 'verified') {
        result.push({
          ...model,
          capabilities: {
            ...model.capabilities,
            embeddings: 'supported',
          },
          dimensionsKnown: {
            endpoint: verification.endpoint,
            state: 'known',
            values: [verification.dimensions],
            verifiedAt: verification.checkedAt,
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
