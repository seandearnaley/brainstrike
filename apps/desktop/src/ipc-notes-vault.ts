import path from 'node:path';
import { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { createLogger } from '@brainstrike/utils/logger';
import { app, dialog, shell } from 'electron';
import {
  createNotesVaultIpcHandlers,
  type NotesVaultIpcHandlers,
  type NotesVaultRootsStorage,
  registerNotesVaultIpcHandlers,
} from './notes-vault-ipc-handlers';

const logger = createLogger('NotesVaultIpcRegistrar');

/**
 * Default vault parent: the OS documents directory (mirroring db-main.ts's
 * database root). `app.getPath('documents')` can throw on platforms without a
 * documents dir (some Linux setups) — fall back to userData LOUDLY (logged),
 * never silently.
 */
function resolveDefaultVaultParentPath(): string {
  try {
    return app.getPath('documents');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const userDataPath = app.getPath('userData');
    logger.warn('Documents directory unavailable; defaulting notes vault to userData', {
      error: message,
      userDataPath,
    });
    return userDataPath;
  }
}

async function pickDirectoryPathWithNativeDialog(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Add Notes Vault',
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0] ?? null;
}

/**
 * Register the desktop `notesVault` IPC domain.
 *
 * Approved-roots security model + handler behavior live in
 * `notes-vault-ipc-handlers.ts`; this registrar wires the production
 * dependencies: `app.getPath` for the default vault location, the native
 * directory picker, `shell.trashItem` for recoverable deletes (deleteEntry
 * never hard-unlinks), the shared `ElectronStorageAdapter` (passed by
 * main.ts) for the persisted approved-roots list, and the shared parcel-backed
 * recursive watcher from `@brainstrike/file-system/electron` (`watchDirectory`
 * — batched at 150 ms, ignore-filtered; setup failure surfaces via the typed
 * health protocol, never a silent fallback engine — BST-568 slice 4). The
 * returned disposer unregisters the channels and reaps every live watcher.
 */
export function registerNotesVaultIpc(
  storage: NotesVaultRootsStorage,
  handlers?: NotesVaultIpcHandlers
): () => void {
  if (handlers) {
    return registerNotesVaultIpcHandlers(handlers);
  }
  const watcherAdapter = new ElectronFileSystemAdapter();
  return registerNotesVaultIpcHandlers(
    createNotesVaultIpcHandlers({
      getDefaultVaultParentPath: resolveDefaultVaultParentPath,
      pickDirectoryPath: pickDirectoryPathWithNativeDialog,
      startWatch: (directoryPath, onChange) =>
        new Promise<() => void>((resolve, reject) => {
          let settled = false;
          let stop = (): void => {};
          stop = watcherAdapter.watchDirectory(
            {
              kind: 'directory',
              name: path.basename(directoryPath),
              path: directoryPath,
              platform: 'electron',
            },
            () => onChange(),
            {
              onHealth: (event) => {
                if (settled) {
                  return;
                }
                if (event.state === 'healthy') {
                  settled = true;
                  resolve(stop);
                  return;
                }
                if (event.state === 'failed') {
                  settled = true;
                  stop();
                  reject(new Error(event.failure?.message ?? 'Notes vault watcher setup failed'));
                }
              },
            }
          );
        }),
      storage,
      trashItem: (absolutePath) => shell.trashItem(absolutePath),
    })
  );
}
