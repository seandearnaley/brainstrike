import { clearPersistentUiStateWithResult } from '@brainstrike/app-state/factory-reset';
import {
  resetAssistantThreadStore,
  useAssistantThreadGroupsStore,
  useAssistantThreadStore,
} from '@brainstrike/assistant-data';
import {
  resetContextUsageStore,
  useContextUsageStore,
} from '@brainstrike/assistant-ui/context-usage-store';
import { useWorkspaceContextCurationStore } from '@brainstrike/file-explorer-ui/workspace-context-curation-store';
import { resetNotesVaultSessionState } from '@brainstrike/notes-vault/store-reset';
import { useChunkSelectionStore } from '@brainstrike/workspace-search/chunk-selection-store';
import { useWorkspaceSearchStore } from '@brainstrike/workspace-search/workspace-search-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import type { BrowserTab } from '../browser-pane/browser-bridge';
import { useBrowserTabsStore } from '../browser-pane/browser-tabs-store';
import { useChangesNavigationStore } from '../changes/changes-navigation-store';
import { useChangesStore } from '../changes/changes-store';
import { useDiagnosticSinkHealthStore } from '../diagnostics/diagnostic-sink-health-store';
import { useDiagnosticsSeenStore } from '../diagnostics/diagnostics-seen-store';
import {
  awaitRootRegistration,
  notifyRootRegistered,
  resetRootRegistrationEventsForTests,
  rootRegistrationSeq,
} from '../roots/root-registration-events';
import { useCommandPaletteStore } from '../stores/command-palette-store';
import { useOnScreenThreadStore } from '../stores/on-screen-thread-store';
import { useQuickOpenStore } from '../stores/quick-open-store';
import { useTerminalTargetStore } from '../stores/terminal-target-store';
import { useWorktreeCheckoutIntentStore } from '../stores/worktree-checkout-intent-store';

// The real notes-vault store's default services require indexedDB (handle
// persistence), which this vitest environment does not provide. The reset
// entry point is mocked so registration can be asserted without booting the
// vault store graph.
vi.mock('@brainstrike/notes-vault/store-reset', () => ({
  resetNotesVaultSessionState: vi.fn(),
}));

// Import for side-effect registration (same path root-layout-content uses).
import '../register-factory-reset-session-stores';

