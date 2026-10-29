interface CredentialLoadErrorProps {
  /** Joined status/listing failures; empty string renders nothing. */
  readonly message: string;
}

/**
 * A failed credential-source read is shown, never swallowed: without it the
 * cards below would silently present stale or unknown state as fact.
 */
export function CredentialLoadError({ message }: CredentialLoadErrorProps) {
  if (!message) {
    return null;
  }
  return (
    <div
      className="border-destructive/50 bg-destructive/5 text-destructive rounded-md border p-3 text-sm"
      data-testid="provider-key-load-error"
      role="alert"
    >
      {message}
    </div>
  );
}
