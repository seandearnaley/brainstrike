import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CopyTextButton,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import { useId } from 'react';
import { KeySourceBadge } from './key-source-badge';
import type {
  CredentialSourceState,
  ProviderOption,
  SettingsProviderKeyId,
} from './provider-key-types';

interface ProviderKeysCardProps {
  readonly apiKey: string;
  readonly busy: boolean;
  /** Registry docsUrl ("get an API key" page) for the selected provider. */
  readonly docsUrl: string | null;
  /** Present when an environment variable is authoritative for this provider. */
  readonly environmentSource: ProviderKeySource<SettingsProviderKeyId> | undefined;
  /** True only when a keychain entry exists to remove. */
  readonly hasStoredKey: boolean;
  readonly keyHint: string | null;
  readonly keySource: ProviderKeySource<SettingsProviderKeyId> | undefined;
  readonly onApiKeyChange: (value: string) => void;
  readonly onDelete: () => void;
  readonly onProviderChange: (provider: string) => void;
  readonly onSave: () => void;
  readonly provider: string;
  readonly providerOptions: readonly ProviderOption[];
  readonly selectedProviderName: string;
  readonly sourceState: CredentialSourceState;
}

export function ProviderKeysCard({
  apiKey,
  busy,
  docsUrl,
  environmentSource,
  hasStoredKey,
  keyHint,
  keySource,
  onApiKeyChange,
  onDelete,
  onProviderChange,
  onSave,
  provider,
  providerOptions,
  selectedProviderName,
  sourceState,
}: ProviderKeysCardProps) {
  const providerId = useId();
  const apiKeyId = useId();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Provider API Keys</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor={providerId}>Provider</Label>
            <Select onValueChange={onProviderChange} value={provider}>
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
              onChange={(event) => onApiKeyChange(event.currentTarget.value)}
              placeholder={`Enter ${selectedProviderName} API key`}
              type="password"
              value={apiKey}
            />
            {keyHint ? (
              <p className="text-muted-foreground text-xs" data-testid="provider-key-hint">
                {keyHint}
              </p>
            ) : null}
            {docsUrl ? (
              // An openExternal affordance DOES exist (app-shell's
              // platform-bridge), but settings-ui has no capability injection
              // for it yet — the real link arrives with the Provider Hub
              // capability injection (BST-1362/BST-1358, PR #2513 review).
              // Until then the URL renders as selectable text with a copy
              // button rather than a dead anchor.
              <div className="flex items-center gap-1">
                <p
                  className="select-all break-all text-muted-foreground text-xs"
                  data-testid="provider-docs-url"
                >
                  Get an API key: {docsUrl}
                </p>
                <CopyTextButton
                  ariaLabel={`Copy the ${selectedProviderName} API key page URL`}
                  text={docsUrl}
                />
              </div>
            ) : null}
            {environmentSource ? (
              <p className="text-amber-700 text-xs" data-testid="provider-env-key-warning">
                {environmentSource.envVar} is authoritative for this provider. Saving a key here
                will not change the runtime until that environment variable is removed and the app
                is restarted.
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            data-testid="save-llm-key"
            disabled={
              busy || sourceState !== 'ready' || !apiKey.trim() || Boolean(environmentSource)
            }
            onClick={onSave}
          >
            Save
          </Button>
          <Button
            data-testid="delete-llm-key"
            disabled={
              busy || sourceState !== 'ready' || Boolean(environmentSource) || !hasStoredKey
            }
            onClick={onDelete}
            variant="secondary"
          >
            Delete
          </Button>
        </div>

        <div className="space-y-1">
          <Label>Status</Label>
          <KeySourceBadge
            source={keySource}
            sourceState={sourceState}
            testId="provider-key-status"
          />
        </div>
      </CardContent>
    </Card>
  );
}
