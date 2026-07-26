import {
  ASSISTANT_AUTH_HEADER_NAME,
  isSecretReadErrorCode,
  type ProviderKeySource,
  type SecretReadErrorCode,
} from '@brainstrike/assistant-contract';
import {
  isSupportedProvider,
  isValidModelForProvider,
  providerEnvKeys,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { useSecretsStore } from '@brainstrike/preferences/stores/secrets-store';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { useEffect, useState, useSyncExternalStore } from 'react';

export interface AssistantProviderReadError {
  readonly code: SecretReadErrorCode;
  readonly error: 'api_key_unreadable';
  readonly message: string;
  readonly provider: SupportedProvider;
}

export interface AssistantEnvironmentFileFailure {
  readonly code: 'env_file_invalid' | 'env_file_unreadable';
  readonly file: 'dev' | 'dev-local' | 'user-data';
  readonly message: string;
}

export type AssistantAvailabilityStatus =
  | { state: 'loading' }
  | {
      state: 'enabled';
      model?: string;
      provider?: SupportedProvider;
      providerErrors?: readonly AssistantProviderReadError[];
      providerKeySources?: readonly ProviderKeySource<SupportedProvider>[];
      providers?: readonly SupportedProvider[];
    }
  | { state: 'disabled'; reason?: string }
  | {
      state: 'error';
      envFileFailures?: readonly AssistantEnvironmentFileFailure[];
      message: string;
    };

export type AssistantStatusFetcher = (signal: AbortSignal) => Promise<AssistantAvailabilityStatus>;

const defaultFetcher: AssistantStatusFetcher = (signal) => fetchAssistantStatusState({ signal });
const loadingStatus: AssistantAvailabilityStatus = { state: 'loading' };
export const ASSISTANT_AVAILABILITY_OVERRIDE_EVENT =
  'brainstrike:assistant-availability-override-changed';

interface AssistantAvailabilityOverrideSnapshot {
  readonly override: AssistantAvailabilityStatus | undefined;
  readonly revision: number;
}

interface FetchedAssistantAvailability {
  readonly fetcher: AssistantStatusFetcher;
  readonly overrideRevision: number;
  readonly secretsVersion: number;
  readonly status: AssistantAvailabilityStatus;
}

const serverOverrideSnapshot: AssistantAvailabilityOverrideSnapshot = {
  override: undefined,
  revision: 0,
};
const overrideListeners = new Set<() => void>();
let overrideSnapshot = serverOverrideSnapshot;

declare global {
  interface Window {
    __assistantAvailabilityOverride?: AssistantAvailabilityStatus;
  }
}

export function useAssistantAvailability(
  fetcher: AssistantStatusFetcher = defaultFetcher
): AssistantAvailabilityStatus {
  const secretsVersion = useSecretsStore((state) => state.secretsVersion);
  const { override, revision: overrideRevision } = useSyncExternalStore(
    subscribeToAssistantAvailabilityOverride,
    getAssistantAvailabilityOverrideSnapshot,
    getServerAssistantAvailabilityOverrideSnapshot
  );
  const [fetchedAvailability, setFetchedAvailability] = useState<FetchedAssistantAvailability>(
    () => ({
      fetcher,
      overrideRevision,
      secretsVersion,
      status: loadingStatus,
    })
  );

  useEffect(() => {
    if (override !== undefined) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    fetcher(controller.signal)
      .then((next) => {
        if (!cancelled) {
          setFetchedAvailability({
            fetcher,
            overrideRevision,
            secretsVersion,
            status: next,
          });
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        if (isAbortError(error)) {
          return;
        }
        setFetchedAvailability({
          fetcher,
          overrideRevision,
          secretsVersion,
          status: {
            message: error instanceof Error ? error.message : String(error),
            state: 'error',
          },
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fetcher, override, overrideRevision, secretsVersion]);

  if (override !== undefined) {
    return override;
  }

  if (
    fetchedAvailability.fetcher !== fetcher ||
    fetchedAvailability.overrideRevision !== overrideRevision ||
    fetchedAvailability.secretsVersion !== secretsVersion
  ) {
    return loadingStatus;
  }

  return fetchedAvailability.status;
}

function readAssistantAvailabilityOverride(): AssistantAvailabilityStatus | undefined {
  return typeof window === 'undefined' ? undefined : window.__assistantAvailabilityOverride;
}

function getAssistantAvailabilityOverrideSnapshot(): AssistantAvailabilityOverrideSnapshot {
  const override = readAssistantAvailabilityOverride();
  if (overrideSnapshot.override !== override) {
    overrideSnapshot = {
      override,
      revision: overrideSnapshot.revision + 1,
    };
  }
  return overrideSnapshot;
}

function getServerAssistantAvailabilityOverrideSnapshot(): AssistantAvailabilityOverrideSnapshot {
  return serverOverrideSnapshot;
}

function publishAssistantAvailabilityOverride(): void {
  overrideSnapshot = {
    override: readAssistantAvailabilityOverride(),
    revision: overrideSnapshot.revision + 1,
  };
  for (const listener of overrideListeners) {
    listener();
  }
}

function subscribeToAssistantAvailabilityOverride(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  if (overrideListeners.size === 0) {
    window.addEventListener(
      ASSISTANT_AVAILABILITY_OVERRIDE_EVENT,
      publishAssistantAvailabilityOverride
    );
  }
  overrideListeners.add(onStoreChange);

  return () => {
    overrideListeners.delete(onStoreChange);
    if (overrideListeners.size === 0) {
      window.removeEventListener(
        ASSISTANT_AVAILABILITY_OVERRIDE_EVENT,
        publishAssistantAvailabilityOverride
      );
    }
  };
}

/**
 * Resolve the assistant server ROOT base URL via the same strategy the status
 * probe uses (bridge `getUrl()` → static `url` → `/api` fallback). Callers append
 * their own endpoint path (`/assistant/status`, `/assistant/suspended-runs`, …).
 */
export async function resolveAssistantBaseUrl(): Promise<string> {
  if (typeof window === 'undefined') {
    return '/api';
  }

  interface AssistantBridge {
    getUrl?: () => Promise<string>;
    url?: string;
  }

  const assistantBridge = (window as unknown as { assistant?: AssistantBridge }).assistant;

  if (assistantBridge) {
    if (typeof assistantBridge.getUrl === 'function') {
      try {
        const base = await assistantBridge.getUrl();
        if (base) {
          return trimTrailingSlash(base);
        }
      } catch {
        // ignored - fall through to other strategies
      }
    }

    if (typeof assistantBridge.url === 'string' && assistantBridge.url.length > 0) {
      return trimTrailingSlash(assistantBridge.url);
    }
  }

  return '/api';
}

/**
 * Resolves the auth headers every assistant-server request must carry. The
 * desktop bridge's `getAuth` supplies the per-boot token (see
 * `ASSISTANT_AUTH_HEADER_NAME` in @brainstrike/assistant-contract); web builds
 * have no bridge and get an empty object (same-origin `/api` needs none).
 */
interface AssistantAuthBridge {
  getAuth?: () => Promise<{ token: string; url: string } | { startupError: string } | null>;
}

/**
 * Returns the startup failure message when the desktop main process reported
 * the assistant server never started; undefined otherwise (incl. web builds).
 */
export async function readAssistantStartupFailure(): Promise<string | undefined> {
  if (typeof window === 'undefined') {
    return;
  }
  const bridge = (window as unknown as { assistant?: AssistantAuthBridge }).assistant;
  if (bridge && typeof bridge.getAuth === 'function') {
    try {
      const auth = await bridge.getAuth();
      if (auth && 'startupError' in auth) {
        return auth.startupError;
      }
    } catch {
      // ignored — the availability probe's own failure handling reports.
    }
  }
  return;
}

export async function resolveAssistantAuthHeaders(): Promise<Record<string, string>> {
  if (typeof window === 'undefined') {
    return {};
  }

  const bridge = (window as unknown as { assistant?: AssistantAuthBridge }).assistant;
  if (bridge && typeof bridge.getAuth === 'function') {
    try {
      const auth = await bridge.getAuth();
      if (auth && 'token' in auth && auth.token) {
        return { [ASSISTANT_AUTH_HEADER_NAME]: auth.token };
      }
    } catch {
      // ignored — the request proceeds without the header and the server's
      // 401 surfaces the failure loudly instead of a silent client-side guess.
    }
  }

  return {};
}

export async function resolveAssistantStatusUrl(): Promise<string> {
  return `${await resolveAssistantBaseUrl()}/assistant/status`;
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

interface FetchAssistantStatusStateOptions {
  fetchImpl?: typeof fetch;
  signal: AbortSignal;
}

export async function fetchAssistantStatusState({
  signal,
  fetchImpl = globalThis.fetch,
}: FetchAssistantStatusStateOptions): Promise<AssistantAvailabilityStatus> {
  if (!fetchImpl) {
    throw new Error('Fetch implementation is not available');
  }

  const startupFailure = await readAssistantStartupFailure();
  if (startupFailure) {
    // The desktop main process reported the server never started — present
    // the concrete failure instead of probing a dead endpoint (BST-574).
    return { message: startupFailure, state: 'error' };
  }

  const url = await resolveAssistantStatusUrl();
  const authHeaders = await resolveAssistantAuthHeaders();
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', ...authHeaders },
    signal,
  });

  if (!response.ok) {
    throw new Error(`status ${response.status}`);
  }

  const rawPayload: unknown = await response.json();
  if (!(rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload))) {
    throw new Error('Invalid assistant status payload');
  }
  return parseAssistantStatusPayload(rawPayload as Record<string, unknown>);
}

function parseAssistantStatusPayload(
  payload: Record<string, unknown>
): AssistantAvailabilityStatus {
  if (payload['error'] !== undefined) {
    return parseAssistantConfigurationError(payload);
  }

  assertOnlyKnownKeys(
    payload,
    ['enabled', 'model', 'provider', 'providerErrors', 'providerKeySources', 'providers', 'reason'],
    'Invalid assistant status payload'
  );
  if (typeof payload['enabled'] !== 'boolean') {
    throw new Error('Invalid assistant status payload');
  }
  return payload['enabled']
    ? parseEnabledAssistantStatus(payload)
    : parseDisabledAssistantStatus(payload);
}

function parseEnabledAssistantStatus(
  payload: Record<string, unknown>
): AssistantAvailabilityStatus {
  if (payload['reason'] !== undefined) {
    throw new Error('Enabled assistant status must not include a disabled reason');
  }
  const providerErrors = parseAssistantProviderReadErrors(payload['providerErrors']);
  const providers = parseAssistantProviders(payload['providers']);
  const providerKeySources = parseAssistantProviderKeySources(payload['providerKeySources']);
  validateProviderStatusConsistency({ providerErrors, providerKeySources, providers });

  const provider = payload['provider'];
  const model = payload['model'];
  const hasProvider = provider !== undefined;
  const hasModel = model !== undefined;
  if (hasProvider !== hasModel) {
    throw new Error('Assistant status must advertise provider and model together');
  }
  if (!(hasProvider && hasModel)) {
    return {
      ...(providerErrors ? { providerErrors } : {}),
      ...(providerKeySources ? { providerKeySources } : {}),
      ...(providers ? { providers } : {}),
      state: 'enabled',
    };
  }
  if (typeof provider !== 'string' || !isSupportedProvider(provider)) {
    throw new Error(`Unsupported assistant provider: ${String(provider)}`);
  }
  if (typeof model !== 'string' || !isValidModelForProvider(provider, model)) {
    throw new Error(`Unsupported assistant model: ${provider}/${String(model)}`);
  }
  if (providers && !providers.includes(provider)) {
    throw new Error('Assistant status fixed provider is missing from providers');
  }
  return {
    model,
    ...(providerErrors ? { providerErrors } : {}),
    ...(providerKeySources ? { providerKeySources } : {}),
    ...(providers ? { providers } : {}),
    provider,
    state: 'enabled',
  };
}

function parseDisabledAssistantStatus(
  payload: Record<string, unknown>
): AssistantAvailabilityStatus {
  if (
    payload['provider'] !== undefined ||
    payload['model'] !== undefined ||
    payload['providerErrors'] !== undefined ||
    payload['providerKeySources'] !== undefined
  ) {
    throw new Error('Disabled assistant status contains enabled-provider metadata');
  }
  const providers = parseAssistantProviders(payload['providers']);
  if (providers && providers.length > 0) {
    throw new Error('Disabled assistant status contains available providers');
  }
  const reason = payload['reason'];
  if (reason !== undefined) {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new Error('Invalid assistant disabled reason');
    }
    return { reason, state: 'disabled' };
  }

  return { state: 'disabled' };
}

function assertOnlyKnownKeys(
  candidate: Record<string, unknown>,
  allowedKeys: readonly string[],
  message: string
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw new Error(message);
  }
}

function hasExactOwnKeys(
  candidate: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const actualKeys = Object.keys(candidate);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(candidate, key))
  );
}

