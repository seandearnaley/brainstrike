import { listProviders, type ProviderDefinition } from '@brainstrike/agent/client';
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
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useSecretsStore } from '../../stores/secrets-store';

interface ProviderOption {
  id: string;
  name: string;
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
        name: definition.id === 'google' ? 'Google AI Studio' : definition.displayName,
      })),
    [providerDefinitions]
  );

  const [rawProvider, setRawProvider] = useState<string>(providerOptions[0]?.id ?? 'openai');
  const [apiKey, setApiKey] = useState('');
  const [providersWithSecrets, setProvidersWithSecrets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

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
    try {
      const storedProviders = await window.secrets?.listStored?.();
      if (Array.isArray(storedProviders)) {
        setProvidersWithSecrets(storedProviders);
        return;
      }

      const list = await window.secrets?.list?.();
      if (Array.isArray(list)) {
        setProvidersWithSecrets(list);
      }
    } catch {
      // ignored
    }
  }, []);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) {
      return;
    }
    setBusy(true);
    try {
      const res = await window.secrets?.saveKey?.(provider, apiKey.trim());
      if (res && typeof res === 'object' && 'ok' in res) {
        const result = res as { ok: false; error: 'encryption_unavailable' | 'unknown_error' };
        if (result.ok === false) {
          const code = result.error;
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
      setApiKey('');
      await refreshProviders();
      notifySecretsChanged();
    } finally {
      setBusy(false);
    }
  }, [apiKey, provider, refreshProviders, toast, notifySecretsChanged]);

  const handleDelete = useCallback(async () => {
    setBusy(true);
    try {
      await window.secrets?.deleteKey?.(provider);
      await refreshProviders();
      notifySecretsChanged();
    } finally {
      setBusy(false);
    }
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
              <Select onValueChange={(value) => setRawProvider(value)} value={provider}>
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
                onChange={(event) => setApiKey(event.currentTarget.value)}
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
