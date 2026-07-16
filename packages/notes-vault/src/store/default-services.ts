import { DEFAULT_VAULT_DISPLAY_NAME, ensureDefaultVault } from '../core/default-vault';
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
    createWatcher: (handle, onChange, onError) =>
      createVaultWatcher(handle, onChange, undefined, onError),
    // The built-in "My Notes" vault lives in OPFS (origin-private browser
    // storage) — instantly available with zero prompts. Absent OPFS = no
    // default vault (capability gating; picker-mounted vaults still work).
    getDefaultVault: async () => {
      if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
        return null;
      }
      const storageRoot =
        (await navigator.storage.getDirectory()) as unknown as VaultDirectoryHandleLike;
      return {
        handle: await ensureDefaultVault(storageRoot),
        name: DEFAULT_VAULT_DISPLAY_NAME,
      };
    },
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
