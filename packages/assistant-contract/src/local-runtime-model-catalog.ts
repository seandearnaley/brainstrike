import {
  type LocalRuntimeAvailabilityState,
  LocalRuntimeDiscoveryService,
  type LocalRuntimeId,
  type LocalRuntimeLogger,
  type ProbeLocalRuntimeOptions,
  resolveRuntimeBaseUrl,
} from './local-runtime-discovery.js';
import type {
  ListAllLocalRuntimeModelsOptions,
  ListLocalRuntimeModelsOptions,
  LocalRuntimeCapabilitySource,
  LocalRuntimeDimensionsState,
  LocalRuntimeEmbeddingCapability,
  LocalRuntimeEmbeddingDimensionFailed,
  LocalRuntimeEmbeddingDimensionProbeResult,
  LocalRuntimeEmbeddingDimensionUnsupported,
  LocalRuntimeEmbeddingDimensionVerified,
  LocalRuntimeModelCatalogServiceOptions,
  LocalRuntimeModelCatalogState,
  LocalRuntimeModelFreshness,
  LocalRuntimeModelSource,
  LocalRuntimeModelsStaleCachedState,
  LocalRuntimeModelType,
  LocalRuntimeNormalizedModel,
  LocalRuntimeOllamaCapabilitiesResolved,
  LocalRuntimeOllamaCapabilitiesResult,
  OllamaModelCapability,
} from './local-runtime-model-catalog-types.js';
import {
  buildRuntimeAuthHeaders,
  buildRuntimeEndpoint,
  extractErrorMessage,
  fetchJsonWithTimeout,
  isRecord,
  type LocalRuntimeEndpointConfig,
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

const defaultCollator = new Intl.Collator(undefined);

interface RuntimeModelCandidate {
  /**
   * Ollama `details.families`, if present. Used as a capability hint when the
   * catalog does not include a canonical `type` field.
   */
  readonly families?: readonly string[];
  readonly id: string;
  readonly label: string;
  /**
   * LM Studio runtime-reported load state (0.4.0+ native endpoints).
   */
  readonly loaded?: boolean;
  /**
   * Canonical model type when reported by the runtime (LM Studio native).
   */
  readonly modelType?: LocalRuntimeModelType;
}

interface RuntimeModelEndpointDefinition {
  readonly endpoint: string;
  readonly parser: (payload: unknown) => readonly RuntimeModelCandidate[] | null;
  readonly source: LocalRuntimeModelSource;
}

interface RuntimeModelPathDefinition {
  readonly parser: (payload: unknown) => readonly RuntimeModelCandidate[] | null;
  readonly path: string;
  readonly source: LocalRuntimeModelSource;
}

interface RuntimeModelAdapter {
  readonly embeddingProbePaths: readonly string[];
  readonly modelPaths: readonly RuntimeModelPathDefinition[];
  readonly runtime: LocalRuntimeId;
}

interface RuntimeModelSuccessSnapshot {
  readonly checkedAt: number;
  readonly endpoint: string;
  readonly models: readonly LocalRuntimeNormalizedModel[];
  readonly source: LocalRuntimeModelSource;
}

interface RuntimeModelCacheEntry {
  readonly baseUrl: string;
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
// Realistic workloads touch tens of models; 200 leaves ample headroom for
// users cycling between local/remote runtimes and renaming models without
// letting the Map grow unbounded across a long session.
const OLLAMA_CAPABILITIES_CACHE_MAX_ENTRIES = 200;

const EMBEDDING_NAME_PATTERN =
  /(embed|embedding|text-embedding|nomic-embed|jina-embeddings|bge|e5|gte|arctic-embed|voyage)/i;
const CHAT_NAME_PATTERN =
  /(chat|instruct|llama|qwen|mistral|gemma|phi|deepseek|gpt|claude|sonnet|haiku|opus|command-r|mixtral)/i;

// `/api/tags` is listed first for Ollama because it includes `details.families`,
// which lets us infer embedding capability without a follow-up request. The
// OpenAI-compatible `/v1/models` endpoint returns only `{id}` and is kept as a
// compatibility fallback for older Ollama builds or non-default configurations.
const OLLAMA_MODEL_PATHS: readonly RuntimeModelPathDefinition[] = [
  { path: '/api/tags', source: 'ollama_api_tags', parser: parseOllamaTagsPayload },
  { path: '/v1/models', source: 'openai_v1_models', parser: parseOpenAiModelsPayload },
];

// Native `/api/v1/models` (LM Studio 0.4.0+) and `/api/v0/models` (legacy but
// still shipped) include `type`, `state`, `arch`, and `quantization` fields that
// the OpenAI-compatible `/v1/models` endpoint strips. Prefer them so the catalog
// surfaces authoritative LLM/embedding/vision classifications; fall back to the
// OpenAI shape for forward-compat if the native paths are ever disabled.
const LM_STUDIO_MODEL_PATHS: readonly RuntimeModelPathDefinition[] = [
  { path: '/api/v1/models', source: 'lmstudio_api_v1_models', parser: parseLmStudioModelsPayload },
  { path: '/api/v0/models', source: 'lmstudio_api_v0_models', parser: parseLmStudioModelsPayload },
  { path: '/v1/models', source: 'openai_v1_models', parser: parseOpenAiModelsPayload },
];

const RUNTIME_ADAPTERS: Record<LocalRuntimeId, RuntimeModelAdapter> = {
  ollama: {
    runtime: 'ollama',
    modelPaths: OLLAMA_MODEL_PATHS,
    embeddingProbePaths: ['/v1/embeddings', '/api/embeddings'],
  },
  lmstudio: {
    runtime: 'lmstudio',
    modelPaths: LM_STUDIO_MODEL_PATHS,
    embeddingProbePaths: ['/v1/embeddings'],
  },
};

function buildRuntimeModelEndpoints(
  runtime: LocalRuntimeId,
  endpoint: LocalRuntimeEndpointConfig | undefined
): readonly RuntimeModelEndpointDefinition[] {
  const baseUrl = resolveRuntimeBaseUrl(runtime, endpoint?.baseUrl);
  return RUNTIME_ADAPTERS[runtime].modelPaths.map((definition) => ({
    endpoint: buildRuntimeEndpoint(baseUrl, definition.path),
    source: definition.source,
    parser: definition.parser,
  }));
}

function buildRuntimeEmbeddingProbeEndpoints(
  runtime: LocalRuntimeId,
  endpoint: LocalRuntimeEndpointConfig | undefined
): readonly string[] {
  const baseUrl = resolveRuntimeBaseUrl(runtime, endpoint?.baseUrl);
  return RUNTIME_ADAPTERS[runtime].embeddingProbePaths.map((path) =>
    buildRuntimeEndpoint(baseUrl, path)
  );
}

const OLLAMA_SHOW_PATH = '/api/show';

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

/**
 * Canonical Ollama `details.families` → `embeddings` mapping. Keep this the
 * single source of truth for "what counts as an embedding family" — when a
 * new Ollama embedding architecture ships (e.g. `jina`, `gte`, or any future
 * family), extend the predicate here and update the
 * `local-runtime-model-catalog` tests to cover the new slug.
 *
 * The current predicate handles the three observed patterns as of April 2026:
 *   - `bert` (raw BERT-style embedders)
 *   - `*-bert` (derivatives like `nomic-bert`)
 *   - anything containing `embed` (e.g. `nomic-embed-text`)
 *
 * IMPORTANT: `undefined` here means "not positively identified as an
 * embedding family — defer to the name-regex heuristic in
 * `inferCapabilitiesFromName`". It does NOT mean "unknown model type",
 * which is why we do NOT return `'llm'` for non-matching families the way
 * `parseLmStudioModelType` does for LM Studio's explicit discriminant.
 * Ollama's families field is a hint only; the LLM/embedding classification
 * for everything else falls through to the shared heuristic path.
 */
function parseOllamaModelType(value: unknown): LocalRuntimeModelType | undefined {
  if (!Array.isArray(value)) {
    return;
  }
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const lower = entry.toLowerCase();
    if (lower === 'bert' || lower.endsWith('-bert') || lower.includes('embed')) {
      return 'embeddings';
    }
  }
  return;
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

    const details = item['details'];
    const families =
      isRecord(details) && Array.isArray(details['families'])
        ? details['families'].filter((family): family is string => typeof family === 'string')
        : undefined;
    const inferredType = parseOllamaModelType(families);

    models.push({
      id,
      label,
      ...(families ? { families } : {}),
      ...(inferredType ? { modelType: inferredType } : {}),
    });
  }

  return models;
}

