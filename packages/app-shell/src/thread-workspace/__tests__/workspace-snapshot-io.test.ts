import { EMPTY_WORKSPACE_SNAPSHOT } from '@brainstrike/assistant-data';
import { describe, expect, it, vi } from 'vitest';
import {
  applyWorkspaceSnapshot,
  captureWorkspaceSnapshot,
  type WorkspaceStateFacade,
} from '../workspace-snapshot-io';

function createFakeFacade(overrides: Partial<WorkspaceStateFacade> = {}): WorkspaceStateFacade {
  return {
    applyApps: vi.fn(),
    applyEditorState: vi.fn(),
    applyExpandedPaths: vi.fn(),
    applyExplorerScrollTop: vi.fn(),
    applyFileTabs: vi.fn(),
    applyPanes: vi.fn(),
    applyRootViews: vi.fn(),
    closeApps: vi.fn(),
    getEditorState: vi.fn(() => ({})),
    getExpandedDirectoryPaths: vi.fn(() => new Set<string>()),
    getExplorerScrollTop: vi.fn(() => undefined),
    getFileTabs: vi.fn(() => ({ activeTabId: null, tabs: [] })),
    getFocusedRootId: vi.fn(() => null),
    getOpenAppIds: vi.fn(() => [] as readonly string[]),
    getRootDescriptors: vi.fn(() => ({})),
    getSelection: vi.fn(() => ({ kind: 'empty' }) as const),
    getVisibleRootIds: vi.fn(() => null),
    ...overrides,
  };
}

describe('captureWorkspaceSnapshot', () => {
  it('captures apps, tabs, root views, and per-open-tab editor state', () => {
    const facade = createFakeFacade({
      getEditorState: vi.fn((key: string) =>
        key === 'folderA|@|src/a.ts' ? { mode: 'source' as const, scrollTop: 42 } : {}
      ),
      getFileTabs: () => ({
        activeTabId: 'folderA|@|src/a.ts',
        tabs: [
          { compositeKey: 'folderA|@|src/a.ts', path: 'src/a.ts' },
          { compositeKey: 'folderA|@|src/b.ts', path: 'src/b.ts' },
        ],
      }),
      getFocusedRootId: () => 'root-1',
      getOpenAppIds: () => ['context-explorer'],
      getSelection: () => ({ appId: 'context-explorer', kind: 'app' }) as const,
      getVisibleRootIds: () => ['root-1', 'root-2'],
    });

    const snapshot = captureWorkspaceSnapshot(facade);

    expect(snapshot.version).toBe(1);
    expect(snapshot.apps).toEqual({
      openAppIds: ['context-explorer'],
      selection: { appId: 'context-explorer', kind: 'app' },
    });
    expect(snapshot.fileTabs.tabs).toHaveLength(2);
    expect(snapshot.fileTabs.activeTabId).toBe('folderA|@|src/a.ts');
    expect(snapshot.roots).toEqual({
      focusedRootId: 'root-1',
      visibleRootIds: ['root-1', 'root-2'],
    });
    expect(snapshot.editors['folderA|@|src/a.ts']).toEqual({ mode: 'source', scrollTop: 42 });
    // Editors are pruned to OPEN tabs — no stray keys.
    expect(Object.keys(snapshot.editors).sort()).toEqual([
      'folderA|@|src/a.ts',
      'folderA|@|src/b.ts',
    ]);
  });

  it('partitions expansions by root via longest-prefix, leftovers under the unscoped bucket', () => {
    const facade = createFakeFacade({
      getExpandedDirectoryPaths: () =>
        new Set(['/repo/a/src', '/repo/a/src/components', '/repo/b/docs', 'relative/orphan']),
      getRootDescriptors: () => ({
        'root-a': { path: '/repo/a' },
        'root-b': { path: '/repo/b' },
      }),
    });

    const snapshot = captureWorkspaceSnapshot(facade);

    expect([...(snapshot.explorer.byRoot['root-a']?.expandedPaths ?? [])].sort()).toEqual([
      '/repo/a/src',
      '/repo/a/src/components',
    ]);
    expect(snapshot.explorer.byRoot['root-b']?.expandedPaths).toEqual(['/repo/b/docs']);
    expect(snapshot.explorer.byRoot['']?.expandedPaths).toEqual(['relative/orphan']);
  });
});

