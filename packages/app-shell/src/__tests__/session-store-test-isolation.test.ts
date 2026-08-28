import { describe, expect, it } from 'vitest';
import { useDiagnosticSinkHealthStore } from '../diagnostics/diagnostic-sink-health-store';
import { useCommandPaletteStore } from '../stores/command-palette-store';
import { useQuickOpenStore } from '../stores/quick-open-store';
import { useWorktreeCheckoutIntentStore } from '../stores/worktree-checkout-intent-store';
import { useThreadSearchStore } from '../thread-search-store';

describe.sequential('app-shell session-store test isolation', () => {
  it('allows one test to mutate session-scoped stores', () => {
    useDiagnosticSinkHealthStore.getState().markDisabled('previous test failure');
    useThreadSearchStore.getState().setQuery('stale search');
    useCommandPaletteStore.getState().open();
    useQuickOpenStore.getState().open();
    useWorktreeCheckoutIntentStore.getState().publish({
      branch: 'codex/stale',
      path: '/tmp/stale-worktree',
      threadId: 'thread-stale',
      worktreeId: 'worktree-stale',
    });

    expect(useDiagnosticSinkHealthStore.getState().disabledReason).not.toBeNull();
    expect(useThreadSearchStore.getState().query).toBe('stale search');
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
    expect(useQuickOpenStore.getState().isOpen).toBe(true);
    expect(useWorktreeCheckoutIntentStore.getState().pending).not.toBeNull();
  });

  it('starts the next test with every registered session store reset', () => {
    expect(useDiagnosticSinkHealthStore.getState().disabledReason).toBeNull();
    expect(useThreadSearchStore.getState().query).toBe('');
    expect(useCommandPaletteStore.getState()).toMatchObject({
      isOpen: false,
      openTarget: null,
    });
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
    expect(useWorktreeCheckoutIntentStore.getState().pending).toBeNull();
  });
});
