import {
  buildRuntimeAuthHeaders,
  buildRuntimeEndpoint,
  extractErrorMessage,
  type FetchJsonResult,
  fetchJsonWithTimeout,
  isRecord,
  type LocalRuntimeEndpointConfig,
  type LocalRuntimeLogger,
  noopLocalRuntimeLogger,
  normalizeRuntimeBaseUrl,
  sanitizeDuration,
} from './local-runtime-utils.js';

export type { LocalRuntimeLogger } from './local-runtime-utils.js';

export const LOCAL_RUNTIME_IDS = ['ollama', 'lmstudio'] as const;

export type LocalRuntimeId = (typeof LOCAL_RUNTIME_IDS)[number];

export type LocalRuntimeSurface = 'desktop' | 'web';

export interface LocalRuntimeCheckingState {
  state: 'checking';
}

interface BaseLocalRuntimeState {
  readonly checkedAt: number;
}

export interface LocalRuntimeAvailableState extends BaseLocalRuntimeState {
  readonly endpoint: string;
  readonly latencyMs: number;
  readonly state: 'available';
}

export interface LocalRuntimeUnavailableState extends BaseLocalRuntimeState {
  /**
   * Human-readable diagnostic hint when we can guess the failure category
   * (e.g. CORS rejection when a Chromium renderer fetch throws
   * `TypeError: Failed to fetch`). Surfaces in the Settings → Local Runtimes
   * card so users can tell "Ollama not running" from "Ollama running but
   * refusing this origin".
   */
  readonly hint?: string;
  readonly message?: string;
  readonly state: 'unavailable';
}

export interface LocalRuntimeBlockedWebState extends BaseLocalRuntimeState {
  readonly message: string;
  readonly state: 'blocked_web';
}

export interface LocalRuntimeAuthRequiredState extends BaseLocalRuntimeState {
  readonly endpoint: string;
  readonly state: 'auth_required';
  readonly status: 401 | 403;
}

export interface LocalRuntimeIncompatibleState extends BaseLocalRuntimeState {
  readonly endpoint: string;
  readonly message: string;
  readonly state: 'incompatible';
}

export interface LocalRuntimeStaleState extends BaseLocalRuntimeState {
  readonly endpoint: string;
  readonly lastSuccessfulAt: number;
  readonly message?: string;
  readonly reason: 'unavailable' | 'blocked_web' | 'auth_required' | 'incompatible';
  readonly state: 'stale';
}

export type LocalRuntimeAvailabilityState =
  | LocalRuntimeCheckingState
  | LocalRuntimeAvailableState
  | LocalRuntimeUnavailableState
  | LocalRuntimeBlockedWebState
  | LocalRuntimeAuthRequiredState
  | LocalRuntimeIncompatibleState
  | LocalRuntimeStaleState;

type LocalRuntimeFailureState =
  | LocalRuntimeUnavailableState
  | LocalRuntimeBlockedWebState
  | LocalRuntimeAuthRequiredState
  | LocalRuntimeIncompatibleState;

type ProbeValidator = (payload: unknown) => boolean;

interface RuntimeProbePath {
  readonly path: string;
  readonly validator: ProbeValidator;
}

interface RuntimeProbeDefinition {
  readonly endpoint: string;
  readonly validator: ProbeValidator;
}

const DEFAULT_RUNTIME_BASE_URLS: Record<LocalRuntimeId, string> = {
  lmstudio: 'http://127.0.0.1:1234',
  ollama: 'http://127.0.0.1:11434',
};

interface RuntimeCacheEntry {
  readonly baseUrl: string;
  readonly consecutiveFailures: number;
  readonly lastSuccessfulAt: number | null;
  readonly lastSuccessfulEndpoint: string | null;
  readonly nextProbeAt: number;
  readonly status: Exclude<LocalRuntimeAvailabilityState, LocalRuntimeCheckingState>;
}

const DEFAULT_SUCCESS_TTL_MS = 30_000;
const DEFAULT_FAILURE_BASE_BACKOFF_MS = 2000;
const DEFAULT_FAILURE_MAX_BACKOFF_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2000;

