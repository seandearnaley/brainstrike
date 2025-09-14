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

const PROVIDERS = [
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'groq', name: 'Groq' },
];

export function LlmKeysSettings() {
  const { toast } = useToast();
  const [provider, setProvider] = useState<string>(PROVIDERS[0]?.id ?? 'openai');
  const [apiKey, setApiKey] = useState('');
  const [providers, setProviders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const selectedName = useMemo(
    () => PROVIDERS.find((p) => p.id === provider)?.name ?? provider,
    [provider]
  );

  const refresh = useCallback(async () => {
    try {
      const list = await window.secrets?.list?.();
      if (Array.isArray(list)) setProviders(list);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return;
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
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [apiKey, provider, refresh, toast]);

  const handleDelete = useCallback(async () => {
    setBusy(true);
    try {
      await window.secrets?.deleteKey?.(provider);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [provider, refresh]);

  const providerId = useId();
  const apiKeyId = useId();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">LLM Provider Keys</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <div className="space-y-1">
            <Label htmlFor={providerId}>Provider</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v)}>
              <SelectTrigger id={providerId} data-testid="llm-provider">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor={apiKeyId}>API Key</Label>
            <Input
              id={apiKeyId}
              data-testid="llm-api-key"
              type="password"
              placeholder={`Enter ${selectedName} API key`}
              value={apiKey}
              onChange={(e) => setApiKey(e.currentTarget.value)}
            />
          </div>
        </div>

        <div className="flex gap-2">
          <Button data-testid="save-llm-key" disabled={busy || !apiKey.trim()} onClick={handleSave}>
            Save
          </Button>
          <Button
            data-testid="delete-llm-key"
            variant="secondary"
            disabled={busy}
            onClick={handleDelete}
          >
            Delete
          </Button>
        </div>

        <div className="space-y-1">
          <Label>Saved Providers</Label>
          <div data-testid="saved-llm-providers" className="text-xs text-muted-foreground">
            {providers.length === 0 ? 'None' : providers.join(', ')}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default LlmKeysSettings;
