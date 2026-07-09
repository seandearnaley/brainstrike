import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceContextCurationStore } from '../workspace-context-curation-store';

function createSnapshot(selectionFolderId: string | null) {
  return {
    files: [],
    includeProjectTree: false,
    projectTreeApproxTokens: null,
    projectTreeTokenCountLoading: false,
    selectedOutputApproxTokens: null,
    selectedSourceApproxTokens: null,
    selectionFolderId,
    tokenBudget: null,
    useTapestryRanges: true,
  };
}

function createRange() {
  return { color: '#2563eb', endLine: 3, id: 'r1', isActive: true, startLine: 1 };
}

describe('workspace context curation store', () => {
  beforeEach(() => {
    useWorkspaceContextCurationStore.setState({
      contextSnapshot: null,
      tapestryRangesByKey: {},
    });
  });

  it('clears tapestry ranges explicitly', () => {
    useWorkspaceContextCurationStore
      .getState()
      .setTapestryRangesForKey('folder::src/app.ts', [createRange()]);

    useWorkspaceContextCurationStore.getState().clearTapestryRanges();

    expect(useWorkspaceContextCurationStore.getState().tapestryRangesByKey).toEqual({});
  });

  it('keeps tapestry ranges set before the first snapshot (session init, not a folder change)', () => {
    useWorkspaceContextCurationStore
      .getState()
      .setTapestryRangesForKey('folder-a::src/app.ts', [createRange()]);

    useWorkspaceContextCurationStore.getState().setContextSnapshot(createSnapshot('folder-a'));

    expect(useWorkspaceContextCurationStore.getState().tapestryRangesByKey).toEqual({
      'folder-a::src/app.ts': [createRange()],
    });
  });

  it('prunes tapestry ranges when the selection folder changes', () => {
    useWorkspaceContextCurationStore.getState().setContextSnapshot(createSnapshot('folder-a'));
    useWorkspaceContextCurationStore
      .getState()
      .setTapestryRangesForKey('folder-a::src/app.ts', [createRange()]);

    useWorkspaceContextCurationStore.getState().setContextSnapshot(createSnapshot('folder-b'));

    expect(useWorkspaceContextCurationStore.getState().tapestryRangesByKey).toEqual({});
  });

  it('keeps tapestry ranges when the selection folder is unchanged', () => {
    useWorkspaceContextCurationStore.getState().setContextSnapshot(createSnapshot('folder-a'));
    useWorkspaceContextCurationStore
      .getState()
      .setTapestryRangesForKey('folder-a::src/app.ts', [createRange()]);

    useWorkspaceContextCurationStore.getState().setContextSnapshot(createSnapshot('folder-a'));

    expect(useWorkspaceContextCurationStore.getState().tapestryRangesByKey).toEqual({
      'folder-a::src/app.ts': [createRange()],
    });
  });
});