function parseAssistantProviders(value: unknown): readonly SupportedProvider[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error('Invalid assistant provider list');
  }
  const providers = new Set<SupportedProvider>();
  for (const provider of value) {
    if (typeof provider !== 'string' || !isSupportedProvider(provider) || providers.has(provider)) {
      throw new Error('Invalid assistant provider list');
    }
    providers.add(provider);
  }
  return [...providers];
}

function parseAssistantProviderKeySources(
  value: unknown
): readonly ProviderKeySource<SupportedProvider>[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error('Invalid assistant provider key source list');
  }

  const providers = new Set<SupportedProvider>();
  return value.map((entry: unknown) => {
    if (!(entry && typeof entry === 'object' && !Array.isArray(entry))) {
      throw new Error('Invalid assistant provider key source');
    }
    const candidate = entry as Record<string, unknown>;
    const provider = candidate['provider'];
    const source = candidate['source'];
    if (typeof provider !== 'string' || !isSupportedProvider(provider) || providers.has(provider)) {
      throw new Error('Invalid assistant provider key source');
    }

    providers.add(provider);
    if (source === 'stored') {
      if (!hasExactOwnKeys(candidate, ['provider', 'source'])) {
        throw new Error('Invalid assistant provider key source');
      }
      return { provider, source };
    }
    if (source === 'env') {
      const envVar = candidate['envVar'];
      if (
        !hasExactOwnKeys(candidate, ['envVar', 'provider', 'source']) ||
        typeof envVar !== 'string' ||
        !providerEnvKeys(provider).includes(envVar)
      ) {
        throw new Error('Invalid assistant provider key source');
      }
      return { envVar, provider, source };
    }
    throw new Error('Invalid assistant provider key source');
  });
}

