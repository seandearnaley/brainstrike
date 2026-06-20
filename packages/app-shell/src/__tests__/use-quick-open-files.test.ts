import type { FileExplorerState } from '@brainstrike/types';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const usePGliteLiveQueryMock = vi.fn();

vi.mock('@brainstrike/db', () => ({
  usePGliteLiveQuery: (options: unknown) => usePGliteLiveQueryMock(options),
  makeLiveQueryKey: (...parts: unknown[]) => parts.map((p) => String(p)).join(':'),
  QUICK_OPEN_MAX_LIMIT: 50,
  QUICK_OPEN_NAME_SEARCH_SQL: 'SELECT ... quick-open',
}));

// The hook reads activeRootIds + rootDescriptors from the store selector.
const storeState = {
  activeRootIds: [] as string[],
  rootDescriptors: {} as FileExplorerState['rootDescriptors'],
};

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreSelector: <T>(selector: (state: typeof storeState) => T): T =>
    selector(storeState),
}));

import { useQuickOpenFiles } from '../use-quick-open-files';

interface DbRow {
  display_name: string | null;
  id: string;
  name: string;
  path: string;
  root_id: string | null;
}

function mockRows(rows: DbRow[], loading = false): void {
  usePGliteLiveQueryMock.mockReturnValue({ rows, loading, error: null, refresh: vi.fn() });
}

function setRoots(
  activeRootIds: string[],
  rootDescriptors: FileExplorerState['rootDescriptors']
): void {
  storeState.activeRootIds = activeRootIds;
  storeState.rootDescriptors = rootDescriptors;
}

afterEach(() => {
  usePGliteLiveQueryMock.mockReset();
  setRoots([], {});
});

describe('useQuickOpenFiles', () => {
  it('derives the compositeKey from root_id + path (NOT path alone)', () => {
    setRoots(['root-a'], {
      'root-a': { rootId: 'root-a', displayName: 'Alpha', path: '/abs/alpha' },
    });
    mockRows([
      {
        id: 'f1',
        path: 'src/index.ts',
        name: 'index.ts',
        root_id: 'root-a',
        display_name: 'Alpha',
      },
    ]);

    const { result } = renderHook(() => useQuickOpenFiles('index'));

    expect(result.current.files).toHaveLength(1);
    // compositeKey is `${rootId}|@|${path}` — the open seam disambiguates by root.
    expect(result.current.files[0]?.compositeKey).toBe('root-a|@|src/index.ts');
    expect(result.current.files[0]?.rootLabel).toBe('Alpha');
  });

  it('opens the RIGHT root for the same path in two roots', () => {
    setRoots(['root-a', 'root-b'], {
      'root-a': { rootId: 'root-a', displayName: 'Alpha', path: '/abs/alpha' },
      'root-b': { rootId: 'root-b', displayName: 'Beta', path: '/abs/beta' },
    });
    mockRows([
      { id: 'a', path: 'src/index.ts', name: 'index.ts', root_id: 'root-a', display_name: 'Alpha' },
      { id: 'b', path: 'src/index.ts', name: 'index.ts', root_id: 'root-b', display_name: 'Beta' },
    ]);

    const { result } = renderHook(() => useQuickOpenFiles('index'));

    expect(result.current.files).toHaveLength(2);
    const byRoot = new Map(result.current.files.map((file) => [file.rootLabel, file.compositeKey]));
    // Each root's same-named file carries its OWN root-prefixed compositeKey.
    expect(byRoot.get('Alpha')).toBe('root-a|@|src/index.ts');
    expect(byRoot.get('Beta')).toBe('root-b|@|src/index.ts');
  });

  it('omits files whose root is NOT currently mounted (honest — cannot open them)', () => {
    // root-b is in the index but not mounted this session; offering it would
    // silently no-op the open, so it must be filtered out.
    setRoots(['root-a'], {
      'root-a': { rootId: 'root-a', displayName: 'Alpha', path: '/abs/alpha' },
    });
    mockRows([
      { id: 'a', path: 'a.ts', name: 'a.ts', root_id: 'root-a', display_name: 'Alpha' },
      { id: 'b', path: 'b.ts', name: 'b.ts', root_id: 'root-b', display_name: 'Beta' },
    ]);

    const { result } = renderHook(() => useQuickOpenFiles('ts'));

    expect(result.current.files.map((file) => file.id)).toEqual(['a']);
  });

  it('omits legacy NULL root_id rows (no mounted root to open them in)', () => {
    setRoots(['root-a'], {
      'root-a': { rootId: 'root-a', displayName: 'Alpha', path: '/abs/alpha' },
    });
    mockRows([
      { id: 'legacy', path: 'legacy.ts', name: 'legacy.ts', root_id: null, display_name: null },
    ]);

    const { result } = renderHook(() => useQuickOpenFiles('legacy'));

    expect(result.current.files).toEqual([]);
  });

  it('disables the live query and returns no files for an empty/whitespace query', () => {
    setRoots(['root-a'], {
      'root-a': { rootId: 'root-a', displayName: 'Alpha', path: '/abs/alpha' },
    });
    mockRows([{ id: 'a', path: 'a.ts', name: 'a.ts', root_id: 'root-a', display_name: 'Alpha' }]);

    const { result } = renderHook(() => useQuickOpenFiles('   '));

    expect(result.current.files).toEqual([]);
    const options = usePGliteLiveQueryMock.mock.calls.at(-1)?.[0] as { enabled?: boolean };
    expect(options.enabled).toBe(false);
  });

  it('passes the trimmed query + bounded limit to the live query', () => {
    setRoots([], {});
    mockRows([]);

    renderHook(() => useQuickOpenFiles('  read  '));

    const options = usePGliteLiveQueryMock.mock.calls.at(-1)?.[0] as {
      params?: readonly unknown[];
      mode?: string;
      key?: string;
    };
    expect(options.params).toEqual(['read', 50]);
    expect(options.mode).toBe('incremental');
    expect(options.key).toBe('id');
  });

  it('prefers the live root display name, falling back to the DB name then "Workspace"', () => {
    // descriptor present but display name differs from the DB snapshot → live wins.
    setRoots(['root-a'], {
      'root-a': { rootId: 'root-a', displayName: 'Renamed Alpha', path: '/abs/alpha' },
    });
    mockRows([
      { id: 'a', path: 'a.ts', name: 'a.ts', root_id: 'root-a', display_name: 'Old Alpha' },
    ]);

    const { result } = renderHook(() => useQuickOpenFiles('a'));
    expect(result.current.files[0]?.rootLabel).toBe('Renamed Alpha');
  });
});
