import type { MessageConnection } from 'vscode-jsonrpc';
import { createModelChoiceClient, serveModelChoiceStore } from './model-choice-store.ts';
import { createThreadGroupsClient, serveThreadGroups } from './thread-groups-store.ts';
import {
  createViewFilterPresetClient,
  serveViewFilterPresets,
} from './view-filter-preset-store.ts';
import { createWorkspaceRootClient, serveWorkspaceRootStore } from './workspace-root-store.ts';

export function createHostCatalogClient(connection: MessageConnection) {
  return {
    ...createModelChoiceClient(connection),
    ...createThreadGroupsClient(connection),
    ...createViewFilterPresetClient(connection),
    ...createWorkspaceRootClient(connection),
  };
}
export type HostCatalog = ReturnType<typeof createHostCatalogClient>;

/** These are borrowed endpoints of the acquired writer, never a second store. */
export function serveHostCatalog(
  connection: Pick<MessageConnection, 'onRequest'>,
  /** The acquired writer's domains. */
  store: HostCatalog
) {
  const endpoints = [
    serveModelChoiceStore(connection, store),
    serveThreadGroups(connection, store),
    serveViewFilterPresets(connection, store),
    serveWorkspaceRootStore(connection, store),
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
