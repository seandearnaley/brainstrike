import { createLogger } from '@brainstrike/utils';
import type { VaultDirectoryHandleLike } from './types';

const logger = createLogger('NotesVaultWatcher');

/** Structural FileSystemObserver constructor (Chrome 133+, whatwg/fs draft). */
export type VaultObserverConstructor = new (
  callback: () => void
) => {
  observe(handle: VaultDirectoryHandleLike, options: { recursive: boolean }): Promise<void>;
  disconnect(): void;
};

export interface VaultWatcher {
  disconnect(): void;
}

function ambientObserverConstructor(): VaultObserverConstructor | undefined {
  const ambient: Record<string, unknown> = globalThis;
  const candidate = ambient['FileSystemObserver'];
  return typeof candidate === 'function' ? (candidate as VaultObserverConstructor) : undefined;
}

/**
 * Watches a vault root recursively via FileSystemObserver. Returns null when
 * the capability is absent (the caller surfaces a manual refresh affordance
 * instead — capability gating, not a silent fallback). observe() settles
 * async; a rejection reaches onObserveError so the caller can downgrade to
 * the manual-refresh affordance — a failed probe must never look like a
 * working watcher.
 */
export function createVaultWatcher(
  handle: VaultDirectoryHandleLike,
  onChange: () => void,
  observerConstructor: VaultObserverConstructor | undefined = ambientObserverConstructor(),
  onObserveError?: (error: unknown) => void
): VaultWatcher | null {
  if (!observerConstructor) {
    return null;
  }
  const observer = new observerConstructor(onChange);
  observer.observe(handle, { recursive: true }).catch((error: unknown) => {
    logger.error('Failed to observe vault root', { error, root: handle.name });
    onObserveError?.(error);
  });
  return { disconnect: () => observer.disconnect() };
}
