import { useThreadFolderScopeStore } from '@brainstrike/file-explorer-ui/thread-folder-scope-store';
import { resetDiagnosticSinkHealthStore } from './diagnostics/diagnostic-sink-health-store';
import { resetDiagnosticsSeenStore } from './diagnostics/diagnostics-seen-store';
import { useCommandPaletteStore } from './stores/command-palette-store';
import { useOnScreenThreadStore } from './stores/on-screen-thread-store';
import { useQuickOpenStore } from './stores/quick-open-store';
import { useWorktreeCheckoutIntentStore } from './stores/worktree-checkout-intent-store';
import { resetThreadSearchStore } from './thread-search-store';

/**
 * Reset dependency-free app-shell session stores that tests can safely preload.
 *
 * This list is authoritative for both factory-reset registration and
 * app-shell's Vitest beforeEach isolation. Production registers each member
 * separately so one throwing resetter cannot prevent later stores from
 * clearing. Component-coupled stores retain explicit production registrations
 * and focused test setup: preloading them here would bind their dependencies
 * before test modules can install mocks.
 */
export const APP_SHELL_SESSION_STORE_RESETTERS: readonly (() => void)[] = [
  resetDiagnosticSinkHealthStore,
  resetDiagnosticsSeenStore,
  () => useAssistantComposerCommandStore.getState().reset(),
  () => useBrowserTabsStore.getState().reset(),
  () => useCommandPaletteStore.getState().close(),
  () => useOnScreenThreadStore.getState().reset(),
  () => useQuickOpenStore.getState().close(),
  () => useWorktreeCheckoutIntentStore.getState().reset(),
  () => useThreadFolderScopeStore.getState().reset(),
  resetThreadSearchStore,
];

export function resetAppShellSessionStores(): void {
  for (const reset of APP_SHELL_SESSION_STORE_RESETTERS) {
    reset();
  }
}

import { useAssistantComposerCommandStore } from './assistant-composer-command-store';
import { useBrowserTabsStore } from './browser-pane/browser-tabs-store';