function validateProviderStatusConsistency({
  providerErrors,
  providerKeySources,
  providers,
}: {
  providerErrors: readonly AssistantProviderReadError[] | undefined;
  providerKeySources: readonly ProviderKeySource<SupportedProvider>[] | undefined;
  providers: readonly SupportedProvider[] | undefined;
}): void {
  if (providers && providers.length === 0) {
    throw new Error('Enabled assistant status must include an available provider');
  }
  const failedProviders = new Set(providerErrors?.map(({ provider }) => provider));
  if (providers?.some((provider) => failedProviders.has(provider))) {
    throw new Error('Assistant provider cannot be both available and unreadable');
  }
  const sourcedProviders = new Set(providerKeySources?.map(({ provider }) => provider));
  if (
    providerKeySources &&
    providers?.some(
      (provider) => providerEnvKeys(provider).length > 0 && !sourcedProviders.has(provider)
    )
  ) {
    throw new Error('Assistant hosted provider is missing its key source');
  }
  for (const source of providerKeySources ?? []) {
    if (failedProviders.has(source.provider)) {
      throw new Error('Assistant provider cannot be both configured and unreadable');
    }
    if (providers && !providers.includes(source.provider)) {
      throw new Error('Assistant provider key source is missing from providers');
    }
  }
}