// Ollama defaults to 127.0.0.1 on its standard local port; LM Studio binds to
// IPv4 loopback by default and `localhost` can resolve to `::1`, so we always
// probe `127.0.0.1` explicitly.
const OLLAMA_PROBE_PATHS: readonly RuntimeProbePath[] = [
  { path: '/v1/models', validator: isOpenAiModelsPayload },
  { path: '/api/version', validator: isOllamaVersionPayload },
  { path: '/api/tags', validator: isOllamaTagsPayload },
];

const LM_STUDIO_PROBE_PATHS: readonly RuntimeProbePath[] = [
  { path: '/v1/models', validator: isOpenAiModelsPayload },
  { path: '/api/v1/models', validator: isLmStudioRestModelsPayload },
  { path: '/api/v0/models', validator: isLmStudioRestModelsPayload },
];

const DEFAULT_PROBE_PATHS: Record<LocalRuntimeId, readonly RuntimeProbePath[]> = {
  lmstudio: LM_STUDIO_PROBE_PATHS,
  ollama: OLLAMA_PROBE_PATHS,
};

export function resolveRuntimeBaseUrl(
  runtime: LocalRuntimeId,
  override: string | undefined | null
): string {
  return normalizeRuntimeBaseUrl(override) ?? DEFAULT_RUNTIME_BASE_URLS[runtime];
}

function buildProbeDefinitions(
  runtime: LocalRuntimeId,
  endpoint: LocalRuntimeEndpointConfig | undefined
): readonly RuntimeProbeDefinition[] {
  const baseUrl = resolveRuntimeBaseUrl(runtime, endpoint?.baseUrl);
  return DEFAULT_PROBE_PATHS[runtime].map((probe) => ({
    endpoint: buildRuntimeEndpoint(baseUrl, probe.path),
    validator: probe.validator,
  }));
}

export interface LocalRuntimeDiscoveryServiceOptions {
  /** Host capability: report unavailable before a browser issues a forbidden request. */
  readonly browserUnavailableReason?: string;
  /**
   * Optional explicit runtime surface.
   */
  readonly defaultSurface?: LocalRuntimeSurface;
  /**
   * Exponential backoff base for failed probe retries.
   */
  readonly failureBaseBackoffMs?: number;
  /**
   * Maximum exponential backoff delay for failed probes.
   */
  readonly failureMaxBackoffMs?: number;
  /**
   * Fetch implementation for runtime probing.
   * Defaults to global fetch.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Optional structured logger. When supplied, probe failures emit
   * warn-level records with runtime id, endpoint, and error detail so the
   * Settings → Local Runtimes "Unavailable" state is diagnosable.
   */
  readonly logger?: LocalRuntimeLogger;
  /**
   * Optional time source override for deterministic tests.
   */
  readonly now?: () => number;
  /**
   * Timeout for individual probe requests.
   */
  readonly requestTimeoutMs?: number;
  /**
   * Time-to-live for successful probe results before re-check.
   */
  readonly successTtlMs?: number;
}

export interface ProbeLocalRuntimeOptions {
  readonly diagnosticLogLevel?: RuntimeDiagnosticLogLevel;
  /**
   * Per-call override for the runtime's endpoint config. When provided, the
   * probe list is rebuilt from the supplied `baseUrl` and the request carries
   * the optional `apiToken` as a bearer header. `baseUrl` and `apiToken` are
   * independent — setting one without the other is supported.
   */
  readonly endpoint?: LocalRuntimeEndpointConfig;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
  readonly surface?: LocalRuntimeSurface;
}

export type RuntimeDiagnosticLogLevel = 'debug' | 'warn';

interface ProbeAllOptions extends Omit<ProbeLocalRuntimeOptions, 'signal'> {
  readonly signal?: AbortSignal;
}

interface ProbeAttemptFailure {
  readonly state: LocalRuntimeFailureState;
}

const FAILURE_PRIORITY: readonly LocalRuntimeFailureState['state'][] = [
  'auth_required',
  'blocked_web',
  'incompatible',
  'unavailable',
];

