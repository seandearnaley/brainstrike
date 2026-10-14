import type { HostCatalog } from '@brainstrike/agent-host/catalog';
import type { HostAttachment } from '@brainstrike/host-lease';

/** A borrow of the current authenticated attachment, never another catalog or writer. */
export function createDesktopWorkspaceRootCatalog(
  acquireProfile: () => Promise<HostAttachment>
): HostCatalog {
  let current: HostCatalog | undefined;
  const acquire = async (): Promise<void> => {
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
  };
  return {
    collections: async (request) => {
      if (!current) {
        await acquire();
      }
      const client = current;
      if (!client) {
        throw new Error('Collections require an authenticated live agent host');
      }
      return await client.collections(request);
    },
    forgeCache: async (request) => {
      if (!current) {
        await acquire();
      }
      const client = current;
      if (!client) {
        throw new Error('Forge cache requires an authenticated live agent host');
      }
      return await client.forgeCache(request);
    },
    forgeCacheSnapshot: async () => {
      if (!current) {
        await acquire();
      }
      const client = current;
      if (!client) {
        throw new Error('Forge cache requires an authenticated live agent host');
      }
      return await client.forgeCacheSnapshot();
    },
    modelChoices: async (request) => {
      if (!current) {
        await acquire();
      }
      const client = current;
      if (!client) {
        throw new Error('Model choices require an authenticated live agent host');
      }
      return await client.modelChoices(request);
    },
    promptLibrary: async (request) => {
      if (!current) {
        await acquire();
      }
      const client = current;
      if (!client) {
        throw new Error('Prompt Library requires an authenticated live agent host');
      }
      return await client.promptLibrary(request);
    },
    sourceCatalog: async (request) => {
      if (!current) {
        await acquire();
      }
      const client = current;
      if (!client) {
        throw new Error('Source catalog requires an authenticated live agent host');
      }
      return await client.sourceCatalog(request);
    },
    threadGroups: async (request) => {
      if (!current) {
        await acquire();
      }
      const client = current;
      if (!client) {
        throw new Error('Thread groups require an authenticated live agent host');
      }
      return await client.threadGroups(request);
    },
    viewFilterPresets: async (request) => {
      if (!current) {
        await acquire();
      }
      const client = current;
      if (!client) {
        throw new Error('View presets require an authenticated live agent host');
      }
      return await client.viewFilterPresets(request);
    },
    workspaceRoots: async (request) => {
      if (!current) {
        await acquire();
      }
      const client = current;
      if (!client) {
        throw new Error('Workspace catalog requires an authenticated live agent host');
      }
      return await client.workspaceRoots(request);
    },
    worktreeLedger: async (request) => {
      if (!current) {
        await acquire();
      }
      const client = current;
      if (!client) {
        throw new Error('Worktree ledger requires an authenticated live agent host');
      }
      return await client.worktreeLedger(request);
    },
  };
}
