import {
  listProviders,
  type ProviderDefinition,
} from '@brainstrike/assistant-contract/provider-metadata';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@brainstrike/ui';
import { useCallback, useEffect, useId, useMemo, useReducer } from 'react';
import { useSecretsStore } from '../../stores/secrets-store';

interface ProviderOption {
  id: string;
  name: string;
}

/**
 * Secrets-store id for the Tavily web-search key. NOT an LLM `ProviderId`
 * (Tavily is a search service, not a model provider), so it is stored directly
 * by this id and kept out of the provider dropdown/registry.
 */
const TAVILY_SECRET_PROVIDER = 'tavily';

interface ApiKeysState {
  apiKey: string;
  busy: boolean;
  envFileErrors: SecretsEnvFileError[];
  keySources: SecretSourceDescriptor[];
  rawProvider: string;
  tavilyKey: string;
}

type ApiKeysAction =
  | { type: 'SET_PROVIDER'; provider: string }
  | { type: 'SET_API_KEY'; key: string }
  | { type: 'SET_TAVILY_KEY'; key: string }
  | {
      type: 'SET_KEY_SOURCES';
      envFileErrors: SecretsEnvFileError[];
      keySources: SecretSourceDescriptor[];
    }
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
    case 'SET_KEY_SOURCES':
      return { ...state, envFileErrors: action.envFileErrors, keySources: action.keySources };
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

/** Names-only listing of stored providers, mapped to keychain-sourced rows. */
function toStoredSources(providers: readonly string[]): SecretSourceDescriptor[] {
  return providers.map((provider) => ({ provider, source: 'stored' as const }));
}

/**
 * The source-aware desktop bridge, when present. Returns null when the bridge
 * lacks `describe` (capability check, not a silent degrade) or the call fails,
 * so the caller can fall back to the stored-only listings.
 */
async function readSecretsDescription(): Promise<{
  envFileErrors: SecretsEnvFileError[];
  keySources: SecretSourceDescriptor[];
} | null> {
  const describe = window.secrets?.describe;
  if (!describe) {
    return null;
  }
  try {
    const description = await describe();
    if (!Array.isArray(description?.entries)) {
      return null;
    }
    return {
      envFileErrors: Array.isArray(description.envFileErrors) ? description.envFileErrors : [],
      keySources: description.entries,
    };
  } catch {
    return null;
  }
}

/** Stored-only fallback: `listStored` first, then the merged `list`. */
async function readStoredProviderList(): Promise<SecretSourceDescriptor[] | null> {
  for (const listFn of [window.secrets?.listStored, window.secrets?.list]) {
    if (!listFn) {
      continue;
    }
    try {
      const providers = await listFn();
      if (Array.isArray(providers)) {
        return toStoredSources(providers);
      }
    } catch {
      // ignored — try the next listing, then report nothing configured.
    }
  }
  return null;
}

/**
 * Settings section for managing LLM provider API keys.
 * Uses the Electron `window.secrets` API for secure storage.
 *
 * @platform desktop
 */
