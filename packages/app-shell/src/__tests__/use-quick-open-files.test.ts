import type { FileExplorerState } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const useBrainstrikeLiveQueryMock = vi.fn();

vi.mock('@brainstrike/db', () => ({
  useBrainstrikeLiveQuery: (options: unknown) => useBrainstrikeLiveQueryMock(options),
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

// The root-identity translator: DB roots.id -> adapter rootId. Tests set the
// inverse mapping explicitly so the DB id and adapter id can DIVERGE.
let adapterByDbRootId = new Map<string, string>();
vi.mock('../roots/root-identity-context', () => ({
  useOptionalRootIdentity: () => ({
    resolveAdapterRootId: (dbRootId: string): string | null =>
      adapterByDbRootId.get(dbRootId) ?? null,
  }),
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
  useBrainstrikeLiveQueryMock.mockReturnValue({ rows, loading, error: null, refresh: vi.fn() });
}

function mockError(error: Error): void {
  useBrainstrikeLiveQueryMock.mockReturnValue({
    rows: [],
    loading: false,
    error,
    refresh: vi.fn(),
  });
}

function setRoots(
  activeRootIds: string[],
  rootDescriptors: FileExplorerState['rootDescriptors']
): void {
  storeState.activeRootIds = activeRootIds;
  storeState.rootDescriptors = rootDescriptors;
}

// Renders the hook and flushes the 150ms debounce so the debounced query equals
// the input (the steady state we assert on for most tests).
function renderSettled(query: string) {
  const hook = renderHook((q: string) => useQuickOpenFiles(q), { initialProps: query });
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
  useBrainstrikeLiveQueryMock.mockReset();
  adapterByDbRootId = new Map();
  setRoots([], {});
});

describe('useQuickOpenFiles', () => {
  it('FIX A: a legacy root whose DB id ≠ adapter id SURVIVES the gate and encodes the ADAPTER id', () => {
    // DB roots.id = 'L', adapter rootId = 'A' (divergent — the legacy case).
    // activeRootIds holds the ADAPTER id; the mapping is {adapter A -> db L}.
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Legacy', path: '/abs/legacy' } });
    adapterByDbRootId = new Map([['L', 'A']]);
    mockRows([
      { id: 'f1', path: 'src/index.ts', name: 'index.ts', root_id: 'L', display_name: 'Legacy' },
    ]);

    const { result } = renderSettled('index');

    expect(result.current.files).toHaveLength(1);
    // Encodes the ADAPTER id 'A', NOT the DB id 'L'.
    expect(result.current.files[0]?.compositeKey).toBe('A|@|src/index.ts');
    expect(result.current.files[0]?.rootLabel).toBe('Legacy');
  });

  it('opens the RIGHT root for the same path in two roots (DB ids differ from adapter ids)', () => {
    setRoots(['A1', 'A2'], {
      A1: { rootId: 'A1', displayName: 'Alpha', path: '/abs/alpha' },
      A2: { rootId: 'A2', displayName: 'Beta', path: '/abs/beta' },
    });
    // Divergent: DB ids D1/D2 map to adapter ids A1/A2.
    adapterByDbRootId = new Map([
      ['D1', 'A1'],
      ['D2', 'A2'],
    ]);
    mockRows([
      { id: 'a', path: 'src/index.ts', name: 'index.ts', root_id: 'D1', display_name: 'Alpha' },
      { id: 'b', path: 'src/index.ts', name: 'index.ts', root_id: 'D2', display_name: 'Beta' },
    ]);

    const { result } = renderSettled('index');

    expect(result.current.files).toHaveLength(2);
    const byRoot = new Map(result.current.files.map((file) => [file.rootLabel, file.compositeKey]));
    expect(byRoot.get('Alpha')).toBe('A1|@|src/index.ts');
    expect(byRoot.get('Beta')).toBe('A2|@|src/index.ts');
  });

  it('omits a file whose DB root_id has no adapter mapping (genuinely unmounted)', () => {
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Alpha', path: '/abs/alpha' } });
    adapterByDbRootId = new Map([['L', 'A']]); // only 'L' is mapped
    mockRows([
      { id: 'a', path: 'a.ts', name: 'a.ts', root_id: 'L', display_name: 'Alpha' },
      { id: 'b', path: 'b.ts', name: 'b.ts', root_id: 'UNMAPPED', display_name: 'Ghost' },
    ]);

    const { result } = renderSettled('ts');

    expect(result.current.files.map((file) => file.id)).toEqual(['a']);
  });

  it('omits a file whose mapped adapter root is not currently mounted', () => {
    // DB 'L' maps to adapter 'A', but 'A' is NOT in activeRootIds (root closed).
    setRoots([], {});
    adapterByDbRootId = new Map([['L', 'A']]);
    mockRows([{ id: 'a', path: 'a.ts', name: 'a.ts', root_id: 'L', display_name: 'Alpha' }]);

    const { result } = renderSettled('ts');

    expect(result.current.files).toEqual([]);
  });

  it('omits legacy NULL root_id rows', () => {
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Alpha', path: '/abs/alpha' } });
    mockRows([
      { id: 'legacy', path: 'legacy.ts', name: 'legacy.ts', root_id: null, display_name: null },
    ]);

    const { result } = renderSettled('legacy');

    expect(result.current.files).toEqual([]);
  });

  it('FIX B: while a debounce is pending, exposes NO files (Enter cannot open a stale file)', () => {
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Alpha', path: '/abs/alpha' } });
    adapterByDbRootId = new Map([['A', 'A']]);
    // Stale rows for the PREVIOUS query are returned by the live query.
    mockRows([
      { id: 'stale', path: 'stale.ts', name: 'stale.ts', root_id: 'A', display_name: 'Alpha' },
    ]);

    // First render with 'rea', settle it.
    const { result, rerender } = renderSettled('rea');
    expect(result.current.files.map((f) => f.id)).toEqual(['stale']);

    // User types 'read' — debounce now PENDING (input ≠ debounced for 150ms).
    act(() => {
      rerender('read');
    });
    // The live query still returns the prior 'rea' rows, but they must NOT be
    // actionable while the debounce for 'read' is pending.
    expect(result.current.files).toEqual([]);
    expect(result.current.loading).toBe(true);
  });

  it('FIX B: while the live query is loading the current query, exposes NO files', () => {
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Alpha', path: '/abs/alpha' } });
    adapterByDbRootId = new Map([['A', 'A']]);
    // loading: true (new subscription in flight) with stale rows still present.
    mockRows(
      [{ id: 'stale', path: 'stale.ts', name: 'stale.ts', root_id: 'A', display_name: 'Alpha' }],
      true
    );

    const { result } = renderSettled('read');

    expect(result.current.files).toEqual([]);
    expect(result.current.loading).toBe(true);
  });

  it('exposes live-query errors so Turso unsupported-runtime paths are visible', () => {
    const error = new Error('Live queries are unavailable for Turso runtime.');
    mockError(error);

    const { result } = renderSettled('read');

    expect(result.current.error).toBe(error);
    expect(result.current.files).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('disables the live query and returns no files for an empty/whitespace query', () => {
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Alpha', path: '/abs/alpha' } });
    adapterByDbRootId = new Map([['A', 'A']]);
    mockRows([{ id: 'a', path: 'a.ts', name: 'a.ts', root_id: 'A', display_name: 'Alpha' }]);

    const { result } = renderSettled('   ');

    expect(result.current.files).toEqual([]);
    const options = useBrainstrikeLiveQueryMock.mock.calls.at(-1)?.[0] as { enabled?: boolean };
    expect(options.enabled).toBe(false);
  });

  it('passes the debounced query + bounded limit to the live query', () => {
    setRoots([], {});
    mockRows([]);

    renderSettled('  read  ');

    const options = useBrainstrikeLiveQueryMock.mock.calls.at(-1)?.[0] as {
      params?: readonly unknown[];
      mode?: string;
      key?: string;
    };
    expect(options.params).toEqual(['read', 50]);
    expect(options.mode).toBe('incremental');
    expect(options.key).toBe('id');
  });

  it('prefers the live root display name, falling back to the DB name then "Workspace"', () => {
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Renamed Alpha', path: '/abs/alpha' } });
    adapterByDbRootId = new Map([['D', 'A']]);
    mockRows([{ id: 'a', path: 'a.ts', name: 'a.ts', root_id: 'D', display_name: 'Old Alpha' }]);

    const { result } = renderSettled('a');
    expect(result.current.files[0]?.rootLabel).toBe('Renamed Alpha');
  });
});
