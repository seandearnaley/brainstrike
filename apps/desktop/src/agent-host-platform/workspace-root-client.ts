import { isUnsentRequest } from '@brainstrike/agent-host/boundary-wire';
import type { HostCatalog } from '@brainstrike/agent-host/catalog';
import type { HostAttachment } from '@brainstrike/host-lease';

/** A borrow of the current authenticated attachment, never another catalog or writer. */
export function createDesktopWorkspaceRootCatalog(
  acquireProfile: () => Promise<HostAttachment>
): HostCatalog {
  let current: HostCatalog | undefined;
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
  const borrow = async <T>(use: (client: HostCatalog) => Promise<T>): Promise<T> => {
    const client = current ?? (await acquire());
    try {
      return await use(client);
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
      return await use(await acquire());
    }
  };
  return {
    collections: (request) => borrow((client) => client.collections(request)),
    forgeCache: (request) => borrow((client) => client.forgeCache(request)),
    forgeCacheSnapshot: () => borrow((client) => client.forgeCacheSnapshot()),
    modelChoices: (request) => borrow((client) => client.modelChoices(request)),
    promptLibrary: (request) => borrow((client) => client.promptLibrary(request)),
    sourceCatalog: (request) => borrow((client) => client.sourceCatalog(request)),
    threadGroups: (request) => borrow((client) => client.threadGroups(request)),
    viewFilterPresets: (request) => borrow((client) => client.viewFilterPresets(request)),
    workspaceRoots: (request) => borrow((client) => client.workspaceRoots(request)),
    worktreeLedger: (request) => borrow((client) => client.worktreeLedger(request)),
  };
}
