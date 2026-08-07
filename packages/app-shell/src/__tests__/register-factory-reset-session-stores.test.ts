import { clearPersistentUiStateWithResult } from '@brainstrike/app-state/factory-reset';
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
import { useAssistantThreadGroupsStore } from '../assistant-thread-groups-store';
import { useChangesNavigationStore } from '../changes/changes-navigation-store';
import { useChangesStore } from '../changes/changes-store';
import { useDiagnosticSinkHealthStore } from '../diagnostics/diagnostic-sink-health-store';
import { useDiagnosticsSeenStore } from '../diagnostics/diagnostics-seen-store';

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
});
