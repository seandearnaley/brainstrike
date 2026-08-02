import { useSecretsStore } from '@brainstrike/app-state/stores/secrets-store';
import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import {
  listProviders,
  type ProviderDefinition,
  providerEnvKeys,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { useToast } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { CredentialLoadError } from './credential-load-error';
import type { ProviderOption, SettingsProviderKeyId } from './provider-key-types';
import { getSecretsCapability, TAVILY_SECRET_PROVIDER } from './provider-key-types';
import { ProviderKeysCard } from './provider-keys-card';
import { TavilyKeyCard } from './tavily-key-card';
import { useCredentialMutations } from './use-credential-mutations';

const TAVILY_ENV_KEYS = new Set(['BRAINSTRIKE_TAVILY_API_KEY', 'TAVILY_API_KEY']);

interface ApiKeysState {
  apiKey: string;
  busy: boolean;
  loadError: string | null;
  providerKeySources: ProviderKeySource<SettingsProviderKeyId>[];
  rawProvider: string;
  sourceState: 'error' | 'loading' | 'ready';
  tavilyKey: string;
}

type ApiKeysAction =
  | { type: 'SET_PROVIDER'; provider: string }
  | { type: 'SET_API_KEY'; key: string }
  | { type: 'SET_TAVILY_KEY'; key: string }
  | {
      type: 'SOURCE_LOAD_SUCCEEDED';
      sources: ProviderKeySource<SettingsProviderKeyId>[];
    }
  | { type: 'SOURCE_LOAD_FAILED'; message: string }
  | { type: 'SOURCE_LOAD_STARTED' }
  | { type: 'SET_BUSY'; busy: boolean }
  | { type: 'SAVE_SUCCESS' }
  | { type: 'SAVE_TAVILY_SUCCESS' };

function apiKeysReducer(state: ApiKeysState, action: ApiKeysAction): ApiKeysState {
  switch (action.type) {
    case 'SET_PROVIDER':
      return { ...state, rawProvider: action.provider };
    case 'SET_API_KEY':
      return { ...state, apiKey: action.key };
    case 'SET_TAVILY_KEY':
      return { ...state, tavilyKey: action.key };
    case 'SOURCE_LOAD_STARTED':
      return { ...state, loadError: null, sourceState: 'loading' };
    case 'SOURCE_LOAD_SUCCEEDED':
      return {
        ...state,
        loadError: null,
        providerKeySources: action.sources,
        sourceState: 'ready',
      };
    case 'SOURCE_LOAD_FAILED':
      return { ...state, loadError: action.message, sourceState: 'error' };
    case 'SET_BUSY':
      return { ...state, busy: action.busy };
    case 'SAVE_SUCCESS':
      return { ...state, apiKey: '', busy: false };
    case 'SAVE_TAVILY_SUCCESS':
      return { ...state, busy: false, tavilyKey: '' };
    default:
      return state;
  }
}

function invalidCredentialStatus(): Error {
  return new Error('The desktop returned invalid credential status metadata.');
}

function isAllowedProviderEnvVar(provider: SettingsProviderKeyId, envVar: string): boolean {
  if (provider === TAVILY_SECRET_PROVIDER) {
    return TAVILY_ENV_KEYS.has(envVar);
  }
  return providerEnvKeys(provider).includes(envVar);
}

function parseProviderKeySources(
  value: unknown,
  allowedProviders: ReadonlySet<string>
): ProviderKeySource<SettingsProviderKeyId>[] {
  if (!Array.isArray(value)) {
    throw invalidCredentialStatus();
  }

  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    if (!(entry && typeof entry === 'object')) {
      throw invalidCredentialStatus();
    }

    const candidate = entry as Record<string, unknown>;
    const provider = candidate['provider'];
    const source = candidate['source'];
    if (
      typeof provider !== 'string' ||
      !allowedProviders.has(provider) ||
      seen.has(provider) ||
      (source !== 'env' && source !== 'stored')
    ) {
      throw invalidCredentialStatus();
    }

    seen.add(provider);
    if (source === 'stored') {
      if (Object.keys(candidate).length !== 2 || Object.hasOwn(candidate, 'envVar')) {
        throw invalidCredentialStatus();
      }
      return { provider: provider as SettingsProviderKeyId, source };
    }

    const envVar = candidate['envVar'];
    if (
      Object.keys(candidate).length !== 3 ||
      typeof envVar !== 'string' ||
      envVar.trim().length === 0 ||
      !isAllowedProviderEnvVar(provider as SettingsProviderKeyId, envVar)
    ) {
      throw invalidCredentialStatus();
    }
    return {
      envVar,
      provider: provider as SettingsProviderKeyId,
      source,
    };
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'Credential status could not be loaded.';
}

export interface ApiKeysSettingsProps {
  readonly statusError?: string | undefined;
  readonly statusProviderKeySources?: readonly ProviderKeySource<SupportedProvider>[] | undefined;
}

/**
 * Settings section for managing LLM provider API keys.
 * Uses the Electron `window.secrets` API for secure storage.
 *
 * @platform desktop
 */
export function ApiKeysSettings({
  statusError,
  statusProviderKeySources = [],
}: ApiKeysSettingsProps = {}) {
  const { toast } = useToast();
  const notifySecretsChanged = useSecretsStore((state) => state.notifySecretsChanged);
  const providerDefinitions = useMemo(() => listProviders(), []);
  const providerOptions = useMemo(
    (): ProviderOption[] =>
      providerDefinitions.map((definition: ProviderDefinition) => ({
        id: definition.id,
        name: definition.displayName,
      })),
    [providerDefinitions]
  );

  const [state, dispatch] = useReducer(apiKeysReducer, {
    apiKey: '',
    busy: false,
    loadError: null,
    providerKeySources: [],
    rawProvider: providerOptions[0]?.id ?? 'openai',
    sourceState: 'loading',
    tavilyKey: '',
  });
  const { rawProvider, apiKey, tavilyKey, loadError, providerKeySources, sourceState, busy } =
    state;
  const allowedProviderKeyIds = useMemo(
    () => new Set([...providerOptions.map((option) => option.id), TAVILY_SECRET_PROVIDER]),
    [providerOptions]
  );
  const mergedProviderKeySources = useMemo(() => {
    const merged = new Map<SettingsProviderKeyId, ProviderKeySource<SettingsProviderKeyId>>();
    for (const source of providerKeySources) {
      merged.set(source.provider, source);
    }
    for (const source of statusProviderKeySources) {
      const existing = merged.get(source.provider);
      if (source.source === 'env' || !existing) {
        merged.set(source.provider, source);
      }
    }
    return merged;
  }, [providerKeySources, statusProviderKeySources]);

  // Derive effective provider - always valid even if options change
  const provider = useMemo(() => {
    const isValid = providerOptions.some((option) => option.id === rawProvider);
    return isValid ? rawProvider : (providerOptions[0]?.id ?? 'openai');
  }, [providerOptions, rawProvider]);

  const selectedProviderName = useMemo(
    () => providerOptions.find((option) => option.id === provider)?.name ?? provider,
    [providerOptions, provider]
  );
  const providerKeyHint = useMemo(() => {
    if (provider === 'google') {
      return 'Use a Gemini API key from Google AI Studio. Vertex AI keys are not supported yet.';
    }
    return null;
  }, [provider]);
  const providerKeySource = mergedProviderKeySources.get(provider as SettingsProviderKeyId);
  const providerEnvironmentSource =
    providerKeySource?.source === 'env' ? providerKeySource : undefined;
  const tavilyKeySource = mergedProviderKeySources.get(TAVILY_SECRET_PROVIDER);
  const tavilyEnvironmentSource = tavilyKeySource?.source === 'env' ? tavilyKeySource : undefined;
  const visibleErrors = [...new Set([statusError, loadError].filter(Boolean))].join(' ');

  const refreshProviders = useCallback(async () => {
    dispatch({ type: 'SOURCE_LOAD_STARTED' });
    const listFn = getSecretsCapability()?.list;
    if (!listFn) {
      dispatch({
        message: 'Secure credential status is unavailable.',
        type: 'SOURCE_LOAD_FAILED',
      });
      return;
    }
    try {
      const sources = parseProviderKeySources(await listFn(), allowedProviderKeyIds);
      dispatch({ sources, type: 'SOURCE_LOAD_SUCCEEDED' });
    } catch (error) {
      dispatch({ message: toErrorMessage(error), type: 'SOURCE_LOAD_FAILED' });
    }
  }, [allowedProviderKeyIds]);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const setBusy = useCallback((busy: boolean) => {
    dispatch({ busy, type: 'SET_BUSY' });
  }, []);
  const { deleteSecret, saveSecret } = useCredentialMutations({
    notifySecretsChanged,
    refresh: refreshProviders,
    setBusy,
    sourceState,
    toast,
  });

  const handleSave = useCallback(async () => {
    // An environment variable is authoritative, so a keychain write would be
    // inert; the button is disabled, and this guards a stale click.
    if (providerEnvironmentSource) {
      return;
    }
    if (await saveSecret(provider, apiKey)) {
      dispatch({ type: 'SAVE_SUCCESS' });
    }
  }, [apiKey, provider, providerEnvironmentSource, saveSecret]);

  const handleDelete = useCallback(async () => {
    // Delete removes a KEYCHAIN entry, so it is only meaningful when one exists.
    if (providerKeySource?.source !== 'stored') {
      return;
    }
    await deleteSecret(provider);
  }, [deleteSecret, provider, providerKeySource]);

  const handleSaveTavily = useCallback(async () => {
    if (tavilyEnvironmentSource) {
      return;
    }
    if (await saveSecret(TAVILY_SECRET_PROVIDER, tavilyKey)) {
      dispatch({ type: 'SAVE_TAVILY_SUCCESS' });
    }
  }, [saveSecret, tavilyEnvironmentSource, tavilyKey]);

  const handleDeleteTavily = useCallback(async () => {
    if (tavilyKeySource?.source !== 'stored') {
      return;
    }
    await deleteSecret(TAVILY_SECRET_PROVIDER);
  }, [deleteSecret, tavilyKeySource]);

  return (
    <div className="space-y-4">
      <CredentialLoadError message={visibleErrors} />
      <ProviderKeysCard
        apiKey={apiKey}
        busy={busy}
        environmentSource={providerEnvironmentSource}
        hasStoredKey={providerKeySource?.source === 'stored'}
        keyHint={providerKeyHint}
        keySource={providerKeySource}
        onApiKeyChange={(key) => dispatch({ key, type: 'SET_API_KEY' })}
        onDelete={handleDelete}
        onProviderChange={(value) => dispatch({ provider: value, type: 'SET_PROVIDER' })}
        onSave={handleSave}
        provider={provider}
        providerOptions={providerOptions}
        selectedProviderName={selectedProviderName}
        sourceState={sourceState}
      />
      <TavilyKeyCard
        busy={busy}
        environmentSource={tavilyEnvironmentSource}
        hasStoredKey={tavilyKeySource?.source === 'stored'}
        keySource={tavilyKeySource}
        onDelete={handleDeleteTavily}
        onKeyChange={(key) => dispatch({ key, type: 'SET_TAVILY_KEY' })}
        onSave={handleSaveTavily}
        sourceState={sourceState}
        tavilyKey={tavilyKey}
      />
    </div>
  );
}

export default ApiKeysSettings;
