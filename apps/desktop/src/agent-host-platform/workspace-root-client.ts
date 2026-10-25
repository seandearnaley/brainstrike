import { isUnsentRequest } from '@brainstrike/agent-host/boundary-wire';
import type { HostCatalog } from '@brainstrike/agent-host/catalog';
import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract/boundary-failure';
import type { HostAttachment } from '@brainstrike/host-lease';
import { HOST_LEASE_CLOSED } from '../desktop-shutdown-state';

interface DesktopWorkspaceRootCatalog extends HostCatalog {
  /**
   * A reset is retiring the profile's host: the borrows already admitted are its cancelled
   * work, and later ones ask admission for the replacement. Call once the retirement started.
   */
  cancelAdmitted(): void;
  /** Terminal app quit: fence new calls and join admitted acquisitions and replies. */
  prepareClose(): Promise<void>;
}

/** A borrow a reset cancelled: the host it was answering retired under it (ADR-0031). */
const RESET_CANCELLED = refusal({
  category: 'availability',
  code: 'desktop.catalog-reset-cancelled',
  message: 'A reset retired the agent host before it answered.',
});

/** A borrow of the current authenticated attachment, never another catalog or writer. */
export function createDesktopWorkspaceRootCatalog(
  acquireProfile: () => Promise<HostAttachment>
): DesktopWorkspaceRootCatalog {
  let current: HostCatalog | undefined;
  let closing: Promise<void> | undefined;
  let admitted = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const acquire = async (signal: AbortSignal): Promise<HostCatalog> => {
    const attachment = await acquireProfile();
    if (!('catalog' in attachment)) {
      throw new Error('The authenticated host has no catalog capability');
    }
    const client = attachment.catalog as HostCatalog;
    // A borrow a reset cancelled while it waited may hold the retiring host: never keep it.
    if (signal.aborted) {
      return client;
    }
    current = client;
    const detach = (): void => {
      if (current === client) {
        current = undefined;
      }
    };
    void attachment.closed.then(detach, detach);
    return client;
  };
  const invoke = async <T>(operation: (client: HostCatalog) => Promise<T>): Promise<T> => {
    const { signal } = admitted;
    const client = current ?? (await acquire(signal));
    try {
      return await operation(client);
    } catch (cause) {
      if (signal.aborted) {
        throw new BoundaryFailureError(RESET_CANCELLED, { cause });
      }
      if (!isUnsentRequest(cause)) {
        throw cause;
      }
      // BST-1992: the attachment's connection closed (a reset retiring it, or a
      // lost host) before its `closed` reached this borrow, so the request never
      // left. Admission decides what serves it now: the replacement host, or the
      // typed refusal of a profile that reset has retired.
      if (current === client) {
        current = undefined;
      }
      return await operation(await acquire(signal));
    }
  };
  const borrow = <T>(operation: (client: HostCatalog) => Promise<T>): Promise<T> => {
    if (closing) {
      return Promise.reject(new BoundaryFailureError(HOST_LEASE_CLOSED));
    }
    // Include acquisition: a call already admitted here may still await its attachment.
    const work = Promise.resolve().then(() => invoke(operation));
    pending.add(work);
    const settled = (): void => {
      pending.delete(work);
    };
    void work.then(settled, settled);
    return work;
  };
  return {
    cancelAdmitted: () => {
      admitted.abort();
      admitted = new AbortController();
      current = undefined;
    },
    collections: (request) => borrow((client) => client.collections(request)),
    forgeCache: (request) => borrow((client) => client.forgeCache(request)),
    forgeCacheSnapshot: () => borrow((client) => client.forgeCacheSnapshot()),
    indexConfig: (request) => borrow((client) => client.indexConfig(request)),
    modelChoices: (request) => borrow((client) => client.modelChoices(request)),
    // Joins admitted operations; each outcome stays its caller's, never a close failure.
    prepareClose: () => {
      closing ??= Promise.allSettled([...pending]).then(() => undefined);
      return closing;
    },
    promptLibrary: (request) => borrow((client) => client.promptLibrary(request)),
    sourceCatalog: (request) => borrow((client) => client.sourceCatalog(request)),
    threadGroups: (request) => borrow((client) => client.threadGroups(request)),
    viewFilterPresets: (request) => borrow((client) => client.viewFilterPresets(request)),
    workspaceRoots: (request) => borrow((client) => client.workspaceRoots(request)),
    worktreeLedger: (request) => borrow((client) => client.worktreeLedger(request)),
  };
}
