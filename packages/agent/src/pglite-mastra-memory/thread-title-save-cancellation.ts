import type { StorageThreadType } from '@mastra/core/memory';

const THREAD_TITLE_SAVE_ABORT_SIGNAL = Symbol('brainstrike.thread-title-save-abort-signal');

type AbortableThreadTitleSave = StorageThreadType & {
  [THREAD_TITLE_SAVE_ABORT_SIGNAL]?: AbortSignal;
};

/** Carry process-local cancellation through Mastra's public saveThread input. */
export function attachThreadTitleSaveAbortSignal(
  thread: StorageThreadType,
  signal: AbortSignal
): StorageThreadType {
  Object.defineProperty(thread, THREAD_TITLE_SAVE_ABORT_SIGNAL, {
    configurable: true,
    enumerable: false,
    value: signal,
  });
  return thread;
}

/** Throw inside the transactional store boundary when a title save has expired. */
export function throwIfThreadTitleSaveAborted(thread: StorageThreadType): void {
  const signal = (thread as AbortableThreadTitleSave)[THREAD_TITLE_SAVE_ABORT_SIGNAL];
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Mastra thread title persistence deadline expired.');
}