function hasStringId(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value['id'] === 'string' && value['id'].length > 0;
}

function isOpenAiModelsPayload(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  const data = payload['data'];
  if (!Array.isArray(data) || data.length === 0) {
    return false;
  }
  return data.every((item) => hasStringId(item));
}

function isOllamaVersionPayload(payload: unknown): boolean {
  return (
    isRecord(payload) && typeof payload['version'] === 'string' && payload['version'].length > 0
  );
}

function isOllamaTagsPayload(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  const models = payload['models'];
  return Array.isArray(models);
}

function isLmStudioRestModelsPayload(payload: unknown): boolean {
  if (Array.isArray(payload)) {
    return payload.every((item) => hasStringId(item));
  }
  return isOpenAiModelsPayload(payload);
}

function resolveRuntimeSurface(defaultSurface?: LocalRuntimeSurface): LocalRuntimeSurface {
  if (defaultSurface) {
    return defaultSurface;
  }

  if (typeof window === 'undefined') {
    return 'desktop';
  }

  const maybeRendererWindow = window as Window & {
    process?: { type?: string };
    electronAPI?: unknown;
  };
  if (maybeRendererWindow.process?.type === 'renderer' || maybeRendererWindow.electronAPI) {
    return 'desktop';
  }

  return 'web';
}

function isLikelyWebPolicyBlock(
  surface: LocalRuntimeSurface,
  endpoint: string,
  errorMessage: string
): boolean {
  if (surface !== 'web') {
    return false;
  }

  if (typeof window !== 'undefined') {
    const protocol = window.location?.protocol;
    if (protocol === 'https:' && endpoint.startsWith('http://')) {
      return true;
    }
  }

  const message = errorMessage.toLowerCase();
  return (
    message.includes('cors') ||
    message.includes('private network') ||
    message.includes('mixed content') ||
    message.includes('blocked by') ||
    message.includes('networkerror when attempting to fetch resource')
  );
}

/**
 * Patterns that match a Chromium CORS rejection or a Node `fetch` that hit
 * the CORS preflight path. When the probe runs in an Electron renderer, the
 * OS-side Ollama server may not list the renderer's origin (`file://`,
 * `app://`, or a dev Vite URL) in `OLLAMA_ORIGINS`, so the renderer's
 * Chromium blocks the response and we see a generic `TypeError: Failed to
 * fetch` with no additional detail. We surface a hint so users can add
 * `OLLAMA_ORIGINS=*` or rely on the main-process probe bridge.
 */
const CORS_LIKE_ERROR_PATTERNS: readonly RegExp[] = [
  /failed to fetch/i,
  /cors/i,
  /cross-origin/i,
  /networkerror when attempting to fetch resource/i,
];

