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
  // BST-1353: for an aws-authType provider the WINNING auth mode is named
  // here. With a stored bearer key AND an AWS_PROFILE environment both
  // present, the precedence table picks the bearer — and the user can only
  // see which one the next request will sign with if the badge says so.
  const modeSuffix = source.authMode === 'profile_chain' ? ' · AWS profile chain' : '';
  if (source.source === 'env') {
    return (
      <Badge data-testid={testId} variant="secondary">
        Env ({source.envVar}){modeSuffix}
      </Badge>
    );
  }
  return (
    <Badge data-testid={testId} variant="secondary">
      Stored{modeSuffix}
    </Badge>
  );
}
