import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import {
  listProviders,
  type ProviderDefinition,
  providerEnvKeys,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import {
  Badge,
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
const TAVILY_ENV_KEYS = new Set(['BRAINSTRIKE_TAVILY_API_KEY', 'TAVILY_API_KEY']);
type SettingsProviderKeyId = SupportedProvider | typeof TAVILY_SECRET_PROVIDER;

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

function KeySourceBadge({
  source,
  sourceState,
  testId,
}: {
  source: ProviderKeySource<SettingsProviderKeyId> | undefined;
  sourceState: ApiKeysState['sourceState'];
  testId: string;
}) {
  if (!source) {
    const label =
      sourceState === 'loading'
        ? 'Checking credential source'
        : sourceState === 'error'
          ? 'Credential status unavailable'
          : 'Not configured';
    return (
      <Badge data-testid={testId} variant="outline">
        {label}
      </Badge>
    );
  }
  if (source.source === 'env') {
    return (
      <Badge data-testid={testId} variant="secondary">
        Environment key ({source.envVar})
      </Badge>
    );
  }
  return (
    <Badge data-testid={testId} variant="secondary">
      Saved in keychain
    </Badge>
  );
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
    const listFn = window.secrets?.list;
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

  const handleSave = useCallback(async () => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey || sourceState !== 'ready' || providerEnvironmentSource) {
      return;
    }
    const saveKey = window.secrets?.saveKey;
    dispatch({ busy: true, type: 'SET_BUSY' });
    if (!saveKey) {
      toast({
        description: 'Secure credential storage is unavailable.',
        title: 'Failed to save key',
        variant: 'destructive',
      });
      dispatch({ busy: false, type: 'SET_BUSY' });
      return;
    }
    let saveResult: unknown;
    try {
      saveResult = await saveKey(provider, trimmedKey);
    } catch {
      toast({
        description: 'The credential store rejected the save operation.',
        title: 'Failed to save key',
        variant: 'destructive',
      });
      dispatch({ busy: false, type: 'SET_BUSY' });
      return;
    }
    if (saveResult !== true) {
      const resultObj = saveResult as { ok?: boolean; error?: string };
      const code = resultObj?.error;
      toast({
        description:
          code === 'encryption_unavailable'
            ? 'OS keychain encryption is unavailable on this system.'
            : 'Unknown error occurred while saving the key.',
        title: 'Failed to save key',
        variant: 'destructive',
      });
      dispatch({ busy: false, type: 'SET_BUSY' });
      return;
    }
    dispatch({ type: 'SAVE_SUCCESS' });
    await refreshProviders();
    notifySecretsChanged();
  }, [
    apiKey,
    provider,
    providerEnvironmentSource,
    refreshProviders,
    sourceState,
    toast,
    notifySecretsChanged,
  ]);

  const handleDelete = useCallback(async () => {
    if (sourceState !== 'ready' || providerEnvironmentSource) {
      return;
    }
    const deleteKey = window.secrets?.deleteKey;
    dispatch({ busy: true, type: 'SET_BUSY' });
    if (!deleteKey) {
      toast({
        description: 'Secure credential storage is unavailable.',
        title: 'Failed to delete key',
        variant: 'destructive',
      });
      dispatch({ busy: false, type: 'SET_BUSY' });
      return;
    }
    try {
      const deleted = await deleteKey(provider);
      if (deleted === false) {
        toast({
          description: 'The credential store did not delete the key.',
          title: 'Failed to delete key',
          variant: 'destructive',
        });
        dispatch({ busy: false, type: 'SET_BUSY' });
        return;
      }
    } catch {
      toast({
        description: 'The credential store rejected the delete operation.',
        title: 'Failed to delete key',
        variant: 'destructive',
      });
      dispatch({ busy: false, type: 'SET_BUSY' });
      return;
    }
    await refreshProviders();
    notifySecretsChanged();
    dispatch({ busy: false, type: 'SET_BUSY' });
  }, [
    provider,
    providerEnvironmentSource,
    refreshProviders,
    sourceState,
    notifySecretsChanged,
    toast,
  ]);

  const handleSaveTavily = useCallback(async () => {
    const trimmedKey = tavilyKey.trim();
    if (!trimmedKey || sourceState !== 'ready' || tavilyEnvironmentSource) {
      return;
    }
    const saveKey = window.secrets?.saveKey;
    dispatch({ busy: true, type: 'SET_BUSY' });
    if (!saveKey) {
      toast({
        description: 'Secure credential storage is unavailable.',
        title: 'Failed to save key',
        variant: 'destructive',
      });
      dispatch({ busy: false, type: 'SET_BUSY' });
      return;
    }
    let saveResult: unknown;
    try {
      saveResult = await saveKey(TAVILY_SECRET_PROVIDER, trimmedKey);
    } catch {
      toast({
        description: 'The credential store rejected the save operation.',
        title: 'Failed to save key',
        variant: 'destructive',
      });
      dispatch({ busy: false, type: 'SET_BUSY' });
      return;
    }
    if (saveResult !== true) {
      const resultObj = saveResult as { ok?: boolean; error?: string };
      toast({
        description:
          resultObj?.error === 'encryption_unavailable'
            ? 'OS keychain encryption is unavailable on this system.'
            : 'Unknown error occurred while saving the key.',
        title: 'Failed to save key',
        variant: 'destructive',
      });
      dispatch({ busy: false, type: 'SET_BUSY' });
      return;
    }
    dispatch({ type: 'SAVE_TAVILY_SUCCESS' });
    await refreshProviders();
    notifySecretsChanged();
  }, [
    tavilyKey,
    tavilyEnvironmentSource,
    refreshProviders,
    sourceState,
    toast,
    notifySecretsChanged,
  ]);

  const handleDeleteTavily = useCallback(async () => {
    if (sourceState !== 'ready' || tavilyEnvironmentSource) {
      return;
    }
    const deleteKey = window.secrets?.deleteKey;
    dispatch({ busy: true, type: 'SET_BUSY' });
    if (!deleteKey) {
      toast({
        description: 'Secure credential storage is unavailable.',
        title: 'Failed to delete key',
        variant: 'destructive',
      });
      dispatch({ busy: false, type: 'SET_BUSY' });
      return;
    }
    try {
      const deleted = await deleteKey(TAVILY_SECRET_PROVIDER);
      if (deleted === false) {
        toast({
          description: 'The credential store did not delete the key.',
          title: 'Failed to delete key',
          variant: 'destructive',
        });
        dispatch({ busy: false, type: 'SET_BUSY' });
        return;
      }
    } catch {
      toast({
        description: 'The credential store rejected the delete operation.',
        title: 'Failed to delete key',
        variant: 'destructive',
      });
      dispatch({ busy: false, type: 'SET_BUSY' });
      return;
    }
    await refreshProviders();
    notifySecretsChanged();
    dispatch({ busy: false, type: 'SET_BUSY' });
  }, [refreshProviders, sourceState, tavilyEnvironmentSource, notifySecretsChanged, toast]);

  const providerId = useId();
  const apiKeyId = useId();
  const tavilyKeyId = useId();

  return (
    <div className="space-y-4">
      {visibleErrors ? (
        <div
          className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-destructive text-sm"
          data-testid="provider-key-load-error"
          role="alert"
        >
          {visibleErrors}
        </div>
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
              {providerEnvironmentSource ? (
                <p className="text-amber-700 text-xs" data-testid="provider-env-key-warning">
                  {providerEnvironmentSource.envVar} is authoritative for this provider. Saving a
                  key here will not change the runtime until that environment variable is removed
                  and the app is restarted.
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              data-testid="save-llm-key"
              disabled={
                busy ||
                sourceState !== 'ready' ||
                !apiKey.trim() ||
                Boolean(providerEnvironmentSource)
              }
              onClick={handleSave}
            >
              Save
            </Button>
            <Button
              data-testid="delete-llm-key"
              disabled={busy || sourceState !== 'ready' || Boolean(providerEnvironmentSource)}
              onClick={handleDelete}
              variant="secondary"
            >
              Delete
            </Button>
          </div>

          <div className="space-y-1">
            <Label>Status</Label>
            <KeySourceBadge
              source={providerKeySource}
              sourceState={sourceState}
              testId="provider-key-status"
            />
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
            {tavilyEnvironmentSource ? (
              <p className="text-amber-700 text-xs" data-testid="tavily-env-key-warning">
                {tavilyEnvironmentSource.envVar} is authoritative for Tavily. Saving a key here will
                not change web retrieval until that environment variable is removed and the app is
                restarted.
              </p>
            ) : null}
          </div>

          <div className="flex gap-2">
            <Button
              data-testid="save-tavily-key"
              disabled={
                busy ||
                sourceState !== 'ready' ||
                !tavilyKey.trim() ||
                Boolean(tavilyEnvironmentSource)
              }
              onClick={handleSaveTavily}
            >
              Save
            </Button>
            <Button
              data-testid="delete-tavily-key"
              disabled={busy || sourceState !== 'ready' || Boolean(tavilyEnvironmentSource)}
              onClick={handleDeleteTavily}
              variant="secondary"
            >
              Delete
            </Button>
          </div>

          <div className="space-y-1">
            <Label>Status</Label>
            <KeySourceBadge
              source={tavilyKeySource}
              sourceState={sourceState}
              testId="tavily-key-status"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default ApiKeysSettings;
