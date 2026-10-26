import type { MessageConnection } from 'vscode-jsonrpc';
import { createCollectionClient, serveCollectionStore } from './collection-store.ts';
import {
  createIndexConfigClient,
  type IndexConfigSettings,
  serveIndexConfigStore,
} from './index-config-store.ts';
import { createModelChoiceClient, serveModelChoiceStore } from './model-choice-store.ts';
import { createPromptLibraryClient, servePromptLibrary } from './prompt-library-store.ts';
import { createSourceCatalogClient, serveSourceCatalogStore } from './source-catalog-store.ts';
import { createThreadGroupsClient, serveThreadGroups } from './thread-groups-store.ts';
import {
  createViewFilterPresetClient,
  serveViewFilterPresets,
} from './view-filter-preset-store.ts';
import { createWorkspaceRootClient, serveWorkspaceRootStore } from './workspace-root-store.ts';
import { createWorktreeLedgerClient, serveWorktreeLedgerStore } from './worktree-ledger-store.ts';

export function createHostCatalogClient(connection: MessageConnection) {
  return {
    ...createCollectionClient(connection),
    ...createIndexConfigClient(connection),
    ...createModelChoiceClient(connection),
    ...createPromptLibraryClient(connection),
    ...createSourceCatalogClient(connection),
    ...createThreadGroupsClient(connection),
    ...createViewFilterPresetClient(connection),
    ...createWorkspaceRootClient(connection),
    ...createWorktreeLedgerClient(connection),
  };
}
export type HostCatalog = ReturnType<typeof createHostCatalogClient>;
/** What serves the catalog: the acquired writer's domains and its settings. */
export type HostCatalogStore = Omit<HostCatalog, 'indexConfig'> & IndexConfigSettings;

/** These are borrowed endpoints of the acquired writer, never a second store. */
export function serveHostCatalog(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: HostCatalogStore
) {
  const endpoints = [
    serveCollectionStore(connection, store),
    serveIndexConfigStore(connection, store),
    serveModelChoiceStore(connection, store),
    servePromptLibrary(connection, store),
    serveSourceCatalogStore(connection, store),
    serveThreadGroups(connection, store),
    serveViewFilterPresets(connection, store),
    serveWorkspaceRootStore(connection, store),
    serveWorktreeLedgerStore(connection, store),
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