describe('applyWorkspaceSnapshot', () => {
  it('applies every section and hands a FRESH Set of unioned expansions', () => {
    const facade = createFakeFacade();
    const snapshot = {
      ...EMPTY_WORKSPACE_SNAPSHOT,
      apps: {
        openAppIds: ['context-explorer', 'changes'],
        selection: { appId: 'changes', kind: 'app' } as const,
      },
      editors: { k1: { mode: 'preview' as const, scrollTop: 7 } },
      explorer: {
        byRoot: { '': { expandedPaths: ['x'] }, 'root-a': { expandedPaths: ['/repo/a/src'] } },
        scrollTop: 99,
      },
      fileTabs: { activeTabId: 'k1', tabs: [{ compositeKey: 'k1', path: 'a.ts' }] },
      roots: { focusedRootId: 'root-a', visibleRootIds: null },
    };

    applyWorkspaceSnapshot(snapshot, facade);

    expect(facade.applyApps).toHaveBeenCalledWith(['context-explorer', 'changes'], {
      appId: 'changes',
      kind: 'app',
    });
    expect(facade.applyFileTabs).toHaveBeenCalledWith([{ compositeKey: 'k1', path: 'a.ts' }], 'k1');
    const applied = vi.mocked(facade.applyExpandedPaths).mock.calls[0]?.[0];
    expect(applied).toBeInstanceOf(Set);
    expect([...(applied ?? [])].sort()).toEqual(['/repo/a/src', 'x']);
    expect(facade.applyExplorerScrollTop).toHaveBeenCalledWith(99);
    expect(facade.applyRootViews).toHaveBeenCalledWith('root-a', null);
    expect(facade.applyEditorState).toHaveBeenCalledWith('k1', { mode: 'preview', scrollTop: 7 });
  });

  it('replaces pane state WHOLESALE from the editors section (per-thread isolation)', () => {
    const facade = createFakeFacade();
    const snapshot = {
      ...EMPTY_WORKSPACE_SNAPSHOT,
      editors: {
        k1: {
          mode: 'source' as const,
          pane: { expandedPaths: ['/r/src'], open: true, widthPct: 25 },
        },
        k2: { scrollTop: 3 },
      },
    };

    applyWorkspaceSnapshot(snapshot, facade);

    // ONE wholesale call — keys absent here (previous thread's panes) must be
    // dropped by the receiving store, so per-key application would be a bug.
    expect(facade.applyPanes).toHaveBeenCalledExactlyOnceWith({
      k1: { expandedPaths: ['/r/src'], open: true, widthPct: 25 },
    });
  });

  it('applying the empty snapshot clears panes too', () => {
    const facade = createFakeFacade();
    applyWorkspaceSnapshot(EMPTY_WORKSPACE_SNAPSHOT, facade);
    expect(facade.applyPanes).toHaveBeenCalledExactlyOnceWith({});
  });

  it('applying the empty snapshot clears to launcher state', () => {
    const facade = createFakeFacade();
    applyWorkspaceSnapshot(EMPTY_WORKSPACE_SNAPSHOT, facade);
    expect(facade.applyApps).toHaveBeenCalledWith([], { kind: 'empty' });
    expect(facade.applyFileTabs).toHaveBeenCalledWith([], null);
    const clearedExpansions = vi.mocked(facade.applyExpandedPaths).mock.calls[0]?.[0];
    expect(clearedExpansions).toBeInstanceOf(Set);
    expect(clearedExpansions?.size).toBe(0);
    expect(facade.applyExplorerScrollTop).toHaveBeenCalledWith(undefined);
  });

  it('capture→apply round-trips through coercion-stable shapes', () => {
    const source = createFakeFacade({
      getExpandedDirectoryPaths: () => new Set(['/r/x']),
      getFileTabs: () => ({
        activeTabId: 'k',
        tabs: [{ compositeKey: 'k', path: 'x.ts' }],
      }),
      getOpenAppIds: () => ['context-explorer'],
      getRootDescriptors: () => ({ r1: { path: '/r' } }),
      getSelection: () => ({ kind: 'file', tabId: 'k' }) as const,
    });
    const snapshot = captureWorkspaceSnapshot(source);

    const target = createFakeFacade();
    applyWorkspaceSnapshot(snapshot, target);
    expect(target.applyFileTabs).toHaveBeenCalledWith([{ compositeKey: 'k', path: 'x.ts' }], 'k');
    expect(target.applyApps).toHaveBeenCalledWith(['context-explorer'], {
      kind: 'file',
      tabId: 'k',
    });
    expect([...(vi.mocked(target.applyExpandedPaths).mock.calls[0]?.[0] ?? [])]).toEqual(['/r/x']);
  });
});