describe('register-factory-reset-session-stores', () => {
  beforeEach(() => {
    useWorkspaceSearchStore.getState().reset();
    useChunkSelectionStore.getState().clearAll();
    resetContextUsageStore();
    useWorkspaceContextCurationStore.getState().reset();
    useAssistantComposerCommandStore.getState().reset();
    useAssistantThreadGroupsStore.getState().reset();
    resetAssistantThreadStore();
    useBrowserTabsStore.getState().reset();
    resetRootRegistrationEventsForTests();
    vi.mocked(resetNotesVaultSessionState).mockClear();
  });

  it('registers the notes-vault session reset with the factory-reset pipeline', async () => {
    expect(resetNotesVaultSessionState).not.toHaveBeenCalled();

    const result = await clearPersistentUiStateWithResult({ skipIndexedDb: true });
    expect(result.success).toBe(true);

    expect(resetNotesVaultSessionState).toHaveBeenCalledTimes(1);
  });

  it('clears sibling session stores when factory reset drains registered resetters', async () => {
    useWorkspaceSearchStore.getState().setQuery('find me');
    useChunkSelectionStore.getState().addChunk('root|@|src/a.ts', {
      chunkId: 'c1',
      endLine: 10,
      startLine: 1,
    });
    useContextUsageStore.getState().recordUsage('thread-1', {
      inputTokens: 100,
      outputTokens: 20,
    });
    useWorkspaceContextCurationStore.getState().setContextSnapshot({
      files: [],
      includeProjectTree: false,
      projectTreeApproxTokens: null,
      projectTreeTokenCountLoading: false,
      selectedOutputApproxTokens: null,
      selectedSourceApproxTokens: null,
      selectionFolderId: 'folder-a',
      tokenBudget: null,
    });
    useWorkspaceContextCurationStore
      .getState()
      .setTapestryRangesForKey('folder-a::src/a.ts', [
        { color: '#2563eb', endLine: 3, id: 'r1', isActive: true, startLine: 1 },
      ]);
    useAssistantComposerCommandStore.getState().recordDraft('thread-1', 'private draft');
    useAssistantComposerCommandStore.getState().enqueue({
      mode: 'append',
      text: 'queued snippet',
      threadId: 'thread-1',
    });
    useAssistantThreadGroupsStore.setState({
      flatSortBy: 'name',
      groupedSortBy: 'custom',
      groupsByResourceId: {
        'workspace-a': [
          {
            color: null,
            icon: null,
            id: 'group-1',
            name: 'Research',
            rank: 'a0',
            resourceId: 'workspace-a',
          },
        ],
      },
    });
    useAssistantThreadGroupsStore.getState().toggleGroupCollapsed('group-1');
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: { 'workspace-a': 'thread-1' },
      draftRuntimeByThreadId: { 'thread-1': { model: 'gpt-5.2', provider: 'openai' } },
      openThreadIdsByResourceId: { 'workspace-a': ['thread-1'] },
      selectedThreadByResourceId: { 'workspace-a': 'thread-1' },
    });
    useTerminalTargetStore.getState().openTerminalAt({ cwd: '/wt', rootId: 'r-1' });
    useCommandPaletteStore.getState().open({ tabScope: 'assistant-threads' });
    useQuickOpenStore.getState().open();
    useOnScreenThreadStore.getState().setOnScreenThreadId('thread-1');
    useWorktreeCheckoutIntentStore.getState().publish({
      branch: 'codex/reset-me',
      path: '/wt',
      threadId: 'thread-1',
      worktreeId: 'worktree-1',
    });
    const browserTab: BrowserTab = {
      active: true,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      tabId: 'browser-tab-1',
      title: 'Before reset',
      url: 'https://example.com',
    };
    useBrowserTabsStore.getState().setTabs([browserTab]);

    expect(useWorkspaceSearchStore.getState().query).toBe('find me');
    expect(useChunkSelectionStore.getState().selectionsByKey['root|@|src/a.ts']).toBeDefined();
    expect(useContextUsageStore.getState().usageByThread['thread-1']).toBeDefined();
    expect(useWorkspaceContextCurationStore.getState().contextSnapshot).not.toBeNull();
    expect(
      useWorkspaceContextCurationStore.getState().tapestryRangesByKey['folder-a::src/a.ts']
    ).toBeDefined();
    expect(useAssistantComposerCommandStore.getState().draftTextByThreadId).toEqual({
      'thread-1': 'private draft',
    });
    expect(useAssistantComposerCommandStore.getState().commandsByThreadId['thread-1']).toHaveLength(
      1
    );

    const result = await clearPersistentUiStateWithResult({ skipIndexedDb: true });
    expect(result.success).toBe(true);

    expect(useWorkspaceSearchStore.getState().query).toBe('');
    expect(useChunkSelectionStore.getState().selectionsByKey).toEqual({});
    expect(useContextUsageStore.getState().usageByThread).toEqual({});
    expect(useWorkspaceContextCurationStore.getState().contextSnapshot).toBeNull();
    expect(useWorkspaceContextCurationStore.getState().tapestryRangesByKey).toEqual({});
    expect(useAssistantComposerCommandStore.getState().draftTextByThreadId).toEqual({});
    expect(useAssistantComposerCommandStore.getState().commandsByThreadId).toEqual({});
    expect(useAssistantThreadGroupsStore.getState().groupsByResourceId).toEqual({});
    expect(useAssistantThreadGroupsStore.getState().collapsedGroupIds).toEqual({});
    expect(useAssistantThreadGroupsStore.getState().flatSortBy).toBe('recency');
    expect(useAssistantThreadGroupsStore.getState().groupedSortBy).toBe('recency');
    expect(useAssistantThreadStore.getState().activeThreadIdByResourceId).toEqual({});
    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId).toEqual({});
    expect(useAssistantThreadStore.getState().openThreadIdsByResourceId).toEqual({});
    expect(useAssistantThreadStore.getState().selectedThreadByResourceId).toEqual({});
    expect(useTerminalTargetStore.getState().target).toBeNull();
    expect(useCommandPaletteStore.getState()).toMatchObject({
      isOpen: false,
      openTarget: null,
      tabScope: null,
    });
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
    expect(useOnScreenThreadStore.getState().onScreenThreadId).toBeNull();
    expect(useWorktreeCheckoutIntentStore.getState().pending).toBeNull();
    expect(useBrowserTabsStore.getState().tabs).toEqual([]);
  });

  it('keeps later app-shell resets isolated when one registered store throws', async () => {
    const originalClose = useCommandPaletteStore.getState().close;
    useCommandPaletteStore.setState({
      close: () => {
        throw new Error('command palette reset failed');
      },
    });
    useQuickOpenStore.getState().open();
    useWorktreeCheckoutIntentStore.getState().publish({
      branch: 'codex/reset-after-failure',
      path: '/wt',
      threadId: 'thread-1',
      worktreeId: 'worktree-1',
    });

    try {
      const result = await clearPersistentUiStateWithResult({ skipIndexedDb: true });
      expect(result.success).toBe(true);
      expect(useQuickOpenStore.getState().isOpen).toBe(false);
      expect(useWorktreeCheckoutIntentStore.getState().pending).toBeNull();
    } finally {
      useCommandPaletteStore.setState({ close: originalClose });
    }
  });

  // The two diagnostics session stores get their own case rather than riding
  // along above: without it, DELETING both `registerFactoryResetSessionStore`
  // blocks for them would leave every test on the branch green, silently
  // breaking the "any new session store must be wired into factory reset"
  // contract. Their own unit tests only prove the reset FUNCTIONS work, not
  // that anything calls them.
  it('clears both diagnostics session stores when factory reset drains registered resetters', async () => {
    const staleWatermark = Date.now() - 60 * 60 * 1000;
    useDiagnosticsSeenStore.setState({ lastSeenAtMs: staleWatermark });
    useDiagnosticSinkHealthStore.getState().markDisabled('sink exploded');

    expect(useDiagnosticSinkHealthStore.getState().disabledReason).toBe('sink exploded');

    const result = await clearPersistentUiStateWithResult({ skipIndexedDb: true });
    expect(result.success).toBe(true);

    expect(useDiagnosticSinkHealthStore.getState().disabledReason).toBeNull();
    // The watermark is RE-SEEDED to "now", not restored to a fixed initial
    // value, so the assertion is that it advanced past the stale value.
    expect(useDiagnosticsSeenStore.getState().lastSeenAtMs).toBeGreaterThan(staleWatermark);
  });

  // Its own case for the same reason as the diagnostics stores above: without
  // it, deleting the two Changes-surface `registerFactoryResetSessionStore`
  // blocks would leave every other test on the branch green.
  it('clears both Changes-surface session stores when factory reset drains registered resetters', async () => {
    useChangesNavigationStore.setState({
      activeChangeset: { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' },
      handoffThreadIdentity: { latestRunId: 'run-1', threadId: 'thread-1' },
    });
    useChangesStore.getState().setSelectedFileKeys(new Set(['root-1  src/a.ts']));
    useChangesStore.getState().setExpandedIds(new Set(['root:root-1']));

    expect(useChangesNavigationStore.getState().activeChangeset).not.toBeNull();
    expect(useChangesStore.getState().selectedFileKeys.size).toBeGreaterThan(0);

    const result = await clearPersistentUiStateWithResult({ skipIndexedDb: true });
    expect(result.success).toBe(true);

    expect(useChangesNavigationStore.getState().activeChangeset).toBeNull();
    expect(useChangesNavigationStore.getState().handoffThreadIdentity).toBeNull();
    expect(useChangesStore.getState().selectedFileKeys).toEqual(new Set());
    expect(useChangesStore.getState().hasExplicitSelection).toBe(false);
    expect(useChangesStore.getState().expandedIds).toEqual(new Set());
  });

  // BST-1400 (review Important #1/#2): `root-registration-events.ts` is
  // DELIBERATELY not registered above — see its module docblock and
  // `docs/agents/platform-contracts.md` § FACTORY RESET CONTRACT for why
  // wiring one would introduce a mid-session regression. This is the pin an
  // auditor of that contract needs: it drives the REAL reset pipeline (not
  // the test-only `resetRootRegistrationEventsForTests` helper, which is a
  // cross-test isolation seam, not a stand-in for what a reset actually
  // does) and proves the module's counters survive it untouched, and that a
  // wait captured with the surviving (stale) generation still correctly
  // requires a NEW registration rather than treating the pre-reset fact as
  // sufficient.
  it('leaves root-registration-events untouched — it is deliberately NOT wired into factory reset', async () => {
    notifyRootRegistered(['/ws/docs']);
    const preResetSeq = rootRegistrationSeq('/ws/docs');
    expect(preResetSeq).toBe(1);

    const result = await clearPersistentUiStateWithResult({ skipIndexedDb: true });
    expect(result.success).toBe(true);

    // The real reset pipeline ran every registered resetter above and left
    // this counter exactly as it was — proving by construction (not by
    // reading the docblock's claim) that this module sits outside it.
    expect(rootRegistrationSeq('/ws/docs')).toBe(preResetSeq);

    // And the surviving (stale) generation is still honestly stale: a waiter
    // that captures it as `since` AFTER the reset must not resolve off the
    // pre-reset registration — only a genuinely new one satisfies it.
    vi.useFakeTimers();
    const waiter = awaitRootRegistration('/ws/docs', { since: preResetSeq, timeoutMs: 5000 });
    let settled = false;
    void waiter.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    notifyRootRegistered(['/ws/docs']); // the post-reset re-add's registration
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    vi.useRealTimers();
  });
});
