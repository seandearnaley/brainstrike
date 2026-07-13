import { useWorkspaceContextCurationStore } from '@brainstrike/file-explorer-ui/workspace-context-curation-store';
import { clearPersistentUiStateWithResult } from '@brainstrike/preferences/settings/system/factory-reset-helpers';
import {
  resetContextUsageStore,
  useContextUsageStore,
} from '@brainstrike/ui/assistant-ui-panel/context-usage-store';
import { useChunkSelectionStore } from '@brainstrike/workspace-search/chunk-selection-store';
import { useWorkspaceSearchStore } from '@brainstrike/workspace-search/workspace-search-store';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import { useAssistantThreadGroupsStore } from '../assistant-thread-groups-store';

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
});
