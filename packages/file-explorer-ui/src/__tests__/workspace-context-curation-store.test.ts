// @vitest-environment node
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

  it('reset clears both the snapshot and tapestry ranges', () => {
    useWorkspaceContextCurationStore.getState().setContextSnapshot(createSnapshot('folder-a'));
    useWorkspaceContextCurationStore
      .getState()
      .setTapestryRangesForKey('folder-a::src/app.ts', [createRange()]);

    useWorkspaceContextCurationStore.getState().reset();

    expect(useWorkspaceContextCurationStore.getState().contextSnapshot).toBeNull();
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

  it('deletes the key when set with an empty range list (empty ≡ absent, no `[]` residue)', () => {
    const KEY = 'folder::src/app.ts';
    useWorkspaceContextCurationStore.getState().setTapestryRangesForKey(KEY, [createRange()]);
    expect(KEY in useWorkspaceContextCurationStore.getState().tapestryRangesByKey).toBe(true);

    // Writing [] must DELETE the key, never store a present-but-empty array —
    // the whole-file invariant relies on absence, not `[]`.
    useWorkspaceContextCurationStore.getState().setTapestryRangesForKey(KEY, []);

    const map = useWorkspaceContextCurationStore.getState().tapestryRangesByKey;
    expect(KEY in map).toBe(false);
    expect(map).toEqual({});
  });

  it('leaves other keys intact when deleting one key via an empty write', () => {
    const KEEP = 'folder::src/keep.ts';
    const DROP = 'folder::src/drop.ts';
    useWorkspaceContextCurationStore.getState().setTapestryRangesForKey(KEEP, [createRange()]);
    useWorkspaceContextCurationStore.getState().setTapestryRangesForKey(DROP, [createRange()]);

    useWorkspaceContextCurationStore.getState().setTapestryRangesForKey(DROP, []);

    expect(useWorkspaceContextCurationStore.getState().tapestryRangesByKey).toEqual({
      [KEEP]: [createRange()],
    });
  });

  it('is a no-op (stable identity) when an empty write targets an already-absent key', () => {
    const before = useWorkspaceContextCurationStore.getState().tapestryRangesByKey;

    useWorkspaceContextCurationStore.getState().setTapestryRangesForKey('folder::missing.ts', []);

    // No spurious new object: absence stays absence.
    expect(useWorkspaceContextCurationStore.getState().tapestryRangesByKey).toBe(before);
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

describe('setTapestryRanges empty ≡ absent normalization (whole-map setter)', () => {
  it('drops keys with empty arrays from a functional update', () => {
    const store = useWorkspaceContextCurationStore;
    store
      .getState()
      .setTapestryRangesForKey('root|@|a.ts', [
        { color: '#fff', endLine: 5, id: 'r1', isActive: true, startLine: 1 },
      ]);
    store.getState().setTapestryRanges((prev) => ({ ...prev, 'root|@|a.ts': [] }));
    expect(store.getState().tapestryRangesByKey).not.toHaveProperty('root|@|a.ts');
  });

  it('drops empty-array keys from a direct map write while keeping non-empty ones', () => {
    const store = useWorkspaceContextCurationStore;
    store.getState().setTapestryRanges({
      'root|@|empty.ts': [],
      'root|@|kept.ts': [{ color: '#fff', endLine: 3, id: 'r2', isActive: true, startLine: 1 }],
    });
    const map = store.getState().tapestryRangesByKey;
    expect(map).not.toHaveProperty('root|@|empty.ts');
    expect(map['root|@|kept.ts']).toHaveLength(1);
  });
});
