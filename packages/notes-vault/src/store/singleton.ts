import { resolveNotesVaultBridge } from '../desktop/bridge-contract';
import { createDesktopNotesVaultServices } from '../desktop/desktop-services';
import { createDefaultNotesVaultServices } from './default-services';
import { createNotesVaultStore, type NotesVaultStore } from './notes-vault-store';

let instance: NotesVaultStore | null = null;

/**
 * Lazily creates the app-wide store (panel mount time, behind the capability
 * gate). Backend selection is capability-based: the desktop preload bridge
 * (Node fs, no permission ceremony) wins when present; otherwise the web
 * File System Access backend.
 */
export function getNotesVaultStore(): NotesVaultStore {
  if (!instance) {
    const bridge = resolveNotesVaultBridge();
    instance = createNotesVaultStore(
      bridge ? createDesktopNotesVaultServices(bridge) : createDefaultNotesVaultServices()
    );
  }
  return instance;
}

/** The store if it was ever created this session; null otherwise. */
export function peekNotesVaultStore(): NotesVaultStore | null {
  return instance;
}
