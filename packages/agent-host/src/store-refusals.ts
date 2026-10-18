import {
  BoundaryFailureError,
  refusal,
  STATE_STORE_READ_ONLY_CODE,
} from '@brainstrike/assistant-contract';
import { StateStoreReadOnlyError, ThreadReadOnlyError } from '@brainstrike/state-store';

/**
 * BST-2144: a damaged state DB opens read-only and keeps every file
 * (BST-1880 shows why). A write it refuses is the store's declared posture, not
 * a failure: it crosses as a refusal its caller can recognise, never as the
 * internal fault "Something went wrong".
 */
export const STATE_STORE_READ_ONLY = refusal({
  category: 'availability',
  code: STATE_STORE_READ_ONLY_CODE,
  message:
    'BrainStrike’s conversation store is damaged, so it opened read-only and this change was not saved.',
  remedy:
    'Your conversations can still be read. The notice at the top of the window has the details.',
});

/** One thread's history is damaged, so it refuses appends while the store stays writable. */
export const THREAD_READ_ONLY = refusal({
  category: 'availability',
  code: 'thread.read-only',
  message: 'This conversation is damaged, so it is read-only and this change was not saved.',
});

/**
 * The state store's read-only refusals as typed refusals; any other cause
 * unchanged. A thread refusing because the whole store opened damaged is the
 * store's refusal, so it says so rather than blaming one conversation.
 */
export function storeRefusal(cause: unknown): unknown {
  if (
    cause instanceof StateStoreReadOnlyError ||
    (cause instanceof ThreadReadOnlyError && cause.storeDamage !== null)
  ) {
    return new BoundaryFailureError(STATE_STORE_READ_ONLY, { cause });
  }
  if (cause instanceof ThreadReadOnlyError) {
    return new BoundaryFailureError(THREAD_READ_ONLY, { cause });
  }
  return cause;
}
