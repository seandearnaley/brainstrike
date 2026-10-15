import { registerFactoryResetSessionStore } from '@brainstrike/app-state/factory-reset';
import {
  resetAssistantThreadStore,
  useAssistantThreadGroupsStore,
} from '@brainstrike/assistant-data';
import { resetContextUsageStore } from '@brainstrike/assistant-ui/context-usage-store';
import { resetFollowUpQueueStore } from '@brainstrike/assistant-ui/follow-up-queue-store';
import { useRewindComposerStore } from '@brainstrike/assistant-ui/rewind-composer-store';
import { resetThreadContextStore } from '@brainstrike/assistant-ui/thread-context-store';
import { resetDatabaseDemoStoreToDefault } from '@brainstrike/db-explorer/database-demo-store';
import { useTabManagerStore } from '@brainstrike/file-explorer-ui/tab-manager-store';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { resetNotesVaultSessionState } from '@brainstrike/notes-vault/store-reset';
import { useWorkspaceSearchStore } from '@brainstrike/workspace-search/workspace-search-store';
import { useChangesLiveRefreshStore } from './changes/changes-live-refresh-store';
import { useChangesNavigationStore } from './changes/changes-navigation-store';
import { useChangesStore } from './changes/changes-store';
import { useRewindStore } from './changes/rewind-store';
import { APP_SHELL_SESSION_STORE_RESETTERS } from './reset-app-shell-session-stores';
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
for (const reset of APP_SHELL_SESSION_STORE_RESETTERS) {
  registerFactoryResetSessionStore(reset);
}

registerFactoryResetSessionStore(resetAssistantThreadStore);

registerFactoryResetSessionStore(() => {
  useWorkspaceSearchStore.getState().reset();
});

registerFactoryResetSessionStore(() => {
  resetContextUsageStore();
});

registerFactoryResetSessionStore(() => {
  // Derived per-thread context map snapshots (ADR-0021); refolded from the log.
  resetThreadContextStore();
});

registerFactoryResetSessionStore(() => {
  // Queued-but-unsent follow-up messages must never survive a reset.
  resetFollowUpQueueStore();
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
  // Without this, `activeChangeset`/`handoffThreadIdentity` would keep
  // pointing at a runId/threadId or repository path the reset just wiped.
  useChangesNavigationStore.getState().reset();
});

registerFactoryResetSessionStore(() => {
  // Selection/expansion are view-only, but a selection carried over past a
  // reset can filter every file out of a diff pane that no longer exists.
  useChangesStore.getState().reset();
});

registerFactoryResetSessionStore(() => {
  // Invalidation nonces name absolute repository paths; the wire-generation
  // guard also restarts so a post-reset main process re-numbering from 1 is
  // not dropped (BST-1161).
  useChangesLiveRefreshStore.getState().reset();
});

registerFactoryResetSessionStore(() => {
  // An open Conversation Rewind request names a thread/message/run the reset
  // just wiped; leaving it up would show a confirm modal for a conversation
  // that no longer exists.
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
  // A pinned Terminal target names an absolute checkout path and a rootId the
  // reset just wiped; leaving it would point the panel at a folder that no
  // longer exists in this profile.
  useTerminalTargetStore.getState().reset();
});
