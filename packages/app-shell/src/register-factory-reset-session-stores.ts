import { useWorkspaceContextCurationStore } from '@brainstrike/file-explorer-ui/workspace-context-curation-store';
import { registerFactoryResetSessionStore } from '@brainstrike/preferences/settings/system/factory-reset-helpers';
import { resetContextUsageStore } from '@brainstrike/ui/assistant-ui-panel/context-usage-store';
import { useChunkSelectionStore } from '@brainstrike/workspace-search/chunk-selection-store';
import { useWorkspaceSearchStore } from '@brainstrike/workspace-search/workspace-search-store';

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
  useChunkSelectionStore.getState().clearAll();
});

registerFactoryResetSessionStore(() => {
  resetContextUsageStore();
});

registerFactoryResetSessionStore(() => {
  useWorkspaceContextCurationStore.getState().reset();
});
