import { createLogger } from '@brainstrike/utils';
import { createVaultHandleStore, type VaultHandleStore } from '../core/handle-store';
import type { VaultDirectoryHandleLike } from '../core/types';
import type { NotesVaultServices } from '../store/notes-vault-store';
import type { NotesVaultBridge } from './bridge-contract';
import { createNodeVaultDirectoryHandle, nodeVaultHandlePath } from './node-vault-handles';

const logger = createLogger('NotesVaultDesktop');

/** Structured-cloneable persistence marker for a node-backed vault root. */
interface NodePathMarker {
  notesVaultNodePath: string;
}

function isNodePathMarker(candidate: unknown): candidate is NodePathMarker {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as NodePathMarker).notesVaultNodePath === 'string'
  );
}

/**
 * Desktop-native services: the vault runs on Node fs + chokidar in main via
 * the window.notesVault bridge — real paths, no permission ceremony. Handles
 * persist as plain path markers (class instances would lose their methods to
 * structured clone) and are re-approved with main on restore.
 */
export function createDesktopNotesVaultServices(
  bridge: NotesVaultBridge,
  options: { handleStore?: VaultHandleStore } = {}
): NotesVaultServices {
  const inner = options.handleStore ?? createVaultHandleStore();

  const handleStore: VaultHandleStore = {
    list: async () => {
      const stored = await inner.list();
      const rehydrated = [];
      for (const root of stored) {
        const marker = root.handle as unknown;
        if (!isNodePathMarker(marker)) {
          throw new Error(
            `Persisted vault root ${root.rootId} is not a desktop path marker — cannot rehydrate`
          );
        }
        const path = marker.notesVaultNodePath;
        // Re-approve with main so containment checks accept this root again.
        // A failure (folder deleted/renamed) is not fatal here: the scan will
        // surface it on the root row.
        const approval = await bridge.registerRoot(path);
        if (!approval.ok) {
          logger.warn('Restored vault root could not be re-approved', {
            error: approval.error,
            path,
          });
        }
        rehydrated.push({
          ...root,
          handle: createNodeVaultDirectoryHandle(bridge, path, root.name),
        });
      }
      return rehydrated;
    },
    put: async (root) => {
      const path = nodeVaultHandlePath(root.handle);
      if (path === null) {
        throw new Error('Cannot persist a non-desktop vault handle through the desktop backend');
      }
      const marker: NodePathMarker = { notesVaultNodePath: path };
      await inner.put({ ...root, handle: marker as unknown as VaultDirectoryHandleLike });
    },
    remove: (rootId) => inner.remove(rootId),
  };

  return {
    createWatcher: (handle, onChange, onError) => {
      const path = nodeVaultHandlePath(handle);
      if (path === null) {
        return null;
      }
      let watchId: string | null = null;
      let disposed = false;
      const unsubscribe = bridge.onChanged((event) => {
        if (watchId !== null && event.watchId === watchId) {
          onChange();
        }
      });
      bridge.watch(path).then(
        (result) => {
          if (!result.ok) {
            logger.error('Vault watch failed to start', { error: result.error, path });
            unsubscribe();
            onError?.(new Error(result.error));
            return;
          }
          if (disposed) {
            void bridge.unwatch(result.value.watchId);
            return;
          }
          watchId = result.value.watchId;
        },
        (error: unknown) => {
          unsubscribe();
          onError?.(error);
        }
      );
      return {
        disconnect: () => {
          disposed = true;
          unsubscribe();
          if (watchId !== null) {
            void bridge.unwatch(watchId);
            watchId = null;
          }
        },
      };
    },
    getDefaultVault: async () => {
      const result = await bridge.ensureDefaultVault();
      if (!result.ok) {
        throw new Error(result.error);
      }
      return {
        handle: createNodeVaultDirectoryHandle(bridge, result.value.path, result.value.name),
        name: result.value.name,
      };
    },
    handleStore,
    newRootId: () => crypto.randomUUID(),
    now: () => Date.now(),
    pickDirectory: async () => {
      const result = await bridge.pickDirectory();
      if (!result.ok) {
        throw new Error(result.error);
      }
      if (result.value === null) {
        throw new DOMException('Directory picker was cancelled', 'AbortError');
      }
      return createNodeVaultDirectoryHandle(bridge, result.value.path, result.value.name);
    },
  };
}
