import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@brainstrike/ui';
import { useId } from 'react';
import { KeySourceBadge } from './key-source-badge';
import type { CredentialSourceState, SettingsProviderKeyId } from './provider-key-types';

interface TavilyKeyCardProps {
  readonly busy: boolean;
  /** Present when an environment variable is authoritative for Tavily. */
  readonly environmentSource: ProviderKeySource<SettingsProviderKeyId> | undefined;
  /** True only when a keychain entry exists to remove. */
  readonly hasStoredKey: boolean;
  readonly keySource: ProviderKeySource<SettingsProviderKeyId> | undefined;
  readonly onDelete: () => void;
  readonly onKeyChange: (value: string) => void;
  readonly onSave: () => void;
  readonly sourceState: CredentialSourceState;
  readonly tavilyKey: string;
}

export function TavilyKeyCard({
  busy,
  environmentSource,
  hasStoredKey,
  keySource,
  onDelete,
  onKeyChange,
  onSave,
  sourceState,
  tavilyKey,
}: TavilyKeyCardProps) {
  const tavilyKeyId = useId();

  return (
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
            onChange={(event) => onKeyChange(event.currentTarget.value)}
            placeholder="Enter Tavily API key"
            type="password"
            value={tavilyKey}
          />
          {environmentSource ? (
            <p className="text-amber-700 text-xs" data-testid="tavily-env-key-warning">
              {environmentSource.envVar} is authoritative for Tavily. Saving a key here will not
              change web retrieval until that environment variable is removed and the app is
              restarted.
            </p>
          ) : null}
        </div>

        <div className="flex gap-2">
          <Button
            data-testid="save-tavily-key"
            disabled={
              busy || sourceState !== 'ready' || !tavilyKey.trim() || Boolean(environmentSource)
            }
            onClick={onSave}
          >
            Save
          </Button>
          <Button
            data-testid="delete-tavily-key"
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
          <KeySourceBadge source={keySource} sourceState={sourceState} testId="tavily-key-status" />
        </div>
      </CardContent>
    </Card>
  );
}
