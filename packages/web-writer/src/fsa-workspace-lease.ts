import type { CanonicalWorkspaceLease } from '@brainstrike/canonical-ingestion/browser';
import { webRootPath } from '@brainstrike/web-state-store';
import { fsaWorkspaceRoot } from './fsa-workspace-root';

/** A root's folder lent to its ingestion runtime, until it is revoked. */
export interface FsaWorkspaceLease extends CanonicalWorkspaceLease {
  /** Ends the lease: its reads refuse, and the runtime retires its passes. */
  revoke(reason: unknown): void;
}

/**
 * The browser's mounted lease, over the File System Access handle the user
 * granted for `rootId`. Its path is the root's handle key (`webRootPath`), so
 * discovery names every source under it. Nothing watches a handle in the
 * browser: a pass runs when the writer asks for a scan.
 */
export function fsaWorkspaceLease(
  rootId: string,
  handle: FileSystemDirectoryHandle
): FsaWorkspaceLease {
  const root = fsaWorkspaceRoot(handle);
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const own = <T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    controller.signal.throwIfAborted();
    signal.throwIfAborted();
    const running = work();
    pending.add(running);
    void running.then(
      () => pending.delete(running),
      () => pending.delete(running)
    );
    return running;
  };
  return {
    canonicalPath: webRootPath(rootId),
    generation: crypto.randomUUID(),
    listDir: (relativePath, maxEntries, context) =>
      own(() => root.listDir(relativePath, maxEntries), context.signal),
    readFile: (relativePath, maxBytes, context) =>
      own(() => root.readFile(relativePath, maxBytes), context.signal),
    // Joins this lease's own reads; the folder itself is the user's.
    retire: async () => {
      await Promise.allSettled([...pending]);
    },
    revoke: (reason) => controller.abort(reason),
    rootId,
    signal: controller.signal,
    subscribe: async () => ({ close: async () => {} }),
  };
}
