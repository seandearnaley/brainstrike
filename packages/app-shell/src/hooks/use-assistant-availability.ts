import { useSecretsStore } from '@brainstrike/app-state/stores/secrets-store';
import {
  assertNoUnknownKeys,
  type DeprecatedEnvVarReport,
  getAssistantBridge,
  isAllowedProviderKeySourceEnvVar,
  isSecretReadErrorCode,
  type ProviderKeySource,
  parseAuthMode,
  type SecretReadErrorCode,
} from '@brainstrike/assistant-contract';
import {
  isSupportedProvider,
  isValidModelForProvider,
  PROVIDER_DEFAULT_MODELS,
  providerAuthType,
  providerDeprecatedEnvKeys,
  providerEnvKeys,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { type AssistantAuthBridge, resolveAssistantAuthHeaders } from '@brainstrike/assistant-data';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { useEffect, useState, useSyncExternalStore } from 'react';

export { resolveAssistantAuthHeaders } from '@brainstrike/assistant-data';

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
      deprecatedEnvVars?: readonly DeprecatedEnvVarReport[];
      model?: string;
      provider?: SupportedProvider;
      providerErrors?: readonly AssistantProviderReadError[];
      providerKeySources?: readonly ProviderKeySource<SupportedProvider>[];
      providers?: readonly SupportedProvider[];
    }
  | {
      state: 'disabled';
      deprecatedEnvVars?: readonly DeprecatedEnvVarReport[];
      reason?: string;
    }
  | {
      state: 'error';
      deprecatedEnvVars?: readonly DeprecatedEnvVarReport[];
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

  const assistantBridge = getAssistantBridge();

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
 * Returns the startup failure message when the desktop main process reported
 * the assistant server never started; undefined otherwise (incl. web builds).
 */
export async function readAssistantStartupFailure(): Promise<string | undefined> {
  if (typeof window === 'undefined') {
    return;
  }
  const bridge: AssistantAuthBridge | undefined = getAssistantBridge();
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

  // Independent resolutions, so they overlap — the same shape
  // use-provider-verification and use-steer-active-run already use. The
  // startup-failure read above stays sequential: it short-circuits.
  const [url, authHeaders] = await Promise.all([
    resolveAssistantStatusUrl(),
    resolveAssistantAuthHeaders(),
  ]);
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
    [
      'deprecatedEnvVars',
      'enabled',
      'model',
      'provider',
      'providerErrors',
      'providerKeySources',
      'providers',
      'reason',
    ],
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
  const deprecatedEnvVars = parseAssistantDeprecatedEnvVars(payload['deprecatedEnvVars']);
  validateProviderStatusConsistency({ providerErrors, providerKeySources, providers });
  const metadata = {
    ...(deprecatedEnvVars ? { deprecatedEnvVars } : {}),
    ...(providerErrors ? { providerErrors } : {}),
    ...(providerKeySources ? { providerKeySources } : {}),
    ...(providers ? { providers } : {}),
  };

  const provider = payload['provider'];
  const model = payload['model'];
  const hasProvider = provider !== undefined;
  const hasModel = model !== undefined;
  if (hasProvider !== hasModel) {
    throw new Error('Assistant status must advertise provider and model together');
  }
  if (!(hasProvider && hasModel)) {
    return { ...metadata, state: 'enabled' };
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
  return { ...metadata, model, provider, state: 'enabled' };
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
  // A fully unconfigured host can still have a deprecated name set — that is
  // the primary rename-warning case (BST-1361), so a disabled status carries
  // the reports too.
  const deprecatedEnvVars = parseAssistantDeprecatedEnvVars(payload['deprecatedEnvVars']);
  const reason = payload['reason'];
  if (reason !== undefined) {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new Error('Invalid assistant disabled reason');
    }
    return { ...(deprecatedEnvVars ? { deprecatedEnvVars } : {}), reason, state: 'disabled' };
  }

  return { ...(deprecatedEnvVars ? { deprecatedEnvVars } : {}), state: 'disabled' };
}

/**
 * Strictly validated deprecated env-var rename reports (BST-1361). Each entry
 * carries exactly `{envVar, provider, replacement}` with a registry provider —
 * a malformed report fails the probe visibly rather than being dropped.
 */
function parseAssistantDeprecatedEnvVars(
  value: unknown
): readonly DeprecatedEnvVarReport[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error('Invalid assistant deprecated env var report list');
  }
  // One Set per provider, built lazily and shared across entries: reports
  // frequently name the same provider more than once, and a plain `.includes`
  // rescanned that provider's deprecated-name array on every entry.
  const deprecatedNames = new Map<SupportedProvider, ReadonlySet<string>>();
  const deprecatedNamesFor = (provider: SupportedProvider): ReadonlySet<string> => {
    const cached = deprecatedNames.get(provider);
    if (cached) {
      return cached;
    }
    const names = new Set(providerDeprecatedEnvKeys(provider));
    deprecatedNames.set(provider, names);
    return names;
  };
  return value.map((entry: unknown) => {
    if (!(entry && typeof entry === 'object' && !Array.isArray(entry))) {
      throw new Error('Invalid assistant deprecated env var report');
    }
    const candidate = entry as Record<string, unknown>;
    const envVar = candidate['envVar'];
    const provider = candidate['provider'];
    const replacement = candidate['replacement'];
    if (
      !hasExactOwnKeys(candidate, ['envVar', 'provider', 'replacement']) ||
      typeof envVar !== 'string' ||
      envVar.trim().length === 0 ||
      typeof provider !== 'string' ||
      !isSupportedProvider(provider) ||
      // Registry cross-check (review 10a): the reported name must actually be
      // a deprecated name for that provider — same discipline the key-source
      // parser applies to providerEnvKeys.
      !deprecatedNamesFor(provider).has(envVar) ||
      typeof replacement !== 'string' ||
      replacement.trim().length === 0
    ) {
      throw new Error('Invalid assistant deprecated env var report');
    }
    return { envVar, provider, replacement };
  });
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

/** Shared rule (BST-1353) so this parser cannot drift from the contract's. */
function isAllowedKeySourceEnvVar(provider: SupportedProvider, envVar: string): boolean {
  return isAllowedProviderKeySourceEnvVar(
    envVar,
    providerEnvKeys(provider),
    providerAuthType(provider) === 'aws'
  );
}

/**
 * The status payload's own error for a malformed key source. The SHARED
 * contract helpers take this as their thrower (PR #2525 review, finding 8),
 * so this parser and `parseProviderKeySources` enforce byte-identical
 * strictness while each keeps its own error text.
 */
function invalidKeySource(): Error {
  return new Error('Invalid assistant provider key source');
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

function parseStoredKeySource(
  candidate: Record<string, unknown>,
  provider: SupportedProvider
): ProviderKeySource<SupportedProvider> {
  assertNoUnknownKeys(candidate, ['authMode', 'provider', 'source'], invalidKeySource);
  const authMode = parseAuthMode(candidate, invalidKeySource);
  return { ...(authMode ? { authMode } : {}), provider, source: 'stored' };
}

function parseEnvKeySource(
  candidate: Record<string, unknown>,
  provider: SupportedProvider
): ProviderKeySource<SupportedProvider> {
  assertNoUnknownKeys(candidate, ['authMode', 'envVar', 'provider', 'source'], invalidKeySource);
  const envVar = candidate['envVar'];
  if (
    typeof envVar !== 'string' ||
    // BST-1353: the AWS chain is activated by AWS_PROFILE/AWS_ACCESS_KEY_ID,
    // which are NOT provider key names, so aws-authType providers accept the
    // chain activation names in addition to their own bearer vars.
    !isAllowedKeySourceEnvVar(provider, envVar)
  ) {
    throw invalidKeySource();
  }
  const authMode = parseAuthMode(candidate, invalidKeySource);
  return { ...(authMode ? { authMode } : {}), envVar, provider, source: 'env' };
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
      return parseStoredKeySource(candidate, provider);
    }
    if (source === 'env') {
      return parseEnvKeySource(candidate, provider);
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
  for (const provider of providers ?? []) {
    if (!PROVIDER_DEFAULT_MODELS[provider]) {
      throw new Error(`Assistant status provider ${provider} has no registry default model`);
    }
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
  // Loop-invariant, so it is built once rather than rescanned per source.
  const providerSet = providers ? new Set(providers) : undefined;
  for (const source of providerKeySources ?? []) {
    if (failedProviders.has(source.provider)) {
      throw new Error('Assistant provider cannot be both configured and unreadable');
    }
    if (providerSet && !providerSet.has(source.provider)) {
      throw new Error('Assistant provider key source is missing from providers');
    }
  }
}

function parseAssistantConfigurationError(
  payload: Record<string, unknown>
): AssistantAvailabilityStatus {
  // `deprecatedEnvVars` is the one optional key (BST-1361): a rejected env
  // file and a deprecated alias frequently co-occur, and the rename guidance
  // must survive the failure payload.
  const expectedKeys = Object.hasOwn(payload, 'deprecatedEnvVars')
    ? ['deprecatedEnvVars', 'enabled', 'envFileFailures', 'error', 'message', 'providers']
    : ['enabled', 'envFileFailures', 'error', 'message', 'providers'];
  if (
    !hasExactOwnKeys(payload, expectedKeys) ||
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
  const deprecatedEnvVars = parseAssistantDeprecatedEnvVars(payload['deprecatedEnvVars']);
  return {
    ...(deprecatedEnvVars ? { deprecatedEnvVars } : {}),
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
