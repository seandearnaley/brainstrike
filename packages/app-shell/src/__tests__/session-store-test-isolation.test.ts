import { beforeAll, describe, expect, it } from 'vitest';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import type { BrowserTab } from '../browser-pane/browser-bridge';
import { useBrowserTabsStore } from '../browser-pane/browser-tabs-store';
import { useDiagnosticSinkHealthStore } from '../diagnostics/diagnostic-sink-health-store';
import { useCommandPaletteStore } from '../stores/command-palette-store';
import { useQuickOpenStore } from '../stores/quick-open-store';
import { useWorktreeCheckoutIntentStore } from '../stores/worktree-checkout-intent-store';
import { useThreadSearchStore } from '../thread-search-store';

describe('app-shell session-store test isolation', () => {
  beforeAll(() => {
    useAssistantComposerCommandStore.getState().recordDraft('thread-stale', 'stale draft');
    useAssistantComposerCommandStore.getState().enqueue({
      mode: 'append',
      text: 'stale command',
      threadId: 'thread-stale',
    });
    const browserTab: BrowserTab = {
      active: true,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      tabId: 'stale-tab',
      title: 'Stale tab',
      url: 'https://example.com',
    };
    useBrowserTabsStore.getState().setTabs([browserTab]);
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
  });

  it('starts a test with every registered session store reset', () => {
    expect(useAssistantComposerCommandStore.getState().draftTextByThreadId).toEqual({});
    expect(useAssistantComposerCommandStore.getState().commandsByThreadId).toEqual({});
    expect(useBrowserTabsStore.getState().tabs).toEqual([]);
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
