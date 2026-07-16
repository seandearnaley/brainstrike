import { useWorkspaceContextCurationStore } from '@brainstrike/file-explorer-ui/workspace-context-curation-store';
import { resetNotesVaultSessionState } from '@brainstrike/notes-vault/store-reset';
import { registerFactoryResetSessionStore } from '@brainstrike/preferences/settings/system/factory-reset-helpers';
import { resetContextUsageStore } from '@brainstrike/ui/assistant-ui-panel/context-usage-store';
import { useChunkSelectionStore } from '@brainstrike/workspace-search/chunk-selection-store';
import { useWorkspaceSearchStore } from '@brainstrike/workspace-search/workspace-search-store';
import { useAssistantComposerCommandStore } from './assistant-composer-command-store';
import { useAssistantThreadGroupsStore } from './assistant-thread-groups-store';

/**
 * Wire session-only Zustand stores into the factory-reset pipeline per the
 * FACTORY RESET CONTRACT. preferences owns the reset but cannot import these
 * feature packages (cycle), so app-shell (which composes both) registers the
 * resetters here — mirroring how preferences resets its own permission-policy
 * store. Registered at module load so a reset works even if the owning UI was
 * never opened this session.
 *
 * Import this module for its side effects from root-layout-content (or tests).
 * Store imports use package subpaths (not feature barrels) so registration stays
 * free of UI/bridge side graphs.
 */
registerFactoryResetSessionStore(() => {
  useWorkspaceSearchStore.getState().reset();
});

registerFactoryResetSessionStore(() => {
  // Chunk subset only. Containing-file selections are cleared by
  // FileExplorerProvider's live registerFactoryResetSessionStore callback
  // (search bridge selects files alongside chunks).
  useChunkSelectionStore.getState().clearAll();
});

registerFactoryResetSessionStore(() => {
  resetContextUsageStore();
});

registerFactoryResetSessionStore(() => {
  useWorkspaceContextCurationStore.getState().reset();
});

registerFactoryResetSessionStore(() => {
  useAssistantComposerCommandStore.getState().reset();
});

registerFactoryResetSessionStore(() => {
  // Thread group/placement rows live in PGlite (wiped with the DB); this
  // clears the in-memory mirror plus the persisted view prefs slice so a
  // reset-without-reload doesn't resurrect stale groups.
  useAssistantThreadGroupsStore.getState().reset();
});

registerFactoryResetSessionStore(() => {
  // Session state only (mounted roots, watchers, selection); the persisted
  // handle database (brainstrike-notes-vault) is wiped via the IndexedDB
  // fallback list in factory-reset-helpers.ts.
  resetNotesVaultSessionState();
});
