import { ErrorNotice } from '@brainstrike/ui';

interface CredentialLoadErrorProps {
  /** Joined status/listing failures; empty string renders nothing. */
  readonly message: string;
  /** Re-reads the credential listing, when this surface owns that read. */
  readonly onRetry?: (() => void) | undefined;
}

/**
 * A failed credential-source read is shown, never swallowed: without it the
 * cards below would silently present stale or unknown state as fact.
 */
export function CredentialLoadError({ message, onRetry }: CredentialLoadErrorProps) {
  if (!message) {
    return null;
  }
  return <ErrorNotice data-testid="provider-key-load-error" message={message} onRetry={onRetry} />;
}
