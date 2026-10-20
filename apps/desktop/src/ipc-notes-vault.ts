import path from 'node:path';
import { startJoinedParcelWatch } from '@brainstrike/file-system/native-watch';
import { createLogger } from '@brainstrike/logging';
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
 * main.ts) for the persisted approved-roots list, and Main's joined
 * @parcel/watcher producer (`startJoinedParcelWatch` — batched at 150 ms,
 * default native ignore-filtered, with BST-1180 coarse reporting explicitly
 * disabled; setup failure rejects, never a silent fallback engine — BST-568
 * slice 4). Its subscribe and unsubscribe are both awaitable, so the returned
 * disposer unregisters the channels and resolves once every live watcher is
 * unsubscribed (BST-2244).
 */
export function registerNotesVaultIpc(
  storage: NotesVaultRootsStorage,
  handlers?: NotesVaultIpcHandlers
): () => Promise<void> {
  if (handlers) {
    return registerNotesVaultIpcHandlers(handlers);
  }
  return registerNotesVaultIpcHandlers(
    createNotesVaultIpcHandlers({
      getDefaultVaultParentPath: resolveDefaultVaultParentPath,
      pickDirectoryPath: pickDirectoryPathWithNativeDialog,
      startWatch: (directoryPath, onChange) =>
        startJoinedParcelWatch(
          {
            kind: 'directory',
            name: path.basename(directoryPath),
            path: directoryPath,
            platform: 'electron',
          },
          () => onChange(),
          { reportDefaultFilteredChanges: false }
        ),
      storage,
      trashItem: (absolutePath) => shell.trashItem(absolutePath),
    })
  );
}
