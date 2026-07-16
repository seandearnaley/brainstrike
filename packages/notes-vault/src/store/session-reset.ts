import { clearNoteContentCache } from '../panel/note-content-store';
import { peekNotesVaultStore } from './singleton';

/**
 * FACTORY RESET CONTRACT hook: clears session state (mounted roots, watchers,
 * selection) if the vault store was created this session, plus the module-
 * level note plaintext cache. The persisted IndexedDB handle database
 * (NOTES_VAULT_IDB_NAME) is wiped separately by the IndexedDB fallback list
 * in factory-reset-helpers.ts.
 */
export function resetNotesVaultSessionState(): void {
  peekNotesVaultStore()?.getState().reset();
  clearNoteContentCache();
}