export function ApiKeysSettings() {
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
    envFileErrors: [],
    keySources: [],
    rawProvider: providerOptions[0]?.id ?? 'openai',
    tavilyKey: '',
  });
  const { rawProvider, apiKey, tavilyKey, keySources, envFileErrors, busy } = state;
  const tavilySource = useMemo(
    () => keySources.find((entry) => entry.provider === TAVILY_SECRET_PROVIDER),
    [keySources]
  );

  // Derive effective provider - always valid even if options change
  const provider = useMemo(() => {
    const isValid = providerOptions.some((option) => option.id === rawProvider);
    return isValid ? rawProvider : (providerOptions[0]?.id ?? 'openai');
  }, [providerOptions, rawProvider]);

  const selectedProviderName = useMemo(
    () => providerOptions.find((option) => option.id === provider)?.name ?? provider,
    [providerOptions, provider]
  );
  /** Provider credential rows, excluding Tavily (it owns the card below). */
  const llmKeySources = useMemo(
    () => keySources.filter((entry) => entry.provider !== TAVILY_SECRET_PROVIDER),
    [keySources]
  );
  const selectedProviderEnvVar = useMemo(
    () =>
      keySources.find((entry) => entry.provider === provider && entry.source === 'env')?.envVar ??
      null,
    [keySources, provider]
  );
  const providerKeyHint = useMemo(() => {
    if (provider === 'google') {
      return 'Use a Gemini API key from Google AI Studio. Vertex AI keys are not supported yet.';
    }
    return null;
  }, [provider]);

  /**
   * Prefer the source-aware `describe` bridge so an environment credential is
   * visible as the one the runtime will actually use. Older bridges without it
   * (capability check, not a silent degrade) fall back to the stored-only
   * listings, which can only ever report keychain entries.
   */
  const refreshProviders = useCallback(async () => {
    const description = await readSecretsDescription();
    if (description) {
      dispatch({ ...description, type: 'SET_KEY_SOURCES' });
      return;
    }
    const stored = await readStoredProviderList();
    if (stored) {
      dispatch({ envFileErrors: [], keySources: stored, type: 'SET_KEY_SOURCES' });
    }
  }, []);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const handleSave = useCallback(async () => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      return;
    }
    const saveKey = window.secrets?.saveKey;
    dispatch({ busy: true, type: 'SET_BUSY' });
    if (!saveKey) {
      dispatch({ busy: false, type: 'SET_BUSY' });
      return;
    }
    let saveResult: unknown;
    try {
      saveResult = await saveKey(provider, trimmedKey);
    } catch {
      // Errors are handled by the OS keychain, ignore
      dispatch({ busy: false, type: 'SET_BUSY' });
      return;
    }
    if (saveResult !== null && saveResult !== undefined && typeof saveResult === 'object') {
      const resultObj = saveResult as { ok?: boolean; error?: string };
      if (resultObj.ok === false) {
        const code = resultObj.error;
        toast({
          description:
            code === 'encryption_unavailable'
              ? 'OS keychain encryption is unavailable on this system.'
              : 'Unknown error occurred while saving the key.',
          title: 'Failed to save key',
          variant: 'destructive',
        });
      }
    }
    dispatch({ type: 'SAVE_SUCCESS' });
    await refreshProviders();
    notifySecretsChanged();
  }, [apiKey, provider, refreshProviders, toast, notifySecretsChanged]);

  const handleDelete = useCallback(async () => {
    const deleteKey = window.secrets?.deleteKey;
    dispatch({ busy: true, type: 'SET_BUSY' });
    if (deleteKey) {
      try {
        await deleteKey(provider);
      } catch {
        // Errors are handled at OS level, ignore
      }
    }
    await refreshProviders();
    notifySecretsChanged();
    dispatch({ busy: false, type: 'SET_BUSY' });
  }, [provider, refreshProviders, notifySecretsChanged]);

  const handleSaveTavily = useCallback(async () => {
    const trimmedKey = tavilyKey.trim();
    if (!trimmedKey) {
      return;
    }
    const saveKey = window.secrets?.saveKey;
    dispatch({ busy: true, type: 'SET_BUSY' });
    if (!saveKey) {
      dispatch({ busy: false, type: 'SET_BUSY' });
      return;
    }
    let saveResult: unknown;
    try {
      saveResult = await saveKey(TAVILY_SECRET_PROVIDER, trimmedKey);
    } catch {
      dispatch({ busy: false, type: 'SET_BUSY' });
      return;
    }
    if (saveResult !== null && saveResult !== undefined && typeof saveResult === 'object') {
      const resultObj = saveResult as { ok?: boolean; error?: string };
      if (resultObj.ok === false) {
        toast({
          description:
            resultObj.error === 'encryption_unavailable'
              ? 'OS keychain encryption is unavailable on this system.'
              : 'Unknown error occurred while saving the key.',
          title: 'Failed to save key',
          variant: 'destructive',
        });
      }
    }
    dispatch({ type: 'SAVE_TAVILY_SUCCESS' });
    await refreshProviders();
    notifySecretsChanged();
  }, [tavilyKey, refreshProviders, toast, notifySecretsChanged]);

  const handleDeleteTavily = useCallback(async () => {
    const deleteKey = window.secrets?.deleteKey;
    dispatch({ busy: true, type: 'SET_BUSY' });
    if (deleteKey) {
      try {
        await deleteKey(TAVILY_SECRET_PROVIDER);
      } catch {
        // Errors are handled at OS level, ignore
      }
    }
    await refreshProviders();
    notifySecretsChanged();
    dispatch({ busy: false, type: 'SET_BUSY' });
  }, [refreshProviders, notifySecretsChanged]);

  const providerId = useId();
  const apiKeyId = useId();
  const tavilyKeyId = useId();

  return (
    <div className="space-y-4">
      {envFileErrors.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Environment file rejected</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="space-y-1" data-testid="env-file-errors">
              <p className="text-destructive text-xs">
                None of the variables in these files were applied. Fix the file and restart
                BrainStrike.
              </p>
              {envFileErrors.map((failure) => (
                <div className="text-destructive text-xs" key={failure.filePath}>
                  <span className="font-mono">{failure.filePath}</span>
                  {failure.line === null ? '' : ` (line ${failure.line})`}: {failure.message}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Provider API Keys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor={providerId}>Provider</Label>
              <Select
                onValueChange={(value) => dispatch({ provider: value, type: 'SET_PROVIDER' })}
                value={provider}
              >
                <SelectTrigger data-testid="llm-provider" id={providerId}>
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {providerOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={apiKeyId}>API Key</Label>
              <Input
                data-testid="llm-api-key"
                id={apiKeyId}
                onChange={(event) =>
                  dispatch({ key: event.currentTarget.value, type: 'SET_API_KEY' })
                }
                placeholder={`Enter ${selectedProviderName} API key`}
                type="password"
                value={apiKey}
              />
              {providerKeyHint ? (
                <p className="text-muted-foreground text-xs" data-testid="provider-key-hint">
                  {providerKeyHint}
                </p>
              ) : null}
            </div>
          </div>

          {selectedProviderEnvVar ? (
            <p
              className="text-amber-600 text-xs dark:text-amber-500"
              data-testid="provider-env-inert-warning"
            >
              {selectedProviderName} reads its key from the environment variable{' '}
              <span className="font-mono">{selectedProviderEnvVar}</span>, which always wins. A key
              saved here stays in the keychain but will NOT be used until that variable is unset.
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button
              data-testid="save-llm-key"
              disabled={busy || !apiKey.trim()}
              onClick={handleSave}
            >
              Save
            </Button>
            <Button
              data-testid="delete-llm-key"
              disabled={busy}
              onClick={handleDelete}
              variant="secondary"
            >
              Delete
            </Button>
          </div>

          <div className="space-y-1">
            <Label>Configured Providers</Label>
            <div
              className="space-y-1 text-muted-foreground text-xs"
              data-testid="saved-llm-providers"
            >
              {llmKeySources.length === 0
                ? 'None'
                : llmKeySources.map((entry) => (
                    <div
                      className="flex flex-wrap gap-x-2"
                      data-testid={`provider-key-status-${entry.provider}`}
                      key={entry.provider}
                    >
                      <span>{entry.provider}</span>
                      <span>
                        {entry.source === 'env'
                          ? `Environment key (${entry.envVar})`
                          : 'Saved in keychain'}
                      </span>
                    </div>
                  ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Web Search (Tavily)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-xs">
            The assistant's web search tool sends your query to Tavily, an external service. Add a
            Tavily API key to enable it. Without a key, web search reports that it is unavailable.
          </p>
          <div className="space-y-1">
            <Label htmlFor={tavilyKeyId}>Tavily API Key</Label>
            <Input
              data-testid="tavily-api-key"
              id={tavilyKeyId}
              onChange={(event) =>
                dispatch({ key: event.currentTarget.value, type: 'SET_TAVILY_KEY' })
              }
              placeholder="Enter Tavily API key"
              type="password"
              value={tavilyKey}
            />
          </div>

          {tavilySource?.source === 'env' ? (
            <p
              className="text-amber-600 text-xs dark:text-amber-500"
              data-testid="tavily-env-inert-warning"
            >
              Tavily reads its key from the environment variable{' '}
              <span className="font-mono">{tavilySource.envVar}</span>, which always wins. A key
              saved here stays in the keychain but will NOT be used until that variable is unset.
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button
              data-testid="save-tavily-key"
              disabled={busy || !tavilyKey.trim()}
              onClick={handleSaveTavily}
            >
              Save
            </Button>
            <Button
              data-testid="delete-tavily-key"
              disabled={busy}
              onClick={handleDeleteTavily}
              variant="secondary"
            >
              Delete
            </Button>
          </div>

          <div className="space-y-1">
            <Label>Status</Label>
            <div className="text-muted-foreground text-xs" data-testid="tavily-key-status">
              {tavilySource === undefined
                ? 'Not configured'
                : tavilySource.source === 'env'
                  ? `Environment key (${tavilySource.envVar})`
                  : 'Configured'}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default ApiKeysSettings;
