/** UI-only recovery status; never a native tool decision or a persisted run. */
export const SUSPENDED_RUN_DISCOVERY_ERROR_DATA_NAME = 'suspended-run-discovery-error';

export interface SuspendedRunDiscoveryError {
  readonly reason: 'invalid-response' | 'request-failed' | 'timed-out';
}

export function isSuspendedRunDiscoveryError(value: unknown): value is SuspendedRunDiscoveryError {
  if (!value || typeof value !== 'object' || !('reason' in value)) {
    return false;
  }
  return (
    value.reason === 'invalid-response' ||
    value.reason === 'request-failed' ||
    value.reason === 'timed-out'
  );
}
