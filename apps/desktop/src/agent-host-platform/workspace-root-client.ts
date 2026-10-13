import type {
  CollectionPort,
  ForgeCachePort,
  ModelChoicePort,
  SourceCatalogPort,
  ViewFilterPresetPort,
  WorkspaceRootPort,
  WorktreeLedgerPort,
} from '@brainstrike/state-store';
import type { ThreadGroupsPort } from '@brainstrike/types';
import type { MessageConnection } from 'vscode-jsonrpc';
import { createCollectionClient } from './collection-store';
import { createModelChoiceClient } from './model-choice-store';
import { createPromptLibraryClient, type PromptLibraryPort } from './prompt-library-store';
import { createSourceCatalogClient } from './source-catalog-store';
import { createThreadGroupsClient } from './thread-groups-store';
import { createViewFilterPresetClient } from './view-filter-preset-store';
import { createWorkspaceRootClient } from './workspace-root-store';
import { createWorktreeForgeClient } from './worktree-forge-store';

/** A borrow of the current private connection, never another catalog or writer. */
export function createDesktopWorkspaceRootCatalog(
  acquireProfile: () => Promise<unknown>
): PromptLibraryPort &
  ThreadGroupsPort &
  ViewFilterPresetPort &
  CollectionPort &
  WorkspaceRootPort &
  SourceCatalogPort &
  ModelChoicePort &
  WorktreeLedgerPort &
  ForgeCachePort & {
    attach(connection: MessageConnection): () => void;
  } {
  let current:
    | (PromptLibraryPort &
        ThreadGroupsPort &
        ViewFilterPresetPort &
        CollectionPort &
        WorkspaceRootPort &
        SourceCatalogPort &
        ModelChoicePort &
        WorktreeLedgerPort &
        ForgeCachePort)
    | undefined;
  return {
    attach: (connection) => {
      const client = {
        ...createPromptLibraryClient(connection),
        ...createThreadGroupsClient(connection),
        ...createViewFilterPresetClient(connection),
        ...createCollectionClient(connection),
        ...createWorktreeForgeClient(connection),
        ...createWorkspaceRootClient(connection),
        ...createSourceCatalogClient(connection),
        ...createModelChoiceClient(connection),
      };
      current = client;
      const detach = (): void => {
        if (current === client) {
          current = undefined;
        }
      };
      connection.onClose(detach);
      connection.onDispose(detach);
      return detach;
    },
    collections: async (request) => {
      if (!current) {
        await acquireProfile();
      }
      const client = current;
      if (!client) {
        throw new Error('Collections require the agent host launched by this desktop');
      }
      return await client.collections(request);
    },
    forgeCache: async (request) => {
      if (!current) {
        await acquireProfile();
      }
      const client = current;
      if (!client) {
        throw new Error('Forge cache requires the agent host launched by this desktop');
      }
      return await client.forgeCache(request);
    },
    forgeCacheSnapshot: async () => {
      if (!current) {
        await acquireProfile();
      }
      const client = current;
      if (!client) {
        throw new Error('Forge cache requires the agent host launched by this desktop');
      }
      return await client.forgeCacheSnapshot();
    },
    modelChoices: async (request) => {
      if (!current) {
        await acquireProfile();
      }
      const client = current;
      if (!client) {
        throw new Error('Model choices require the agent host launched by this desktop');
      }
      return await client.modelChoices(request);
    },
    promptLibrary: async (request) => {
      if (!current) {
        await acquireProfile();
      }
      const client = current;
      if (!client) {
        throw new Error('Prompt Library requires the agent host launched by this desktop');
      }
      return await client.promptLibrary(request);
    },
    sourceCatalog: async (request) => {
      if (!current) {
        await acquireProfile();
      }
      const client = current;
      if (!client) {
        throw new Error('Source catalog requires the agent host launched by this desktop');
      }
      return await client.sourceCatalog(request);
    },
    threadGroups: async (request) => {
      if (!current) {
        await acquireProfile();
      }
      const client = current;
      if (!client) {
        throw new Error('Thread groups require the agent host launched by this desktop');
      }
      return await client.threadGroups(request);
    },
    viewFilterPresets: async (request) => {
      if (!current) {
        await acquireProfile();
      }
      const client = current;
      if (!client) {
        throw new Error('View presets require the agent host launched by this desktop');
      }
      return await client.viewFilterPresets(request);
    },
    workspaceRoots: async (request) => {
      if (!current) {
        await acquireProfile();
      }
      const client = current;
      if (!client) {
        throw new Error('Workspace catalog requires the agent host launched by this desktop');
      }
      return await client.workspaceRoots(request);
    },
    worktreeLedger: async (request) => {
      if (!current) {
        await acquireProfile();
      }
      const client = current;
      if (!client) {
        throw new Error('Worktree ledger requires the agent host launched by this desktop');
      }
      return await client.worktreeLedger(request);
    },
  };
}
