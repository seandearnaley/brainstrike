import type { ModelVisionSupport } from '@brainstrike/assistant-contract/provider-registry';
import {
  type LocalRuntimeAvailabilityState,
  type LocalRuntimeId,
  resolveRuntimeBaseUrl,
} from './local-runtime-discovery.js';
import type {
  LocalRuntimeCapabilitySource,
  LocalRuntimeDimensionsState,
  LocalRuntimeEmbeddingCapability,
  LocalRuntimeEmbeddingDimensionFailed,
  LocalRuntimeEmbeddingDimensionVerified,
  LocalRuntimeModelCatalogState,
  LocalRuntimeModelFreshness,
  LocalRuntimeModelSource,
  LocalRuntimeModelType,
  LocalRuntimeNormalizedModel,
  LocalRuntimeOllamaCapabilitiesResolved,
  OllamaModelCapability,
} from './local-runtime-model-catalog-types.js';
import {
  buildRuntimeEndpoint,
  isRecord,
  type LocalRuntimeEndpointConfig,
} from './local-runtime-utils.js';

export const defaultCollator = new Intl.Collator(undefined);

export interface RuntimeModelCandidate {
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

export interface RuntimeModelEndpointDefinition {
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

export interface RuntimeModelCacheEntry {
  readonly baseUrl: string;
  readonly consecutiveFailures: number;
  readonly lastSuccess: RuntimeModelSuccessSnapshot | null;
  readonly nextRefreshAt: number;
  readonly status: LocalRuntimeModelCatalogState;
}

export type EmbeddingProbeOutcome =
  | { readonly kind: 'verified'; readonly result: LocalRuntimeEmbeddingDimensionVerified }
  | { readonly kind: 'unsupported'; readonly message: string }
  | { readonly kind: 'failed'; readonly result: LocalRuntimeEmbeddingDimensionFailed };

export type ModelEndpointAttemptOutcome =
  | {
      readonly ok: true;
      readonly models: readonly LocalRuntimeNormalizedModel[];
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly terminal?: boolean;
    };

export const DEFAULT_SUCCESS_TTL_MS = 30_000;
export const DEFAULT_FAILURE_BASE_BACKOFF_MS = 2000;
export const DEFAULT_FAILURE_MAX_BACKOFF_MS = 30_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 2500;
// Keep verification capped because unknown model-family fallbacks can produce
// false positives that would otherwise fan out into many localhost probes.
const DEFAULT_MAX_VERIFICATION_MODELS = 4;
export const DEFAULT_DIMENSION_PROBE_TEXT = 'brainstrike dimension probe';
// Realistic workloads touch tens of models; 200 leaves ample headroom for
// users cycling between local/remote runtimes and renaming models without
// letting the Map grow unbounded across a long session.
export const OLLAMA_CAPABILITIES_CACHE_MAX_ENTRIES = 200;

const EMBEDDING_NAME_PATTERN =
  /(embed|embedding|text-embedding|nomic-embed|jina-embeddings|bge|e5|gte|arctic-embed|voyage)/i;
const CHAT_NAME_PATTERN =
  /(chat|instruct|llama|qwen|mistral|gemma|phi|deepseek|gpt|claude|sonnet|haiku|opus|command-r|mixtral)/i;

// `/api/tags` is listed first for Ollama because it includes `details.families`,
// which lets us infer embedding capability without a follow-up request. The
// OpenAI-compatible `/v1/models` endpoint returns only `{id}` and is kept as a
// compatibility fallback for older Ollama builds or non-default configurations.
const OLLAMA_MODEL_PATHS: readonly RuntimeModelPathDefinition[] = [
  { parser: parseOllamaTagsPayload, path: '/api/tags', source: 'ollama_api_tags' },
  { parser: parseOpenAiModelsPayload, path: '/v1/models', source: 'openai_v1_models' },
];

// Native `/api/v1/models` (LM Studio 0.4.0+) and `/api/v0/models` (legacy but
// still shipped) include `type`, `state`, `arch`, and `quantization` fields that
// the OpenAI-compatible `/v1/models` endpoint strips. Prefer them so the catalog
// surfaces authoritative LLM/embedding/vision classifications; fall back to the
// OpenAI shape for forward-compat if the native paths are ever disabled.
const LM_STUDIO_MODEL_PATHS: readonly RuntimeModelPathDefinition[] = [
  { parser: parseLmStudioModelsPayload, path: '/api/v1/models', source: 'lmstudio_api_v1_models' },
  { parser: parseLmStudioModelsPayload, path: '/api/v0/models', source: 'lmstudio_api_v0_models' },
  { parser: parseOpenAiModelsPayload, path: '/v1/models', source: 'openai_v1_models' },
];

const RUNTIME_ADAPTERS: Record<LocalRuntimeId, RuntimeModelAdapter> = {
  lmstudio: {
    embeddingProbePaths: ['/v1/embeddings'],
    modelPaths: LM_STUDIO_MODEL_PATHS,
    runtime: 'lmstudio',
  },
  ollama: {
    embeddingProbePaths: ['/v1/embeddings', '/api/embeddings'],
    modelPaths: OLLAMA_MODEL_PATHS,
    runtime: 'ollama',
  },
};

export function buildRuntimeModelEndpoints(
  runtime: LocalRuntimeId,
  endpoint: LocalRuntimeEndpointConfig | undefined
): readonly RuntimeModelEndpointDefinition[] {
  const baseUrl = resolveRuntimeBaseUrl(runtime, endpoint?.baseUrl);
  return RUNTIME_ADAPTERS[runtime].modelPaths.map((definition) => ({
    endpoint: buildRuntimeEndpoint(baseUrl, definition.path),
    parser: definition.parser,
    source: definition.source,
  }));
}

export function buildRuntimeEmbeddingProbeEndpoints(
  runtime: LocalRuntimeId,
  endpoint: LocalRuntimeEndpointConfig | undefined
): readonly string[] {
  const baseUrl = resolveRuntimeBaseUrl(runtime, endpoint?.baseUrl);
  return RUNTIME_ADAPTERS[runtime].embeddingProbePaths.map((path) =>
    buildRuntimeEndpoint(baseUrl, path)
  );
}

export const OLLAMA_SHOW_PATH = '/api/show';

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

export function sanitizeVerificationLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_VERIFICATION_MODELS;
  }
  return Math.floor(value);
}

