import type {
  LocalRuntimeAvailabilityState,
  LocalRuntimeDiscoveryService,
  LocalRuntimeId,
  LocalRuntimeLogger,
  LocalRuntimeSurface,
  RuntimeDiagnosticLogLevel,
} from './local-runtime-discovery.js';
import type { LocalRuntimeEndpointConfig } from './local-runtime-utils.js';

export type LocalRuntimeModelSource =
  | 'openai_v1_models'
  | 'ollama_api_tags'
  | 'lmstudio_api_v0_models'
  | 'lmstudio_api_v1_models';

export type LocalRuntimeModelFreshness = 'live' | 'stale_cached';

export type LocalRuntimeEmbeddingCapability = 'supported' | 'unsupported' | 'needs_verification';

/**
 * Canonical LM Studio model type surfaced by `/api/v0/models` and `/api/v1/models`.
 * The OpenAI-compatible `/v1/models` endpoint does not expose this.
 */
export type LocalRuntimeModelType = 'llm' | 'vlm' | 'embeddings';

export type LocalRuntimeCapabilitySource = 'provider_reported' | 'inferred';

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
  /**
   * Whether capabilities were reported by the runtime (LM Studio `type`, Ollama
   * `details.families`) or heuristically inferred from the model name.
   */
  readonly capabilitySource: LocalRuntimeCapabilitySource;
  readonly dimensionsKnown: LocalRuntimeDimensionsState;
  readonly displayName: string;
  readonly endpoint: string;
  readonly freshness: LocalRuntimeModelFreshness;
  /**
   * True when LM Studio reports the model is currently loaded in memory. Absent
   * or undefined for endpoints that do not expose load state (Ollama, OpenAI-compat).
   */
  readonly loaded?: boolean;
  readonly modelId: string;
  readonly modelKey: string;
  /**
   * Canonical LM Studio model type when reported by the runtime. Absent for
   * OpenAI-compat / Ollama shapes that do not expose a type discriminant.
   */
  readonly modelType?: LocalRuntimeModelType;
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
  readonly diagnosticLogLevel?: RuntimeDiagnosticLogLevel;
  /**
   * Per-call override for the runtime's endpoint config (baseUrl, bearer token).
   * Propagated to both the discovery probe and the model-list / embedding-probe
   * requests so all requests hit the same host.
   */
  readonly endpoint?: LocalRuntimeEndpointConfig;
  readonly force?: boolean;
  readonly maxVerificationModels?: number;
  readonly signal?: AbortSignal;
  readonly surface?: LocalRuntimeSurface;
  readonly verifyEmbeddingDimensions?: boolean;
}

export interface ListAllLocalRuntimeModelsOptions
  extends Omit<ListLocalRuntimeModelsOptions, 'signal'> {
  readonly signal?: AbortSignal;
}

export interface LocalRuntimeModelCatalogServiceOptions {
  readonly defaultSurface?: LocalRuntimeSurface;
  readonly discoveryService?: LocalRuntimeDiscoveryService;
  readonly failureBaseBackoffMs?: number;
  readonly failureMaxBackoffMs?: number;
  readonly fetchImpl?: typeof fetch;
  /**
   * Optional structured logger for model-list failures. The catalog warns
   * when no endpoint returns a usable model list, so Settings UI telemetry
   * can surface the reason users see an empty model dropdown even when the
   * runtime is otherwise reachable.
   */
  readonly logger?: LocalRuntimeLogger;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  readonly successTtlMs?: number;
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

/**
 * Canonical capability strings returned by Ollama's `POST /api/show`. Ollama
 * documents these in github.com/ollama/ollama/blob/main/docs/api.md and emits
 * them as a `capabilities: string[]` array on the show response.
 */
export type OllamaModelCapability =
  | 'completion'
  | 'embedding'
  | 'insert'
  | 'thinking'
  | 'tools'
  | 'vision';

export interface LocalRuntimeOllamaCapabilitiesResolved {
  readonly capabilities: readonly OllamaModelCapability[];
  readonly checkedAt: number;
  readonly embedding: boolean;
  readonly endpoint: string;
  readonly insert: boolean;
  readonly llm: boolean;
  readonly modelId: string;
  readonly state: 'resolved';
  readonly thinking: boolean;
  readonly tools: boolean;
  readonly vision: boolean;
}

export interface LocalRuntimeOllamaCapabilitiesUnavailable {
  readonly checkedAt: number;
  readonly endpoint: string;
  readonly message: string;
  readonly modelId: string;
  readonly state: 'unavailable';
  readonly status?: number;
}

export type LocalRuntimeOllamaCapabilitiesResult =
  | LocalRuntimeOllamaCapabilitiesResolved
  | LocalRuntimeOllamaCapabilitiesUnavailable;