function looksLikeCorsFailure(message: string): boolean {
  return CORS_LIKE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/** Human-friendly product names for the desktop CORS hint. */
const RUNTIME_DISPLAY_NAMES: Readonly<Record<LocalRuntimeId, string>> = {
  lmstudio: 'LM Studio',
  ollama: 'Ollama',
};

function buildDesktopCorsHint(runtime: LocalRuntimeId): string {
  const displayName = RUNTIME_DISPLAY_NAMES[runtime];
  // The hint must cover BOTH the common case (server not running) and the
  // subtle Electron-specific case (renderer origin not in OLLAMA_ORIGINS),
  // because Chromium gives the same opaque `TypeError: Failed to fetch` in
  // both. Pointing only at CORS would send "server isn't running"
  // complaints down the wrong debugging path. Per-runtime guidance avoids
  // the previous wording that mentioned both products in a single hint
  // even when only one was being probed.
  if (runtime === 'ollama') {
    return `Network error reaching ${displayName}. Most often this means the ${displayName} server is not running — start it and try again. If the server is running but the probe still fails from the desktop app, set \`OLLAMA_ORIGINS=*\` so the app's origin is accepted.`;
  }
  return `Network error reaching ${displayName}. Most often this means the ${displayName} server is not running — start it from Settings > Server and try again. If the server is running but the probe still fails from the desktop app, widen the origin allow-list in ${displayName}'s server settings so the app's origin is accepted.`;
}

function toFailureState(
  runtime: LocalRuntimeId,
  checkedAt: number,
  endpoint: string,
  error: unknown,
  surface: LocalRuntimeSurface
): LocalRuntimeFailureState {
  const message = extractErrorMessage(error);
  if (isLikelyWebPolicyBlock(surface, endpoint, message)) {
    return {
      checkedAt,
      message,
      state: 'blocked_web',
    };
  }
  if (surface === 'desktop' && looksLikeCorsFailure(message)) {
    return {
      checkedAt,
      hint: buildDesktopCorsHint(runtime),
      message,
      state: 'unavailable',
    };
  }
  return {
    checkedAt,
    message,
    state: 'unavailable',
  };
}

function toFailureReason(
  state: LocalRuntimeFailureState['state']
): LocalRuntimeStaleState['reason'] {
  return state;
}

function getFailureMessage(failure: LocalRuntimeFailureState): string | undefined {
  switch (failure.state) {
    case 'unavailable':
    case 'blocked_web':
    case 'incompatible':
      return failure.message;
    case 'auth_required':
      return;
  }
}

function evaluateProbeResponse(
  checkedAt: number,
  probe: RuntimeProbeDefinition,
  responseResult: FetchJsonResult
): LocalRuntimeAvailableState | LocalRuntimeFailureState {
  if (responseResult.response.status === 401 || responseResult.response.status === 403) {
    return {
      checkedAt,
      endpoint: probe.endpoint,
      state: 'auth_required',
      status: responseResult.response.status,
    };
  }

  if (!responseResult.response.ok) {
    return {
      checkedAt,
      message: `Probe failed (${responseResult.response.status}) at ${probe.endpoint}`,
      state: 'unavailable',
    };
  }

  if (responseResult.parseError) {
    return {
      checkedAt,
      endpoint: probe.endpoint,
      message: `Invalid JSON response at ${probe.endpoint}`,
      state: 'incompatible',
    };
  }

  if (probe.validator(responseResult.payload)) {
    return {
      checkedAt,
      endpoint: probe.endpoint,
      latencyMs: responseResult.latencyMs,
      state: 'available',
    };
  }

  return {
    checkedAt,
    endpoint: probe.endpoint,
    message: `Unexpected response shape at ${probe.endpoint}`,
    state: 'incompatible',
  };
}

function pickBestFailure(
  failures: readonly ProbeAttemptFailure[]
): LocalRuntimeFailureState | undefined {
  for (const state of FAILURE_PRIORITY) {
    const match = failures.find((entry) => entry.state.state === state);
    if (match) {
      return match.state;
    }
  }
  return;
}

export class LocalRuntimeDiscoveryService {
  private readonly browserUnavailableReason: string | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly successTtlMs: number;
  private readonly failureBaseBackoffMs: number;
  private readonly failureMaxBackoffMs: number;
  private readonly requestTimeoutMs: number;
  private readonly defaultSurface: LocalRuntimeSurface | undefined;
  private readonly now: () => number;
  private readonly logger: LocalRuntimeLogger;
  private readonly cache = new Map<LocalRuntimeId, RuntimeCacheEntry>();
  private readonly inFlightProbes = new Map<string, Promise<LocalRuntimeAvailabilityState>>();

  public constructor(options: LocalRuntimeDiscoveryServiceOptions = {}) {
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
    this.defaultSurface = options.defaultSurface;
    this.browserUnavailableReason = options.browserUnavailableReason;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? noopLocalRuntimeLogger;
  }

  public static checkingState(): LocalRuntimeCheckingState {
    return { state: 'checking' };
  }

  public getCachedState(runtime: LocalRuntimeId): LocalRuntimeAvailabilityState | null {
    return this.cache.get(runtime)?.status ?? null;
  }

  public clearCache(runtime?: LocalRuntimeId): void {
    if (runtime) {
      this.cache.delete(runtime);
      for (const key of this.inFlightProbes.keys()) {
        if (key.startsWith(`${runtime}\u0000`)) {
          this.inFlightProbes.delete(key);
        }
      }
      return;
    }
    this.cache.clear();
    this.inFlightProbes.clear();
  }

  public async probeAll(
    options: ProbeAllOptions = {}
  ): Promise<Record<LocalRuntimeId, LocalRuntimeAvailabilityState>> {
    const [ollama, lmstudio] = await Promise.all([
      this.probeRuntime('ollama', options),
      this.probeRuntime('lmstudio', options),
    ]);

    return {
      lmstudio,
      ollama,
    };
  }

  public async probeRuntime(
    runtime: LocalRuntimeId,
    options: ProbeLocalRuntimeOptions = {}
  ): Promise<LocalRuntimeAvailabilityState> {
    const now = this.now();
    const cached = this.cache.get(runtime);
    const baseUrl = resolveRuntimeBaseUrl(runtime, options.endpoint?.baseUrl);
    const surface = options.surface ?? resolveRuntimeSurface(this.defaultSurface);
    if (surface === 'web' && this.browserUnavailableReason) {
      return { checkedAt: now, message: this.browserUnavailableReason, state: 'blocked_web' };
    }

    // Invalidate the cache when the effective baseUrl changes so a user who
    // points at a different host sees a fresh probe, not the last answer.
    if (
      !(options.force ?? false) &&
      cached &&
      cached.baseUrl === baseUrl &&
      now < cached.nextProbeAt
    ) {
      return cached.status;
    }

    const inFlightKey = this.getInFlightProbeKey(runtime, baseUrl, surface, options);
    if (inFlightKey) {
      const inFlight = this.inFlightProbes.get(inFlightKey);
      if (inFlight) {
        return inFlight;
      }
    }

    const probePromise = this.probeRuntimeUnshared(runtime, options, {
      baseUrl,
      cached,
      now,
      surface,
    });

    if (!inFlightKey) {
      return probePromise;
    }

    this.inFlightProbes.set(inFlightKey, probePromise);
    try {
      return await probePromise;
    } finally {
      if (this.inFlightProbes.get(inFlightKey) === probePromise) {
        this.inFlightProbes.delete(inFlightKey);
      }
    }
  }

  private getInFlightProbeKey(
    runtime: LocalRuntimeId,
    baseUrl: string,
    surface: LocalRuntimeSurface,
    options: ProbeLocalRuntimeOptions
  ): string | null {
    if (options.signal || options.endpoint?.apiToken) {
      return null;
    }
    return [runtime, baseUrl, surface, options.diagnosticLogLevel ?? 'warn'].join('\u0000');
  }

  private async probeRuntimeUnshared(
    runtime: LocalRuntimeId,
    options: ProbeLocalRuntimeOptions,
    context: {
      readonly baseUrl: string;
      readonly cached: RuntimeCacheEntry | undefined;
      readonly now: number;
      readonly surface: LocalRuntimeSurface;
    }
  ): Promise<LocalRuntimeAvailabilityState> {
    const { baseUrl, cached, now, surface } = context;
    const result = await this.executeProbe(runtime, {
      surface,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    });

    const previousSuccessAt =
      cached && cached.baseUrl === baseUrl ? (cached.lastSuccessfulAt ?? null) : null;
    const previousSuccessEndpoint =
      cached && cached.baseUrl === baseUrl ? (cached.lastSuccessfulEndpoint ?? null) : null;
    const consecutiveFailures =
      cached && cached.baseUrl === baseUrl ? cached.consecutiveFailures : 0;

    if (result.state === 'available') {
      this.cache.set(runtime, {
        baseUrl,
        consecutiveFailures: 0,
        lastSuccessfulAt: result.checkedAt,
        lastSuccessfulEndpoint: result.endpoint,
        nextProbeAt: now + this.successTtlMs,
        status: result,
      });
      this.logger.debug('local runtime probe succeeded', {
        endpoint: result.endpoint,
        latencyMs: result.latencyMs,
        runtime,
      });
      return result;
    }

    const stale = this.toStaleState(result, previousSuccessAt, previousSuccessEndpoint);
    const nextStatus = stale ?? result;
    const nextFailures = consecutiveFailures + 1;

    // Surface the first non-available result so Settings → Local Runtimes
    // "Unavailable" is never silent. Demote repeated failures to debug while
    // the backoff cache remains authoritative; unavailable local runtimes are
    // normal when users do not run Ollama or LM Studio.
    const probeFailurePayload = {
      consecutiveFailures: nextFailures,
      endpoint:
        'endpoint' in result
          ? result.endpoint
          : buildRuntimeEndpoint(baseUrl, DEFAULT_PROBE_PATHS[runtime][0]?.path ?? '/'),
      hint: 'hint' in result ? result.hint : undefined,
      message: 'message' in result ? result.message : undefined,
      runtime,
      state: result.state,
    };
    if (nextFailures === 1 && options.diagnosticLogLevel !== 'debug') {
      this.logger.warn('local runtime probe did not reach available state', probeFailurePayload);
    } else {
      this.logger.debug('local runtime probe did not reach available state', probeFailurePayload);
    }
    const backoffMs = Math.min(
      this.failureMaxBackoffMs,
      this.failureBaseBackoffMs * 2 ** Math.max(0, nextFailures - 1)
    );

    this.cache.set(runtime, {
      baseUrl,
      consecutiveFailures: nextFailures,
      lastSuccessfulAt: previousSuccessAt,
      lastSuccessfulEndpoint: previousSuccessEndpoint,
      nextProbeAt: now + backoffMs,
      status: nextStatus,
    });

    return nextStatus;
  }

  private toStaleState(
    failure: LocalRuntimeFailureState,
    lastSuccessfulAt: number | null,
    lastSuccessfulEndpoint: string | null
  ): LocalRuntimeStaleState | null {
    if (!(lastSuccessfulAt && lastSuccessfulEndpoint)) {
      return null;
    }

    const message = getFailureMessage(failure);

    return {
      checkedAt: failure.checkedAt,
      endpoint: lastSuccessfulEndpoint,
      lastSuccessfulAt,
      reason: toFailureReason(failure.state),
      state: 'stale',
      ...(message ? { message } : {}),
    };
  }

  private async executeProbe(
    runtime: LocalRuntimeId,
    options: {
      readonly endpoint?: LocalRuntimeEndpointConfig;
      readonly signal?: AbortSignal;
      readonly surface: LocalRuntimeSurface;
    }
  ): Promise<LocalRuntimeAvailableState | LocalRuntimeFailureState> {
    if (!this.fetchImpl) {
      return {
        checkedAt: this.now(),
        message: 'Fetch implementation is not available',
        state: 'unavailable',
      };
    }

    const probes = buildProbeDefinitions(runtime, options.endpoint);
    const authHeaders = buildRuntimeAuthHeaders(options.endpoint);
    const failures: ProbeAttemptFailure[] = [];

    for (const probe of probes) {
      const checkedAt = this.now();
      try {
        const responseResult = await fetchJsonWithTimeout(probe.endpoint, {
          fetchImpl: this.fetchImpl,
          timeoutMs: this.requestTimeoutMs,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(authHeaders ? { headers: authHeaders } : {}),
        });
        const result = evaluateProbeResponse(checkedAt, probe, responseResult);
        if (result.state === 'available' || result.state === 'auth_required') {
          return result;
        }
        failures.push({ state: result });
      } catch (error) {
        if (options.signal?.aborted) {
          throw error;
        }
        const failure = toFailureState(runtime, checkedAt, probe.endpoint, error, options.surface);
        failures.push({ state: failure });
        if (failure.state === 'blocked_web') {
          break;
        }
      }
    }

    const bestFailure = pickBestFailure(failures);
    if (bestFailure) {
      return bestFailure;
    }

    return {
      checkedAt: this.now(),
      message: `No probe endpoints configured for ${runtime}`,
      state: 'unavailable',
    };
  }
}
