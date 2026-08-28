import { registerFactoryResetSessionStore } from '@brainstrike/app-state/factory-reset';
import { useAssistantThreadGroupsStore } from '@brainstrike/assistant-data';
import { resetContextUsageStore } from '@brainstrike/assistant-ui/context-usage-store';
import { resetFollowUpQueueStore } from '@brainstrike/assistant-ui/follow-up-queue-store';
import { useRewindComposerStore } from '@brainstrike/assistant-ui/rewind-composer-store';
import { resetDatabaseDemoStoreToDefault } from '@brainstrike/db-explorer/database-demo-store';
import { useTabManagerStore } from '@brainstrike/file-explorer-ui/tab-manager-store';
import { useWorkspaceContextCurationStore } from '@brainstrike/file-explorer-ui/workspace-context-curation-store';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { resetNotesVaultSessionState } from '@brainstrike/notes-vault/store-reset';
import { useChunkSelectionStore } from '@brainstrike/workspace-search/chunk-selection-store';
import { useWorkspaceSearchStore } from '@brainstrike/workspace-search/workspace-search-store';
import { useAssistantComposerCommandStore } from './assistant-composer-command-store';
import { useChangesLiveRefreshStore } from './changes/changes-live-refresh-store';
import { useChangesNavigationStore } from './changes/changes-navigation-store';
import { useChangesStore } from './changes/changes-store';
import { useRewindStore } from './changes/rewind-store';
import { resetAppShellSessionStores } from './reset-app-shell-session-stores';
import { useTerminalTargetStore } from './stores/terminal-target-store';

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
registerFactoryResetSessionStore(resetAppShellSessionStores);

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
  // Queued-but-unsent follow-up messages must never survive a reset.
  resetFollowUpQueueStore();
});

registerFactoryResetSessionStore(() => {
  useWorkspaceContextCurationStore.getState().reset();
});

registerFactoryResetSessionStore(() => {
  // BST-1258 unified workspace tabs. Both stores PERSIST (localStorage is
  // cleared by the blanket wipe), but the LIVE instances must reset too or a
  // reset-without-reload on web resurrects the open tab set on the next
  // persist write — the resetDatabaseDemoStoreToDefault bug class.
  useWorkspaceTabSelectionStore.getState().reset();
  useTabManagerStore.getState().clearTabs();
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

registerFactoryResetSessionStore(() => {
  useChangesNavigationStore.getState().reset();
});

registerFactoryResetSessionStore(() => {
  useChangesStore.getState().reset();
});

registerFactoryResetSessionStore(() => {
  useChangesLiveRefreshStore.getState().reset();
});

registerFactoryResetSessionStore(() => {
  useRewindStore.getState().reset();
});

registerFactoryResetSessionStore(() => {
  // A pending composer repopulation is the text of a message the reset just
  // deleted — it must not land in a fresh profile's first prompt.
  useRewindComposerStore.getState().consume();
});

registerFactoryResetSessionStore(() => {
  // The Database tab's panel store is persisted, but it is also a mounted
  // singleton: `localStorage.clear()` drops the saved slice while the live
  // instance keeps `debugDrawerOpen` true, so the collection debug drawer
  // stayed open — and kept issuing chunk/coverage queries — against the
  // database the reset had just emptied.
  resetDatabaseDemoStoreToDefault();
});

registerFactoryResetSessionStore(() => {
  useTerminalTargetStore.getState().reset();
});
