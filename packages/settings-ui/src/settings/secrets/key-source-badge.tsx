import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import { Badge } from '@brainstrike/ui';
import type { CredentialSourceState } from './provider-key-types';

interface KeySourceBadgeProps {
  readonly source: ProviderKeySource<string> | undefined;
  readonly sourceState: CredentialSourceState;
  readonly testId: string;
}

/**
 * Names the store the runtime will actually read for one credential. An
 * unknown source is reported as unknown — never as "Not set", which would
 * claim a fact the failed listing cannot support.
 */
export function KeySourceBadge({ source, sourceState, testId }: KeySourceBadgeProps) {
  if (!source) {
    if (sourceState === 'loading') {
      return (
        <Badge data-testid={testId} variant="outline">
          Checking credential source
        </Badge>
      );
    }
    if (sourceState === 'error') {
      return (
        <Badge data-testid={testId} variant="outline">
          Credential status unavailable
        </Badge>
      );
    }
    return (
      <Badge className="text-muted-foreground" data-testid={testId} variant="outline">
        Not set
      </Badge>
    );
  }
  if (source.source === 'env') {
    return (
      <Badge data-testid={testId} variant="secondary">
        Env ({source.envVar})
      </Badge>
    );
  }
  return (
    <Badge data-testid={testId} variant="secondary">
      Stored
    </Badge>
  );
}
