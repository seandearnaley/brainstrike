import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import { Badge } from '@brainstrike/ui';
import type { CredentialSourceState, SettingsProviderKeyId } from './provider-key-types';

interface KeySourceBadgeProps {
  readonly source: ProviderKeySource<SettingsProviderKeyId> | undefined;
  readonly sourceState: CredentialSourceState;
  readonly testId: string;
}

/**
 * Names the store the runtime will actually read for one credential. An
 * unknown source is reported as unknown — never as "Not configured", which
 * would claim a fact the failed listing cannot support.
 */
export function KeySourceBadge({ source, sourceState, testId }: KeySourceBadgeProps) {
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
