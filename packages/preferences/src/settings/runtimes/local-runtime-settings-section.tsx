import type {
  LocalRuntimeAvailabilityState,
  LocalRuntimeId,
} from '@brainstrike/agent/local-runtime';
import type { SupportedProvider } from '@brainstrike/agent/provider-metadata';
import { Badge, Button, Card, Input, Label } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { Loader2, RefreshCw } from 'lucide-react';
import type { FC, ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AssistantProviderSettings,
  LocalRuntimeActivation,
} from '../../stores/assistant-preferences-store';
import { useAssistantPreferencesStore } from '../../stores/assistant-preferences-store';

const logger = createLogger('LocalRuntimeSettings');

interface RuntimeCardMeta {
  readonly defaultBaseUrl: string;
  readonly docsUrl: string;
  readonly providerId: Extract<SupportedProvider, 'ollama' | 'lmstudio'>;
  readonly runtimeId: LocalRuntimeId;
  readonly subtitle: string;
  readonly title: string;
}

// The one place we encode "what's a local runtime" for this UI. Adding a new
// OpenAI-compatible local server means: register it in the registry (as a
// SupportedProvider), expose adapter paths in the catalog, and append an entry
// here. No other file changes should be needed for the settings toggle.
const RUNTIME_CARDS: readonly RuntimeCardMeta[] = [
  {
    runtimeId: 'ollama',
    providerId: 'ollama',
    title: 'Ollama',
    subtitle: 'Run open-weight models locally via the Ollama daemon.',
    defaultBaseUrl: 'http://127.0.0.1:11434',
    docsUrl: 'https://docs.ollama.com',
  },
  {
    runtimeId: 'lmstudio',
    providerId: 'lmstudio',
    title: 'LM Studio',
    subtitle: 'Run GGUF / MLX models via the LM Studio developer server.',
    defaultBaseUrl: 'http://127.0.0.1:1234',
    docsUrl: 'https://lmstudio.ai/docs/developer/core/server',
  },
];

interface SecretsBridge {
  deleteKey?: (provider: string) => Promise<boolean>;
  getKey?: (provider: string) => Promise<string | null>;
  saveKey?: (provider: string, value: string) => Promise<true | { ok: false; error: string }>;
}

function readSecretsBridge(): SecretsBridge | undefined {
  if (typeof window === 'undefined') {
    return;
  }
  return (window as Window & { secrets?: SecretsBridge }).secrets;
}

interface StatusDescriptor {
  readonly detail?: string;
  readonly label: string;
  readonly tone: 'success' | 'warning' | 'danger' | 'muted' | 'info';
}

function describeStatus(
  activation: LocalRuntimeActivation,
  status: LocalRuntimeAvailabilityState | undefined
): StatusDescriptor {
  if (activation === 'off') {
    return { tone: 'muted', label: 'Disabled' };
  }
  if (!status) {
    return { tone: 'info', label: 'Not checked yet' };
  }
  switch (status.state) {
    case 'available':
      return { tone: 'success', label: 'Available', detail: status.endpoint };
    case 'stale':
      return {
        tone: 'warning',
        label: 'Stale',
        detail: `Last reachable at ${status.endpoint}`,
      };
    case 'checking':
      return { tone: 'info', label: 'Probing…' };
    case 'auth_required':
      return {
        tone: 'warning',
        label: 'Auth required',
        detail: `${status.status} at ${status.endpoint}`,
      };
    case 'blocked_web':
      return { tone: 'warning', label: 'Blocked by browser', detail: status.message };
    case 'incompatible':
      return { tone: 'danger', label: 'Incompatible', detail: status.message };
    case 'unavailable':
      return {
        tone: 'muted',
        label: activation === 'on' ? 'Force-enabled (not reachable)' : 'Unavailable',
        ...(status.message ? { detail: status.message } : {}),
      };
    default:
      return { tone: 'muted', label: 'Unknown' };
  }
}

function toneToVariant(
  tone: StatusDescriptor['tone']
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (tone) {
    case 'success':
      return 'default';
    case 'danger':
      return 'destructive';
    case 'warning':
    case 'info':
      return 'secondary';
    default:
      return 'outline';
  }
}