export function isReachableRuntimeState(state: LocalRuntimeAvailabilityState['state']): boolean {
  return state === 'available' || state === 'stale';
}

export function buildRuntimeAvailabilityMessage(
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
  readonly vision: ModelVisionSupport;
}

function resolveReportedCapabilities(
  modelType: LocalRuntimeModelType
): ResolvedCapabilities | undefined {
  switch (modelType) {
    case 'embeddings':
      // Dimensions still need a probe to confirm the exact vector size; the
      // runtime tells us the model IS an embedding model but not its shape.
      return {
        capabilitySource: 'provider_reported',
        dimensionsKnown: { state: 'needs_verification' },
        embeddings: 'supported',
        llm: false,
        vision: 'unsupported',
      };
    // LM Studio's native type discriminant separates text-only 'llm' from
    // vision-language 'vlm' models, so both classifications are authoritative.
    case 'llm':
    case 'vlm':
      return {
        capabilitySource: 'provider_reported',
        dimensionsKnown: { state: 'not_applicable' },
        embeddings: 'unsupported',
        llm: true,
        vision: modelType === 'vlm' ? 'supported' : 'unsupported',
      };
  }
}

function inferCapabilitiesFromName(modelId: string, displayName: string): ResolvedCapabilities {
  const searchable = `${modelId} ${displayName}`.toLowerCase();
  const hasEmbeddingHint = EMBEDDING_NAME_PATTERN.test(searchable);
  const hasChatHint = CHAT_NAME_PATTERN.test(searchable);

  // Name inference carries no vision signal, so every inferred branch keeps
  // vision 'unknown' — never a silent unsupported.
  if (hasEmbeddingHint) {
    // Prefer embedding classification when both patterns match so "embedding"-labeled
    // models remain actionable for this catalog even if names also contain chat terms.
    return {
      capabilitySource: 'inferred',
      dimensionsKnown: { state: 'needs_verification' },
      embeddings: 'supported',
      llm: hasChatHint,
      vision: 'unknown',
    };
  }

  if (hasChatHint) {
    return {
      capabilitySource: 'inferred',
      dimensionsKnown: { state: 'not_applicable' },
      embeddings: 'unsupported',
      llm: true,
      vision: 'unknown',
    };
  }

  // Unknown model families are treated as LLM-capable and embedding-uncertain so
  // custom names still surface and can be verified through runtime probing.
  return {
    capabilitySource: 'inferred',
    dimensionsKnown: { state: 'needs_verification' },
    embeddings: 'needs_verification',
    llm: true,
    vision: 'unknown',
  };
}

export function resolveCandidateCapabilities(
  candidate: RuntimeModelCandidate
): ResolvedCapabilities {
  if (candidate.modelType) {
    const reported = resolveReportedCapabilities(candidate.modelType);
    if (reported) {
      return reported;
    }
  }
  return inferCapabilitiesFromName(candidate.id, candidate.label);
}

export function extractEmbeddingDimensions(payload: unknown): number | null {
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

export function setModelFreshness(
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

export function parseOllamaCapabilityList(payload: unknown): readonly OllamaModelCapability[] {
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

export interface OllamaCapabilitiesCacheEntry {
  readonly expiresAt: number;
  readonly result: LocalRuntimeOllamaCapabilitiesResolved;
}
