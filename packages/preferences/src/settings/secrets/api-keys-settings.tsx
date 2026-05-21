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

interface ApiKeysState {
  apiKey: string;
  busy: boolean;
  providersWithSecrets: string[];
  rawProvider: string;
}

type ApiKeysAction =
  | { type: 'SET_PROVIDER'; provider: string }
  | { type: 'SET_API_KEY'; key: string }
  | { type: 'SET_PROVIDERS_WITH_SECRETS'; providers: string[] }
  | { type: 'SET_BUSY'; busy: boolean }
  | { type: 'SAVE_SUCCESS' };

function apiKeysReducer(state: ApiKeysState, action: ApiKeysAction): ApiKeysState {
  switch (action.type) {
    case 'SET_PROVIDER':
      return { ...state, rawProvider: action.provider };
    case 'SET_API_KEY':
      return { ...state, apiKey: action.key };
    case 'SET_PROVIDERS_WITH_SECRETS':
      return { ...state, providersWithSecrets: action.providers };
    case 'SET_BUSY':
      return { ...state, busy: action.busy };
    case 'SAVE_SUCCESS':
      return { ...state, apiKey: '', busy: false };
    default:
      return state;
  }
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
    rawProvider: providerOptions[0]?.id ?? 'openai',
    apiKey: '',
    providersWithSecrets: [],
    busy: false,
  });
  const { rawProvider, apiKey, providersWithSecrets, busy } = state;

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

  const refreshProviders = useCallback(async () => {
    const listStored = window.secrets?.listStored;
    const listFn = window.secrets?.list;
    if (listStored) {
      try {
        const storedProviders = await listStored();
        if (Array.isArray(storedProviders)) {
          dispatch({ type: 'SET_PROVIDERS_WITH_SECRETS', providers: storedProviders });
          return;
        }
      } catch {
        // ignored
      }
    }
    if (listFn) {
      try {
        const providers = await listFn();
        if (Array.isArray(providers)) {
          dispatch({ type: 'SET_PROVIDERS_WITH_SECRETS', providers });
        }
      } catch {
        // ignored
      }
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
    dispatch({ type: 'SET_BUSY', busy: true });
    if (!saveKey) {
      dispatch({ type: 'SET_BUSY', busy: false });
      return;
    }
    let saveResult: unknown;
    try {
      saveResult = await saveKey(provider, trimmedKey);
    } catch {
      // Errors are handled by the OS keychain, ignore
      dispatch({ type: 'SET_BUSY', busy: false });
      return;
    }
    if (saveResult !== null && saveResult !== undefined && typeof saveResult === 'object') {
      const resultObj = saveResult as { ok?: boolean; error?: string };
      if (resultObj.ok === false) {
        const code = resultObj.error;
        toast({
          title: 'Failed to save key',
          description:
            code === 'encryption_unavailable'
              ? 'OS keychain encryption is unavailable on this system.'
              : 'Unknown error occurred while saving the key.',
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
    dispatch({ type: 'SET_BUSY', busy: true });
    if (deleteKey) {
      try {
        await deleteKey(provider);
      } catch {
        // Errors are handled at OS level, ignore
      }
    }
    await refreshProviders();
    notifySecretsChanged();
    dispatch({ type: 'SET_BUSY', busy: false });
  }, [provider, refreshProviders, notifySecretsChanged]);

  const providerId = useId();
  const apiKeyId = useId();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Provider API Keys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor={providerId}>Provider</Label>
              <Select
                onValueChange={(value) => dispatch({ type: 'SET_PROVIDER', provider: value })}
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
                  dispatch({ type: 'SET_API_KEY', key: event.currentTarget.value })
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
            <Label>Saved Providers</Label>
            <div className="text-muted-foreground text-xs" data-testid="saved-llm-providers">
              {providersWithSecrets.length === 0 ? 'None' : providersWithSecrets.join(', ')}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default ApiKeysSettings;
