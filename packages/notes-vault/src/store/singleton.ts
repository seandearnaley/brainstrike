import { createDefaultNotesVaultServices } from './default-services';
import { createNotesVaultStore, type NotesVaultStore } from './notes-vault-store';

let instance: NotesVaultStore | null = null;

/** Lazily creates the app-wide store (panel mount time, behind the capability gate). */
export function getNotesVaultStore(): NotesVaultStore {
  if (!instance) {
    instance = createNotesVaultStore(createDefaultNotesVaultServices());
  }
  return instance;
}

/** The store if it was ever created this session; null otherwise. */
export function peekNotesVaultStore(): NotesVaultStore | null {
  return instance;
}
