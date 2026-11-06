import { Predicate } from 'effect';

/**
 * True when THIS message carries assistant-ui's own error state — the exact
 * check `ErrorPrimitive.Message` / the library's internal `useMessageError`
 * perform (`status.type === 'incomplete' && status.reason === 'error'`).
 * Read directly via `useAuiState` (same `state.message.status` selector
 * pattern already used by `ActivityGroup` in assistant-activity-parts.tsx)
 * since `useMessageError` itself is not re-exported from `@assistant-ui/react`'s
 * public surface.
 */
export function selectHasErrorState(state: { message: unknown }): boolean {
  const status = Predicate.isObject(state.message)
    ? (state.message as { status?: { reason?: string; type?: string } }).status
    : undefined;
  return status?.type === 'incomplete' && status?.reason === 'error';
}
