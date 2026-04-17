import {
  extractErrorMessage,
  type FetchJsonResult,
  fetchJsonWithTimeout,
  isRecord,
  sanitizeDuration,
} from './local-runtime-utils';

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

interface RuntimeProbeDefinition {
  readonly endpoint: string;
  readonly validator: ProbeValidator;
}

interface RuntimeCacheEntry {
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

// Ollama defaults to 127.0.0.1 on its standard local port.
const OLLAMA_PROBES: readonly RuntimeProbeDefinition[] = [
  {
    endpoint: 'http://127.0.0.1:11434/v1/models',
    validator: isOpenAiModelsPayload,
  },
  {
    endpoint: 'http://127.0.0.1:11434/api/version',
    validator: isOllamaVersionPayload,
  },
  {
    endpoint: 'http://127.0.0.1:11434/api/tags',
    validator: isOllamaTagsPayload,
  },
];

// LM Studio documents localhost for its OpenAI-compatible server endpoint, but
// binds only to IPv4 loopback by default. Probing `localhost` risks resolving
// to `::1` on systems where IPv6 is preferred, which would miss the server;
// always probe `127.0.0.1` explicitly.
const LM_STUDIO_PROBES: readonly RuntimeProbeDefinition[] = [
  {
    endpoint: 'http://127.0.0.1:1234/v1/models',
    validator: isOpenAiModelsPayload,
  },
  {
    endpoint: 'http://127.0.0.1:1234/api/v1/models',
    validator: isLmStudioRestModelsPayload,
  },
  {
    endpoint: 'http://127.0.0.1:1234/api/v0/models',
    validator: isLmStudioRestModelsPayload,
  },
];

const DEFAULT_PROBES: Record<LocalRuntimeId, readonly RuntimeProbeDefinition[]> = {
  ollama: OLLAMA_PROBES,
  lmstudio: LM_STUDIO_PROBES,
};

export interface LocalRuntimeDiscoveryServiceOptions {
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
  readonly force?: boolean;
  readonly signal?: AbortSignal;
  readonly surface?: LocalRuntimeSurface;
}

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

function toFailureState(
  checkedAt: number,
  endpoint: string,
  error: unknown,
  surface: LocalRuntimeSurface
): LocalRuntimeFailureState {
  const message = extractErrorMessage(error);
  if (isLikelyWebPolicyBlock(surface, endpoint, message)) {
    return {
      state: 'blocked_web',
      checkedAt,
      message,
    };
  }
  return {
    state: 'unavailable',
    checkedAt,
    message,
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
      state: 'auth_required',
      checkedAt,
      endpoint: probe.endpoint,
      status: responseResult.response.status,
    };
  }

  if (!responseResult.response.ok) {
    return {
      state: 'unavailable',
      checkedAt,
      message: `Probe failed (${responseResult.response.status}) at ${probe.endpoint}`,
    };
  }

  if (responseResult.parseError) {
    return {
      state: 'incompatible',
      checkedAt,
      endpoint: probe.endpoint,
      message: `Invalid JSON response at ${probe.endpoint}`,
    };
  }

  if (probe.validator(responseResult.payload)) {
    return {
      state: 'available',
      checkedAt,
      endpoint: probe.endpoint,
      latencyMs: responseResult.latencyMs,
    };
  }

  return {
    state: 'incompatible',
    checkedAt,
    endpoint: probe.endpoint,
    message: `Unexpected response shape at ${probe.endpoint}`,
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
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly successTtlMs: number;
  private readonly failureBaseBackoffMs: number;
  private readonly failureMaxBackoffMs: number;
  private readonly requestTimeoutMs: number;
  private readonly defaultSurface: LocalRuntimeSurface | undefined;
  private readonly now: () => number;
  private readonly cache = new Map<LocalRuntimeId, RuntimeCacheEntry>();

  public constructor(options: LocalRuntimeDiscoveryServiceOptions = {}) {
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
    this.defaultSurface = options.defaultSurface;
    this.now = options.now ?? (() => Date.now());
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
      return;
    }
    this.cache.clear();
  }

  public async probeAll(
    options: ProbeAllOptions = {}
  ): Promise<Record<LocalRuntimeId, LocalRuntimeAvailabilityState>> {
    const [ollama, lmstudio] = await Promise.all([
      this.probeRuntime('ollama', options),
      this.probeRuntime('lmstudio', options),
    ]);

    return {
      ollama,
      lmstudio,
    };
  }

  public async probeRuntime(
    runtime: LocalRuntimeId,
    options: ProbeLocalRuntimeOptions = {}
  ): Promise<LocalRuntimeAvailabilityState> {
    const now = this.now();
    const cached = this.cache.get(runtime);

    if (!(options.force ?? false) && cached && now < cached.nextProbeAt) {
      return cached.status;
    }

    const result = await this.executeProbe(runtime, {
      surface: options.surface ?? resolveRuntimeSurface(this.defaultSurface),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const previousSuccessAt = cached?.lastSuccessfulAt ?? null;
    const previousSuccessEndpoint = cached?.lastSuccessfulEndpoint ?? null;
    const consecutiveFailures = cached?.consecutiveFailures ?? 0;

    if (result.state === 'available') {
      this.cache.set(runtime, {
        status: result,
        nextProbeAt: now + this.successTtlMs,
        consecutiveFailures: 0,
        lastSuccessfulAt: result.checkedAt,
        lastSuccessfulEndpoint: result.endpoint,
      });
      return result;
    }

    const stale = this.toStaleState(result, previousSuccessAt, previousSuccessEndpoint);
    const nextStatus = stale ?? result;
    const nextFailures = consecutiveFailures + 1;
    const backoffMs = Math.min(
      this.failureMaxBackoffMs,
      this.failureBaseBackoffMs * 2 ** Math.max(0, nextFailures - 1)
    );

    this.cache.set(runtime, {
      status: nextStatus,
      nextProbeAt: now + backoffMs,
      consecutiveFailures: nextFailures,
      lastSuccessfulAt: previousSuccessAt,
      lastSuccessfulEndpoint: previousSuccessEndpoint,
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
      state: 'stale',
      checkedAt: failure.checkedAt,
      endpoint: lastSuccessfulEndpoint,
      lastSuccessfulAt,
      reason: toFailureReason(failure.state),
      ...(message ? { message } : {}),
    };
  }

  private async executeProbe(
    runtime: LocalRuntimeId,
    options: { readonly signal?: AbortSignal; readonly surface: LocalRuntimeSurface }
  ): Promise<LocalRuntimeAvailableState | LocalRuntimeFailureState> {
    if (!this.fetchImpl) {
      return {
        state: 'unavailable',
        checkedAt: this.now(),
        message: 'Fetch implementation is not available',
      };
    }

    const probes = DEFAULT_PROBES[runtime];
    const failures: ProbeAttemptFailure[] = [];

    for (const probe of probes) {
      const checkedAt = this.now();
      try {
        const responseResult = await fetchJsonWithTimeout(probe.endpoint, {
          fetchImpl: this.fetchImpl,
          timeoutMs: this.requestTimeoutMs,
          ...(options.signal ? { signal: options.signal } : {}),
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
        const failure = toFailureState(checkedAt, probe.endpoint, error, options.surface);
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
      state: 'unavailable',
      checkedAt: this.now(),
      message: `No probe endpoints configured for ${runtime}`,
    };
  }
}
