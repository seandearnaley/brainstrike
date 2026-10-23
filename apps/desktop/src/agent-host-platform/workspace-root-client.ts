import { isUnsentRequest } from '@brainstrike/agent-host/boundary-wire';
import type { HostCatalog } from '@brainstrike/agent-host/catalog';
import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import type { HostAttachment } from '@brainstrike/host-lease';
import { HOST_LEASE_CLOSED } from '../desktop-shutdown-state';

interface DesktopWorkspaceRootCatalog extends HostCatalog {
  /** Terminal app quit: fence new calls and join admitted acquisitions and replies. */
  prepareClose(): Promise<void>;
}

/** A borrow of the current authenticated attachment, never another catalog or writer. */
export function createDesktopWorkspaceRootCatalog(
  acquireProfile: () => Promise<HostAttachment>
): DesktopWorkspaceRootCatalog {
  let current: HostCatalog | undefined;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const acquire = async (): Promise<HostCatalog> => {
    const attachment = await acquireProfile();
    if (!('catalog' in attachment)) {
      throw new Error('The authenticated host has no catalog capability');
    }
    const client = attachment.catalog as HostCatalog;
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
    const client = current ?? (await acquire());
    try {
      return await operation(client);
    } catch (cause) {
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
      return await operation(await acquire());
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
    collections: (request) => borrow((client) => client.collections(request)),
    forgeCache: (request) => borrow((client) => client.forgeCache(request)),
    forgeCacheSnapshot: () => borrow((client) => client.forgeCacheSnapshot()),
    indexConfig: (request) => borrow((client) => client.indexConfig(request)),
    modelChoices: (request) => borrow((client) => client.modelChoices(request)),
    prepareClose: () => {
      closing ??= Promise.allSettled([...pending]).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'Main catalog operations failed during close preparation'
          );
        }
      });
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
