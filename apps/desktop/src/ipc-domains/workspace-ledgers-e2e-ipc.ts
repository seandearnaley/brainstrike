import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { Schema } from 'effect';
import { ipcMain } from 'electron';
import { isElectronE2ETestMode } from '../electron-e2e-test-mode';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import { isMainOwnedDesktopStorageKey } from '../platform/desktop-storage-authority';
import { NoArgs } from '../platform/ipc-args';

interface RegisterWorkspaceLedgersE2eHandlersOptions {
  readonly storage: ElectronStorageAdapter;
}

/**
 * E2E only: lets a spec seed and clear Main's workspace ledgers before a reload. Production
 * registers nothing here, and no renderer channel reads or writes Main's storage.
 */
export function registerWorkspaceLedgersE2eHandlers({
  storage,
}: RegisterWorkspaceLedgersE2eHandlersOptions): () => void {
  if (!isElectronE2ETestMode()) {
    return () => undefined;
  }
  const registry = createDesktopIpcRegistry({ ipcMain });
  registry.handle(
    'files',
    DESKTOP_IPC_CHANNELS.files.seedLedgerForE2e,
    Schema.Tuple([Schema.String, Schema.String]),
    async (_event, key, value) => {
      if (!isMainOwnedDesktopStorageKey(key)) {
        throw new Error('E2E ledger seed requires a main-owned key.');
      }
      return storage.setItem(key, value);
    }
  );
  registry.handle('files', DESKTOP_IPC_CHANNELS.files.clearLedgersForE2e, NoArgs, async () =>
    storage.clear()
  );
  return () => registry.unregisterAll();
}
