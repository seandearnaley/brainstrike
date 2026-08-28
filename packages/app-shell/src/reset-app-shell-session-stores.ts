import { resetDiagnosticSinkHealthStore } from './diagnostics/diagnostic-sink-health-store';
import { resetDiagnosticsSeenStore } from './diagnostics/diagnostics-seen-store';
import { useCommandPaletteStore } from './stores/command-palette-store';
import { useQuickOpenStore } from './stores/quick-open-store';
import { useWorktreeCheckoutIntentStore } from './stores/worktree-checkout-intent-store';
import { resetThreadSearchStore } from './thread-search-store';

/**
 * Reset dependency-free app-shell session stores that tests can safely preload.
 *
 * This is the single authoritative list for both factory reset registration
 * and app-shell's Vitest beforeEach isolation. Component-coupled stores retain
 * explicit production registrations and focused test setup: preloading them
 * here would bind their dependencies before test modules can install mocks.
 */
export function resetAppShellSessionStores(): void {
  resetDiagnosticSinkHealthStore();
  resetDiagnosticsSeenStore();
  useCommandPaletteStore.getState().close();
  useQuickOpenStore.getState().close();
  useWorktreeCheckoutIntentStore.getState().reset();
  resetThreadSearchStore();
}