function parseAssistantConfigurationError(
  payload: Record<string, unknown>
): AssistantAvailabilityStatus {
  if (
    !hasExactOwnKeys(payload, ['enabled', 'envFileFailures', 'error', 'message', 'providers']) ||
    payload['enabled'] !== false ||
    payload['error'] !== 'assistant_configuration_invalid' ||
    typeof payload['message'] !== 'string' ||
    payload['message'].trim().length === 0 ||
    !Array.isArray(payload['providers']) ||
    payload['providers'].length !== 0
  ) {
    throw new Error('Invalid assistant configuration error');
  }
  const envFileFailures = parseAssistantEnvironmentFileFailures(payload['envFileFailures']);
  if (envFileFailures.length === 0) {
    throw new Error('Invalid assistant configuration error');
  }
  return {
    envFileFailures,
    message: payload['message'],
    state: 'error',
  };
}

function parseAssistantEnvironmentFileFailures(
  value: unknown
): readonly AssistantEnvironmentFileFailure[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid assistant environment file failure list');
  }
  const files = new Set<AssistantEnvironmentFileFailure['file']>();
  return value.map((entry: unknown) => {
    if (!(entry && typeof entry === 'object' && !Array.isArray(entry))) {
      throw new Error('Invalid assistant environment file failure');
    }
    const candidate = entry as Record<string, unknown>;
    const code = candidate['code'];
    const file = candidate['file'];
    const message = candidate['message'];
    if (
      !hasExactOwnKeys(candidate, ['code', 'file', 'message']) ||
      (code !== 'env_file_invalid' && code !== 'env_file_unreadable') ||
      (file !== 'dev' && file !== 'dev-local' && file !== 'user-data') ||
      files.has(file) ||
      typeof message !== 'string' ||
      message.trim().length === 0
    ) {
      throw new Error('Invalid assistant environment file failure');
    }
    files.add(file);
    return { code, file, message };
  });
}

function parseAssistantProviderReadErrors(
  value: unknown
): readonly AssistantProviderReadError[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error('Invalid assistant provider error list');
  }

  const providers = new Set<SupportedProvider>();
  return value.map((entry: unknown) => {
    if (!(entry && typeof entry === 'object' && !Array.isArray(entry))) {
      throw new Error('Invalid assistant provider error');
    }
    const candidate = entry as Record<string, unknown>;
    const provider = candidate['provider'];
    const code = candidate['code'];
    if (
      typeof provider !== 'string' ||
      !isSupportedProvider(provider) ||
      providers.has(provider) ||
      !hasExactOwnKeys(candidate, ['code', 'error', 'message', 'provider']) ||
      candidate['error'] !== 'api_key_unreadable' ||
      !isSecretReadErrorCode(code) ||
      typeof candidate['message'] !== 'string' ||
      candidate['message'].trim().length === 0
    ) {
      throw new Error('Invalid assistant provider error');
    }
    providers.add(provider);
    return {
      code,
      error: 'api_key_unreadable',
      message: candidate['message'],
      provider,
    };
  });
}

export const __private__ = {
  trimTrailingSlash,
};
