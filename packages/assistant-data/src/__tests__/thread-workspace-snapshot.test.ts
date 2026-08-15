import { describe, expect, it, vi } from 'vitest';
import {
  coerceWorkspaceSnapshot,
  EMPTY_WORKSPACE_SNAPSHOT,
  type WorkspaceSnapshotV1,
} from '../thread-workspace-snapshot';

function validSnapshot(): WorkspaceSnapshotV1 {
  return {
    apps: {
      openAppIds: ['context-explorer', 'changes'],
      selection: { appId: 'changes', kind: 'app' },
    },
    editors: {
      'folderA|@|src/a.ts': {
        mode: 'source',
        pane: { expandedPaths: ['src'], open: true, widthPct: 30 },
        scrollTop: 120,
      },
    },
    explorer: {
      byRoot: { 'root-1': { expandedPaths: ['src', 'src/components'] } },
      scrollTop: 40,
    },
    fileTabs: {
      activeTabId: 'folderA|@|src/a.ts',
      tabs: [{ compositeKey: 'folderA|@|src/a.ts', path: 'src/a.ts' }],
    },
    roots: { focusedRootId: 'root-1', visibleRootIds: null },
    version: 1,
  };
}

describe('coerceWorkspaceSnapshot', () => {
  it('round-trips a valid snapshot unchanged', () => {
    const snapshot = validSnapshot();
    expect(coerceWorkspaceSnapshot(snapshot)).toEqual(snapshot);
  });

  it('coerces garbage to the empty snapshot and logs', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(coerceWorkspaceSnapshot('garbage')).toEqual(EMPTY_WORKSPACE_SNAPSHOT);
      expect(coerceWorkspaceSnapshot(null)).toEqual(EMPTY_WORKSPACE_SNAPSHOT);
      expect(coerceWorkspaceSnapshot({ version: 999 })).toEqual(EMPTY_WORKSPACE_SNAPSHOT);
    } finally {
      warn.mockRestore();
    }
  });

  it('repairs partially malformed sections instead of dropping the whole snapshot', () => {
    const mangled = {
      ...validSnapshot(),
      editors: 'nope',
      fileTabs: { activeTabId: 42, tabs: [{ compositeKey: 'k', path: 'p' }, 'junk'] },
    };
    const coerced = coerceWorkspaceSnapshot(mangled);
    expect(coerced.editors).toEqual({});
    expect(coerced.fileTabs).toEqual({
      activeTabId: null,
      tabs: [{ compositeKey: 'k', path: 'p' }],
    });
    // Untouched sections survive.
    expect(coerced.apps).toEqual(validSnapshot().apps);
  });

  it('caps expansions at 100 per root, shallowest-first', () => {
    // 150 unique paths, 10 at each depth 1..15 — the cap keeps depths 1..10.
    const deepPaths = Array.from({ length: 150 }, (_, i) =>
      [`p${i}`, ...Array.from({ length: i % 15 }, (_, d) => `d${d}`)].join('/')
    );
    const coerced = coerceWorkspaceSnapshot({
      ...validSnapshot(),
      explorer: { byRoot: { 'root-1': { expandedPaths: deepPaths } }, scrollTop: 0 },
    });
    const kept = coerced.explorer.byRoot['root-1']?.expandedPaths ?? [];
    expect(kept.length).toBe(100);
    const depth = (p: string) => p.split('/').length;
    const maxKept = Math.max(...kept.map(depth));
    const minDropped = Math.min(...deepPaths.filter((p) => !kept.includes(p)).map(depth));
    expect(maxKept).toBeLessThanOrEqual(minDropped);
  });

  it('caps pane expansions at 50', () => {
    const coerced = coerceWorkspaceSnapshot({
      ...validSnapshot(),
      editors: {
        k1: {
          pane: {
            expandedPaths: Array.from({ length: 80 }, (_, i) => `p${i}`),
            open: true,
          },
        },
      },
    });
    expect(coerced.editors['k1']?.pane?.expandedPaths?.length).toBe(50);
  });

  it('drops non-string ids and duplicate app ids', () => {
    const coerced = coerceWorkspaceSnapshot({
      ...validSnapshot(),
      apps: { openAppIds: ['a', 'a', 7, 'b'], selection: { kind: 'empty' } },
    });
    expect(coerced.apps.openAppIds).toEqual(['a', 'b']);
    expect(coerced.apps.selection).toEqual({ kind: 'empty' });
  });
});
