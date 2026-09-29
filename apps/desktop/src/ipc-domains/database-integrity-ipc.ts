import { createLogger } from '@brainstrike/logging';
import type { DatabaseIntegritySnapshot } from '@brainstrike/types';
import { ipcMain } from 'electron';
import type { DesktopDatabaseIntegrity } from '../database-integrity-state';
import { createDesktopIpcRegistry, registerDomain } from '../platform/desktop-ipc-registry';
import { ipcOk } from '../platform/ipc-contract';
import { getTrackedWindowsByRole } from '../window-role';
import { databaseIntegrityContract } from './database.contract';

const logger = createLogger('DatabaseIntegrityIpc');

export interface DatabaseIntegrityIpcOptions {
  readonly integrity: Pick<DesktopDatabaseIntegrity, 'getSnapshot' | 'subscribe'>;
}

/**
 * Exposes the main-owned integrity state to the renderers that act on it: the
 * visible UI and the embedding host. `db:integrity:state` answers the current
 * snapshot; every state change is pushed on `db:integrity:changed`. The
 * chunking and LLM hosts have no reason to know, so they get neither.
 */
export function registerDatabaseIntegrityIpcHandlers({
  integrity,
}: DatabaseIntegrityIpcOptions): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'db', databaseIntegrityContract, {
    getState: () => ipcOk(integrity.getSnapshot()),
  });

  const publish = (snapshot: DatabaseIntegritySnapshot): void => {
    for (const role of ['visible-ui', 'embedding-host'] as const) {
      for (const window of getTrackedWindowsByRole(role)) {
        const { webContents } = window;
        if (webContents.isDestroyed()) {
          continue;
        }
        try {
          webContents.send(databaseIntegrityContract.onChanged.channel, snapshot);
        } catch (error) {
          // One window mid-teardown must not keep the others from learning the
          // database is contained.
          logger.error('Database integrity change could not be sent to a window', {
            error,
            revision: snapshot.revision,
            windowRole: role,
          });
        }
      }
    }
  };
  const unsubscribe = integrity.subscribe(publish);

  return () => {
    unsubscribe();
    registry.unregisterAll();
  };
}