function parseLmStudioModelType(value: unknown): LocalRuntimeModelType | undefined {
  if (typeof value !== 'string') {
    return;
  }
  switch (value.toLowerCase()) {
    case 'llm':
      return 'llm';
    case 'vlm':
      return 'vlm';
    case 'embeddings':
    case 'embedding':
      return 'embeddings';
    default:
      return;
  }
}

function parseLmStudioLoadState(value: unknown): boolean | undefined {
  // `/api/v1/models` returns `state: "loaded" | "not-loaded"`. Older builds may
  // return booleans or omit the field entirely; leave `loaded` undefined when
  // unknown so the UI does not confuse "not loaded" with "unreported".
  if (typeof value === 'string') {
    return value === 'loaded';
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return;
}

function toLmStudioCandidate(item: Record<string, unknown>): RuntimeModelCandidate | null {
  const id = getOptionalString(item['id']);
  if (!id) {
    return null;
  }
  const label = getOptionalString(item['name']) ?? id;
  const modelType = parseLmStudioModelType(item['type']);
  const loaded = parseLmStudioLoadState(item['state']);

  return {
    id,
    label,
    ...(modelType ? { modelType } : {}),
    ...(typeof loaded === 'boolean' ? { loaded } : {}),
  };
}

function parseLmStudioModelsPayload(payload: unknown): readonly RuntimeModelCandidate[] | null {
  // LM Studio has shipped three shapes over its lifetime:
  //   - `/api/v1/models`  -> `{ data: [...] }` (0.4.0+, preferred)
  //   - `/api/v0/models`  -> `{ data: [...] }` (legacy native, still supported)
  //   - very old builds   -> a bare `[...]` array
  // Normalize all three into a single candidate list.
  if (Array.isArray(payload)) {
    const models: RuntimeModelCandidate[] = [];
    for (const item of payload) {
      if (!isRecord(item)) {
        continue;
      }
      const candidate = toLmStudioCandidate(item);
      if (candidate) {
        models.push(candidate);
      }
    }
    return models;
  }

  if (isRecord(payload) && Array.isArray(payload['data'])) {
    const models: RuntimeModelCandidate[] = [];
    for (const item of payload['data']) {
      if (!isRecord(item)) {
        continue;
      }
      const candidate = toLmStudioCandidate(item);
      if (candidate) {
        models.push(candidate);
      }
    }
    return models;
  }

  return null;
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

interface ResolvedCapabilities {
  readonly capabilitySource: LocalRuntimeCapabilitySource;
  readonly dimensionsKnown: LocalRuntimeDimensionsState;
  readonly embeddings: LocalRuntimeEmbeddingCapability;
  readonly llm: boolean;
}

function resolveReportedCapabilities(
  modelType: LocalRuntimeModelType
): ResolvedCapabilities | undefined {
  switch (modelType) {
    case 'embeddings':
      // Dimensions still need a probe to confirm the exact vector size; the
      // runtime tells us the model IS an embedding model but not its shape.
      return {
        llm: false,
        embeddings: 'supported',
        dimensionsKnown: { state: 'needs_verification' },
        capabilitySource: 'provider_reported',
      };
    case 'llm':
    case 'vlm':
      return {
        llm: true,
        embeddings: 'unsupported',
        dimensionsKnown: { state: 'not_applicable' },
        capabilitySource: 'provider_reported',
      };
  }
}

function inferCapabilitiesFromName(modelId: string, displayName: string): ResolvedCapabilities {
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
      capabilitySource: 'inferred',
    };
  }

  if (hasChatHint) {
    return {
      llm: true,
      embeddings: 'unsupported',
      dimensionsKnown: { state: 'not_applicable' },
      capabilitySource: 'inferred',
    };
  }

  // Unknown model families are treated as LLM-capable and embedding-uncertain so
  // custom names still surface and can be verified through runtime probing.
  return {
    llm: true,
    embeddings: 'needs_verification',
    dimensionsKnown: { state: 'needs_verification' },
    capabilitySource: 'inferred',
  };
}

