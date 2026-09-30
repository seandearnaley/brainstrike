/** Runtime-free diagnostics: tool code must not import sandbox-runtime to render them. */
export type FenceReadinessReason =
  | 'sandbox_dependencies_missing'
  | 'sandbox_namespace_blocked'
  | 'sandbox_unsupported_runtime'
  | 'sandbox_readiness_timeout'
  | 'sandbox_readiness_failed';

export class FenceReadinessError extends Error {
  readonly code: 'fence_readiness_unavailable' | 'fence_unsupported_platform' =
    'fence_readiness_unavailable';
  readonly reason: FenceReadinessReason;

  constructor(reason: FenceReadinessReason, detail: string, options?: ErrorOptions) {
    super(detail, options);
    this.name = 'FenceReadinessError';
    this.reason = reason;
  }
}

export function isFenceReadinessError(value: unknown): value is FenceReadinessError {
  // The root/tool and fence-executor entrypoints are separate non-splitting
  // bundles: the same source class has two identities in the shipped app.
  if (!(value instanceof Error && 'code' in value && 'reason' in value)) {
    return false;
  }
  return (
    (value.code === 'fence_readiness_unavailable' || value.code === 'fence_unsupported_platform') &&
    (value.reason === 'sandbox_dependencies_missing' ||
      value.reason === 'sandbox_namespace_blocked' ||
      value.reason === 'sandbox_unsupported_runtime' ||
      value.reason === 'sandbox_readiness_timeout' ||
      value.reason === 'sandbox_readiness_failed')
  );
}
