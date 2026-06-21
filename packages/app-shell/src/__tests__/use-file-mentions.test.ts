import type { FileExplorerState } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const usePGliteLiveQueryMock = vi.fn();

vi.mock('@brainstrike/db', () => ({
  usePGliteLiveQuery: (options: unknown) => usePGliteLiveQueryMock(options),
  makeLiveQueryKey: (...parts: unknown[]) => parts.map((p) => String(p)).join(':'),
  QUICK_OPEN_MAX_LIMIT: 50,
  QUICK_OPEN_NAME_SEARCH_SQL: 'SELECT ... quick-open',
}));

const storeState = {
  activeRootIds: [] as string[],
  rootDescriptors: {} as FileExplorerState['rootDescriptors'],
};

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreSelector: <T>(selector: (state: typeof storeState) => T): T =>
    selector(storeState),
}));

let adapterByDbRootId = new Map<string, string>();
vi.mock('../roots/root-identity-context', () => ({
  useOptionalRootIdentity: () => ({
    resolveAdapterRootId: (dbRootId: string): string | null =>
      adapterByDbRootId.get(dbRootId) ?? null,
  }),
}));

import { useFileMentions } from '../use-file-mentions';

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

function renderSettled(query: string) {
  const hook = renderHook((q: string) => useFileMentions(q), { initialProps: query });
  act(() => {
    vi.advanceTimersByTime(200);
  });
  return hook;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  usePGliteLiveQueryMock.mockReset();
  adapterByDbRootId = new Map();
  setRoots([], {});
});

describe('useFileMentions', () => {
  it('maps a row to a FileMention whose directive id encodes the DB root_id + path', () => {
    // DB roots.id = 'D', adapter rootId = 'A' (divergent). The mention id MUST
    // carry the DB id 'D' (server resolves against roots.id), NOT the adapter id.
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Alpha', path: '/abs/alpha' } });
    adapterByDbRootId = new Map([['D', 'A']]);
    mockRows([
      { id: 'f1', path: 'src/index.ts', name: 'index.ts', root_id: 'D', display_name: 'Alpha' },
    ]);

    const { result } = renderSettled('index');

    expect(result.current.fileMentions).toHaveLength(1);
    expect(result.current.fileMentions[0]).toMatchObject({
      id: 'D::src/index.ts',
      label: 'index.ts',
      path: 'src/index.ts',
      rootLabel: 'Alpha',
    });
  });

  it('omits a file whose DB root_id has no adapter mapping (unmounted)', () => {
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Alpha', path: '/abs/alpha' } });
    adapterByDbRootId = new Map([['D', 'A']]);
    mockRows([
      { id: 'a', path: 'a.ts', name: 'a.ts', root_id: 'D', display_name: 'Alpha' },
      { id: 'b', path: 'b.ts', name: 'b.ts', root_id: 'GHOST', display_name: 'Ghost' },
    ]);

    const { result } = renderSettled('ts');
    expect(result.current.fileMentions.map((f) => f.label)).toEqual(['a.ts']);
  });

  it('omits a file whose mapped adapter root is not currently mounted', () => {
    setRoots([], {});
    adapterByDbRootId = new Map([['D', 'A']]);
    mockRows([{ id: 'a', path: 'a.ts', name: 'a.ts', root_id: 'D', display_name: 'Alpha' }]);

    const { result } = renderSettled('ts');
    expect(result.current.fileMentions).toEqual([]);
  });

  it('omits legacy NULL root_id rows', () => {
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Alpha', path: '/abs/alpha' } });
    mockRows([{ id: 'x', path: 'x.ts', name: 'x.ts', root_id: null, display_name: null }]);

    const { result } = renderSettled('x');
    expect(result.current.fileMentions).toEqual([]);
  });

  it('exposes NO candidates while a debounce is pending (no stale list)', () => {
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Alpha', path: '/abs/alpha' } });
    adapterByDbRootId = new Map([['A', 'A']]);
    mockRows([{ id: 's', path: 's.ts', name: 's.ts', root_id: 'A', display_name: 'Alpha' }]);

    const { result, rerender } = renderSettled('ap');
    expect(result.current.fileMentions.map((f) => f.label)).toEqual(['s.ts']);

    act(() => {
      rerender('app');
    });
    expect(result.current.fileMentions).toEqual([]);
    expect(result.current.loading).toBe(true);
  });

  it('disables the live query for an empty/whitespace query', () => {
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Alpha', path: '/abs/alpha' } });
    mockRows([]);

    renderSettled('   ');

    const options = usePGliteLiveQueryMock.mock.calls.at(-1)?.[0] as { enabled?: boolean };
    expect(options.enabled).toBe(false);
  });

  it('passes the debounced query + bounded limit to the live query', () => {
    setRoots([], {});
    mockRows([]);

    renderSettled('  app  ');

    const options = usePGliteLiveQueryMock.mock.calls.at(-1)?.[0] as {
      params?: readonly unknown[];
      mode?: string;
      key?: string;
    };
    expect(options.params).toEqual(['app', 50]);
    expect(options.mode).toBe('incremental');
    expect(options.key).toBe('id');
  });

  it('prefers the live root display name, falling back to the DB name then "Workspace"', () => {
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Renamed', path: '/abs/alpha' } });
    adapterByDbRootId = new Map([['D', 'A']]);
    mockRows([{ id: 'a', path: 'a.ts', name: 'a.ts', root_id: 'D', display_name: 'Old' }]);

    const { result } = renderSettled('a');
    expect(result.current.fileMentions[0]?.rootLabel).toBe('Renamed');
  });
});