function resolveCandidateCapabilities(candidate: RuntimeModelCandidate): ResolvedCapabilities {
  if (candidate.modelType) {
    const reported = resolveReportedCapabilities(candidate.modelType);
    if (reported) {
      return reported;
    }
  }
  return inferCapabilitiesFromName(candidate.id, candidate.label);
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

const OLLAMA_KNOWN_CAPABILITIES: ReadonlySet<OllamaModelCapability> = new Set([
  'completion',
  'embedding',
  'insert',
  'thinking',
  'tools',
  'vision',
]);

function isKnownOllamaCapability(value: string): value is OllamaModelCapability {
  return OLLAMA_KNOWN_CAPABILITIES.has(value as OllamaModelCapability);
}

function parseOllamaCapabilityList(payload: unknown): readonly OllamaModelCapability[] {
  if (!(isRecord(payload) && Array.isArray(payload['capabilities']))) {
    return [];
  }
  const seen = new Set<OllamaModelCapability>();
  const result: OllamaModelCapability[] = [];
  for (const raw of payload['capabilities']) {
    if (typeof raw !== 'string') {
      continue;
    }
    // Type guard keeps the narrowing adjacent to the membership check so a
    // future refactor can't let an arbitrary lowercased string masquerade as
    // an `OllamaModelCapability` inside the loop body.
    const normalized = raw.toLowerCase();
    if (isKnownOllamaCapability(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

interface OllamaCapabilitiesCacheEntry {
  readonly expiresAt: number;
  readonly result: LocalRuntimeOllamaCapabilitiesResolved;
}

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
        state: 'unavailable',
        modelId,
        endpoint: showEndpoint,
        message: 'modelId is required',
        checkedAt: this.now(),
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
        state: 'unavailable',
        modelId: trimmed,
        endpoint: showEndpoint,
        message: 'Fetch implementation is not available',
        checkedAt: this.now(),
      };
    }

    const authHeaders = buildRuntimeAuthHeaders(options.endpoint);
    const checkedAt = this.now();
    try {
      const result = await fetchJsonWithTimeout(showEndpoint, {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.requestTimeoutMs,
        method: 'POST',
        body: JSON.stringify({ model: trimmed }),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(authHeaders ? { headers: authHeaders } : {}),
      });

      if (!result.response.ok) {
        return {
          state: 'unavailable',
          modelId: trimmed,
          endpoint: showEndpoint,
          status: result.response.status,
          message: `Ollama /api/show responded with ${result.response.status}`,
          checkedAt,
        };
      }

      if (result.parseError) {
        return {
          state: 'unavailable',
          modelId: trimmed,
          endpoint: showEndpoint,
          message: 'Ollama /api/show returned non-JSON payload',
          checkedAt,
        };
      }

      const capabilities = parseOllamaCapabilityList(result.payload);
      const resolved: LocalRuntimeOllamaCapabilitiesResolved = {
        state: 'resolved',
        modelId: trimmed,
        endpoint: showEndpoint,
        checkedAt,
        capabilities,
        llm: capabilities.includes('completion'),
        embedding: capabilities.includes('embedding'),
        tools: capabilities.includes('tools'),
        vision: capabilities.includes('vision'),
        thinking: capabilities.includes('thinking'),
        insert: capabilities.includes('insert'),
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
        result: resolved,
        expiresAt: checkedAt + this.successTtlMs,
      });
      return resolved;
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      return {
        state: 'unavailable',
        modelId: trimmed,
        endpoint: showEndpoint,
        message: `Ollama /api/show request failed: ${extractErrorMessage(error)}`,
        checkedAt,
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

    const candidateEndpoints = buildRuntimeModelEndpoints(runtime, options.endpoint);
    const endpoints = this.resolveEndpointOrder(candidateEndpoints, availability);

    const loaded = await this.fetchAndNormalizeModels(runtime, availability, endpoints, {
      ...(options.signal ? { signal: options.signal } : {}),
      verifyEmbeddingDimensions: options.verifyEmbeddingDimensions ?? false,
      maxVerificationModels: sanitizeVerificationLimit(options.maxVerificationModels),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
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
        baseUrl: effectiveBaseUrl,
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
        state: 'failed',
        checkedAt: this.now(),
        message: 'Fetch implementation is not available',
      };
    }

    const probeEndpoints = buildRuntimeEmbeddingProbeEndpoints(runtime, options.endpoint);
    const probePayload = JSON.stringify({
      model: modelId,
      input: options.probeText ?? DEFAULT_DIMENSION_PROBE_TEXT,
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
      state: 'failed',
      checkedAt: this.now(),
      message: `No embedding probe endpoint configured for ${runtime}`,
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
          state: 'failed',
          checkedAt: this.now(),
          message: 'Fetch implementation is not available',
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
        method: 'POST',
        body: payload,
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
            state: 'failed',
            checkedAt,
            message: `Embedding probe failed (${result.response.status}) at ${probeUrl}`,
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
            state: 'verified',
            checkedAt,
            endpoint: probeUrl,
            dimensions,
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
      state: 'failed',
      runtime,
      checkedAt,
      availability,
      message: failureMessage,
    };

    const effectiveBaseUrl =
      baseUrl ?? cached?.baseUrl ?? resolveRuntimeBaseUrl(runtime, undefined);
    this.cache.set(runtime, {
      baseUrl: effectiveBaseUrl,
      status: nextStatus,
      nextRefreshAt: this.now() + backoffMs,
      consecutiveFailures: nextFailures,
      lastSuccess: cached?.lastSuccess ?? null,
    });

    // Surface the first catalog failure so "empty model dropdown while runtime
    // is reachable" is diagnosable without DevTools. Demote stale-cache and
    // repeated failures because unavailable local runtimes are normal when the
    // user does not run Ollama or LM Studio.
    const catalogFailurePayload = {
      runtime,
      state: nextStatus.state,
      message: failureMessage,
      availability: availability.state,
      consecutiveFailures: nextFailures,
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
    endpoints: readonly RuntimeModelEndpointDefinition[],
    availability: LocalRuntimeAvailabilityState
  ): readonly RuntimeModelEndpointDefinition[] {
    if (!('endpoint' in availability && availability.endpoint)) {
      return endpoints;
    }

    const preferred = endpoints.find((endpoint) => endpoint.endpoint === availability.endpoint);

    if (!preferred) {
      return endpoints;
    }

    return [preferred, ...endpoints.filter((endpoint) => endpoint !== preferred)];
  }

  private async fetchAndNormalizeModels(
    runtime: LocalRuntimeId,
    availability: LocalRuntimeAvailabilityState,
    endpoints: readonly RuntimeModelEndpointDefinition[],
    options: {
      readonly endpoint?: LocalRuntimeEndpointConfig;
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
      readonly endpoint?: LocalRuntimeEndpointConfig;
      readonly maxVerificationModels: number;
      readonly signal?: AbortSignal;
      readonly verifyEmbeddingDimensions: boolean;
    }
  ): Promise<ModelEndpointAttemptOutcome> {
    if (!this.fetchImpl) {
      return {
        ok: false,
        message: 'Fetch implementation is not available',
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
          ...(options.endpoint ? { endpoint: options.endpoint } : {}),
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
        runtime,
        providerId: runtime,
        modelId: candidate.id,
        modelKey: `${runtime}::${candidate.id}`,
        displayName: candidate.label,
        endpoint: endpoint.endpoint,
        source: endpoint.source,
        freshness: 'live' as const,
        capabilities: {
          llm: resolved.llm,
          embeddings: resolved.embeddings,
        },
        capabilitySource: resolved.capabilitySource,
        dimensionsKnown: resolved.dimensionsKnown,
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