const ACTIVATION_OPTIONS: ReadonlyArray<{
  description: string;
  label: string;
  value: LocalRuntimeActivation;
}> = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'Available when detection succeeds on the configured host.',
  },
  {
    value: 'on',
    label: 'On',
    description: 'Always offer the provider, even if detection fails.',
  },
  {
    value: 'off',
    label: 'Off',
    description: 'Hide the provider and skip probing.',
  },
];

export function LocalRuntimeSettingsSection(): ReactElement {
  return (
    <div className="space-y-4">
      {RUNTIME_CARDS.map((card) => (
        <LocalRuntimeCard card={card} key={card.runtimeId} />
      ))}
    </div>
  );
}

interface LocalRuntimeCardProps {
  readonly card: RuntimeCardMeta;
}

const LocalRuntimeCard: FC<LocalRuntimeCardProps> = ({ card }) => {
  const settings = useAssistantPreferencesStore((state) => state.providerSettings[card.providerId]);
  const setProviderSettings = useAssistantPreferencesStore((state) => state.setProviderSettings);
  const getLocalRuntimeStatuses = useAssistantPreferencesStore(
    (state) => state.getLocalRuntimeStatuses
  );

  const activation: LocalRuntimeActivation = settings?.localRuntimeEnabled ?? 'auto';
  const [draftBaseUrl, setDraftBaseUrl] = useState(() => settings?.localRuntimeBaseUrl ?? '');
  const [draftToken, setDraftToken] = useState('');
  const [storedTokenPresent, setStoredTokenPresent] = useState(false);
  const [status, setStatus] = useState<LocalRuntimeAvailabilityState | undefined>();
  const [probing, setProbing] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);

  // Initial secret-hydration: reveal whether a token is already on file so the
  // UI can display "Configured" without ever showing the plaintext value.
  useEffect(() => {
    let cancelled = false;
    const bridge = readSecretsBridge();
    if (!bridge?.getKey) {
      setStoredTokenPresent(false);
      return;
    }
    void bridge
      .getKey(card.providerId)
      .then((value) => {
        if (!cancelled) {
          setStoredTokenPresent(typeof value === 'string' && value.trim().length > 0);
        }
      })
      .catch((error) => {
        logger.debug('Failed to read stored token', { providerId: card.providerId, error });
      });
    return () => {
      cancelled = true;
    };
  }, [card.providerId]);

  useEffect(() => {
    setDraftBaseUrl(settings?.localRuntimeBaseUrl ?? '');
  }, [settings?.localRuntimeBaseUrl]);

  const runProbe = useCallback(
    async (options?: { force?: boolean }) => {
      setProbing(true);
      try {
        const statuses = await getLocalRuntimeStatuses({ force: options?.force ?? false });
        setStatus(statuses[card.runtimeId]);
      } catch (error) {
        logger.error('Local runtime probe failed', { runtimeId: card.runtimeId, error });
      } finally {
        setProbing(false);
      }
    },
    [card.runtimeId, getLocalRuntimeStatuses]
  );

  useEffect(() => {
    if (activation === 'off') {
      return;
    }
    void runProbe();
  }, [activation, runProbe]);

  const handleActivationChange = useCallback(
    (next: LocalRuntimeActivation) => {
      setProviderSettings(card.providerId, { localRuntimeEnabled: next });
    },
    [card.providerId, setProviderSettings]
  );

  const commitBaseUrl = useCallback(() => {
    const normalized = draftBaseUrl.trim();
    const next = normalized.length > 0 ? normalized : undefined;
    setProviderSettings(card.providerId, { localRuntimeBaseUrl: next });
    void runProbe({ force: true });
  }, [card.providerId, draftBaseUrl, runProbe, setProviderSettings]);

  const saveToken = useCallback(async () => {
    const bridge = readSecretsBridge();
    if (!bridge?.saveKey) {
      return;
    }
    const value = draftToken.trim();
    if (value.length === 0) {
      return;
    }
    setTokenBusy(true);
    try {
      const result = await bridge.saveKey(card.providerId, value);
      if (result === true) {
        setStoredTokenPresent(true);
        setDraftToken('');
      } else {
        logger.error('Failed to save local runtime token', {
          providerId: card.providerId,
          error: result.error,
        });
      }
    } finally {
      setTokenBusy(false);
    }
  }, [card.providerId, draftToken]);

  const clearToken = useCallback(async () => {
    const bridge = readSecretsBridge();
    if (!bridge?.deleteKey) {
      return;
    }
    setTokenBusy(true);
    try {
      await bridge.deleteKey(card.providerId);
      setStoredTokenPresent(false);
    } finally {
      setTokenBusy(false);
    }
  }, [card.providerId]);

  const secretsBridgeAvailable = useMemo(
    () => Boolean(readSecretsBridge()?.saveKey),
    // The bridge is attached synchronously at preload time and does not mutate
    // after load, so a one-shot memo is sufficient.
    []
  );

  const descriptor = describeStatus(activation, status);
  const badgeVariant = toneToVariant(descriptor.tone);
  const isBaseUrlDirty = (settings?.localRuntimeBaseUrl ?? '') !== draftBaseUrl.trim();

  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-base">{card.title}</h3>
            <Badge variant={badgeVariant}>{descriptor.label}</Badge>
          </div>
          <p className="text-muted-foreground text-sm">{card.subtitle}</p>
          {descriptor.detail ? (
            <p className="mt-1 text-muted-foreground text-xs">{descriptor.detail}</p>
          ) : null}
        </div>
        <Button
          data-testid={`local-runtime-probe-${card.runtimeId}`}
          disabled={probing || activation === 'off'}
          onClick={() => {
            void runProbe({ force: true });
          }}
          size="sm"
          variant="outline"
        >
          {probing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          <span className="ml-2">Probe now</span>
        </Button>
      </div>

      <fieldset className="space-y-2">
        <legend className="font-medium text-sm">Availability</legend>
        <div
          className="flex flex-wrap gap-2"
          data-testid={`local-runtime-activation-${card.runtimeId}`}
          role="radiogroup"
        >
          {ACTIVATION_OPTIONS.map((option) => (
            <label
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                activation === option.value
                  ? 'border-primary bg-primary/5'
                  : 'border-input hover:bg-accent'
              }`}
              key={option.value}
            >
              <input
                checked={activation === option.value}
                className="accent-primary"
                name={`local-runtime-activation-${card.runtimeId}`}
                onChange={() => handleActivationChange(option.value)}
                type="radio"
                value={option.value}
              />
              <div>
                <div className="font-medium">{option.label}</div>
                <div className="text-muted-foreground text-xs">{option.description}</div>
              </div>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor={`local-runtime-url-${card.runtimeId}`}>Endpoint URL</Label>
        <div className="flex gap-2">
          <Input
            data-testid={`local-runtime-url-input-${card.runtimeId}`}
            id={`local-runtime-url-${card.runtimeId}`}
            onChange={(event) => setDraftBaseUrl(event.target.value)}
            placeholder={card.defaultBaseUrl}
            spellCheck={false}
            value={draftBaseUrl}
          />
          <Button
            data-testid={`local-runtime-url-save-${card.runtimeId}`}
            disabled={!isBaseUrlDirty}
            onClick={commitBaseUrl}
            size="sm"
            variant="secondary"
          >
            Save
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Leave blank to use the runtime default ({card.defaultBaseUrl}). Non-localhost URLs are
          supported but only reachable when the network allows it.
        </p>
      </div>

      {secretsBridgeAvailable ? (
        <div className="space-y-2">
          <Label htmlFor={`local-runtime-token-${card.runtimeId}`}>API token (optional)</Label>
          <div className="flex gap-2">
            <Input
              autoComplete="off"
              data-testid={`local-runtime-token-input-${card.runtimeId}`}
              id={`local-runtime-token-${card.runtimeId}`}
              onChange={(event) => setDraftToken(event.target.value)}
              placeholder={storedTokenPresent ? '••••• (stored)' : 'Paste bearer token'}
              type="password"
              value={draftToken}
            />
            <Button
              data-testid={`local-runtime-token-save-${card.runtimeId}`}
              disabled={draftToken.trim().length === 0 || tokenBusy}
              onClick={() => {
                void saveToken();
              }}
              size="sm"
              variant="secondary"
            >
              Save
            </Button>
            {storedTokenPresent ? (
              <Button
                data-testid={`local-runtime-token-clear-${card.runtimeId}`}
                disabled={tokenBusy}
                onClick={() => {
                  void clearToken();
                }}
                size="sm"
                variant="ghost"
              >
                Clear
              </Button>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs">
            Stored encrypted via the desktop secrets bridge. Used for Ollama Turbo and LM Studio
            servers that opt into bearer-token auth.
          </p>
        </div>
      ) : null}
    </Card>
  );
};

export type { AssistantProviderSettings };
