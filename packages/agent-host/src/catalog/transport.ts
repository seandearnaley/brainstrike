import type { MessageConnection } from 'vscode-jsonrpc';
import { createCollectionClient, serveCollectionStore } from './collection-store.js';
import { createModelChoiceClient, serveModelChoiceStore } from './model-choice-store.js';
import { createPromptLibraryClient, servePromptLibrary } from './prompt-library-store.js';
import { createSourceCatalogClient, serveSourceCatalogStore } from './source-catalog-store.js';
import { createThreadGroupsClient, serveThreadGroups } from './thread-groups-store.js';
import {
  createViewFilterPresetClient,
  serveViewFilterPresets,
} from './view-filter-preset-store.js';
import { createWorkspaceRootClient, serveWorkspaceRootStore } from './workspace-root-store.js';
import { createWorktreeForgeClient, serveWorktreeForgeStore } from './worktree-forge-store.js';

export function createHostCatalogClient(connection: MessageConnection) {
  return {
    ...createCollectionClient(connection),
    ...createModelChoiceClient(connection),
    ...createPromptLibraryClient(connection),
    ...createSourceCatalogClient(connection),
    ...createThreadGroupsClient(connection),
    ...createViewFilterPresetClient(connection),
    ...createWorkspaceRootClient(connection),
    ...createWorktreeForgeClient(connection),
  };
}
export type HostCatalog = ReturnType<typeof createHostCatalogClient>;

/** These are borrowed endpoints of the acquired writer, never a second store. */
export function serveHostCatalog(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: HostCatalog
) {
  const endpoints = [
    serveCollectionStore(connection, store),
    serveModelChoiceStore(connection, store),
    servePromptLibrary(connection, store),
    serveSourceCatalogStore(connection, store),
    serveThreadGroups(connection, store),
    serveViewFilterPresets(connection, store),
    serveWorkspaceRootStore(connection, store),
    serveWorktreeForgeStore(connection, store),
  ];
  let closing: Promise<void> | undefined;
  return {
    close: (): Promise<void> => {
      closing ??= Promise.allSettled(endpoints.map((endpoint) => endpoint.close())).then(
        (results) => {
          const failures = results
            .filter((result) => result.status === 'rejected')
            .map((result) => result.reason);
          if (failures.length) {
            throw new AggregateError(failures, 'Host catalog endpoints did not retire');
          }
        }
      );
      return closing;
    },
  };
}
