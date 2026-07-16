import { createVaultHandleStore } from '../core/handle-store';
import type { VaultDirectoryHandleLike } from '../core/types';
import { createVaultWatcher } from '../core/watch';
import type { NotesVaultServices } from './notes-vault-store';

interface DirectoryPickerWindow {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
  }) => Promise<VaultDirectoryHandleLike>;
}

/**
 * Real platform services (the single boundary that touches browser APIs).
 * The picker requests readwrite up front so note creation never needs a
 * second prompt; Chrome 122+ persistent permissions ("Allow on every visit")
 * make restored handles silent afterwards.
 */
export function createDefaultNotesVaultServices(): NotesVaultServices {
  return {
    createWatcher: (handle, onChange) => createVaultWatcher(handle, onChange),
    handleStore: createVaultHandleStore(),
    newRootId: () => crypto.randomUUID(),
    now: () => Date.now(),
    pickDirectory: () => {
      const picker = (globalThis as DirectoryPickerWindow).showDirectoryPicker;
      if (typeof picker !== 'function') {
        throw new Error('The File System Access directory picker is not available');
      }
      return picker({ id: 'notes-vault', mode: 'readwrite' });
    },
  };
}
