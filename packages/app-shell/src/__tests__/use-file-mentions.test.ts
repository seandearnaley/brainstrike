import type { FileExplorerState } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const useBrainstrikeLiveQueryMock = vi.fn();
const useFileRecordRepositoryMock = vi.fn();

vi.mock('@brainstrike/db', () => ({
  useBrainstrikeLiveQuery: (options: unknown) => useBrainstrikeLiveQueryMock(options),
  useFileRecordRepository: () => useFileRecordRepositoryMock(),
  useOptionalPGliteDatabase: vi.fn(() => ({})),
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
// When true, the RootIdentityProvider is ABSENT (mirrors the assistant panel,
// which renders as a sibling of the workspace-sync subtree that owns it).
let rootIdentityAbsent = false;
vi.mock('../roots/root-identity-context', () => ({
  useOptionalRootIdentity: () =>
    rootIdentityAbsent
      ? null
      : {
          resolveAdapterRootId: (dbRootId: string): string | null =>
            adapterByDbRootId.get(dbRootId) ?? null,
        },
}));

import { useOptionalPGliteDatabase } from '@brainstrike/db';
import { useFileMentions } from '../use-file-mentions';

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
  useBrainstrikeLiveQueryMock.mockReset();
  useFileRecordRepositoryMock.mockReset();
  vi.mocked(useOptionalPGliteDatabase).mockReset();
  vi.mocked(useOptionalPGliteDatabase).mockReturnValue({} as never);
  adapterByDbRootId = new Map();
  rootIdentityAbsent = false;
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

  it('exposes live-query errors so Turso unsupported-runtime paths are visible', () => {
    const error = new Error('Live queries are unavailable for Turso runtime.');
    mockError(error);

    const { result } = renderSettled('app');

    expect(result.current.error).toBe(error);
    expect(result.current.fileMentions).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('uses repository snapshots when PGlite live queries are unavailable', async () => {
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Alpha', path: '/abs/alpha' } });
    adapterByDbRootId = new Map([['D', 'A']]);
    const findByNameSubstring = vi.fn().mockResolvedValue([
      {
        display_name: 'Old Alpha',
        id: 'a',
        name: 'alpha.ts',
        path: 'src/alpha.ts',
        root_id: 'D',
      },
    ]);
    vi.mocked(useOptionalPGliteDatabase).mockReturnValue(null as never);
    useFileRecordRepositoryMock.mockReturnValue({ findByNameSubstring });
    mockRows([]);

    const { result } = renderSettled('alpha');

    expect(useBrainstrikeLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
    await expect.poll(() => findByNameSubstring.mock.calls.length).toBe(1);
    expect(findByNameSubstring).toHaveBeenCalledWith('alpha', 50);
    await expect
      .poll(() => result.current.fileMentions)
      .toEqual([
        {
          id: 'D::src/alpha.ts',
          label: 'alpha.ts',
          path: 'src/alpha.ts',
          rootLabel: 'Alpha',
        },
      ]);
  });

  it('does not expose disabled live-query rows when repository search is unavailable', async () => {
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Alpha', path: '/abs/alpha' } });
    adapterByDbRootId = new Map([['D', 'A']]);
    vi.mocked(useOptionalPGliteDatabase).mockReturnValue(null as never);
    useFileRecordRepositoryMock.mockReturnValue({});
    mockRows([
      {
        display_name: 'Old Alpha',
        id: 'stale',
        name: 'stale.ts',
        path: 'src/stale.ts',
        root_id: 'D',
      },
    ]);

    const { result } = renderSettled('alpha');

    await expect
      .poll(() => result.current.error?.message)
      .toBe('File-mention repository search is unavailable.');
    expect(result.current.fileMentions).toEqual([]);
  });

  it('reports loading while the repository snapshot for the current query is unresolved', async () => {
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Alpha', path: '/abs/alpha' } });
    adapterByDbRootId = new Map([['D', 'A']]);
    const findByNameSubstring = vi.fn(
      () => new Promise<DbRow[]>((resolve) => setTimeout(() => resolve([]), 1000))
    );
    vi.mocked(useOptionalPGliteDatabase).mockReturnValue(null as never);
    useFileRecordRepositoryMock.mockReturnValue({ findByNameSubstring });
    mockRows([]);

    const { result } = renderSettled('alpha');

    await expect.poll(() => findByNameSubstring.mock.calls.length).toBe(1);
    expect(result.current.fileMentions).toEqual([]);
    expect(result.current.loading).toBe(true);
  });

  it('refreshes repository snapshots when indexing drains', async () => {
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Alpha', path: '/abs/alpha' } });
    adapterByDbRootId = new Map([['D', 'A']]);
    const findByNameSubstring = vi
      .fn()
      .mockResolvedValueOnce([
        {
          display_name: 'Old Alpha',
          id: 'a',
          name: 'alpha.ts',
          path: 'src/alpha.ts',
          root_id: 'D',
        },
      ])
      .mockResolvedValueOnce([
        {
          display_name: 'Old Alpha',
          id: 'b',
          name: 'alpha-new.ts',
          path: 'src/alpha-new.ts',
          root_id: 'D',
        },
      ]);
    vi.mocked(useOptionalPGliteDatabase).mockReturnValue(null as never);
    useFileRecordRepositoryMock.mockReturnValue({ findByNameSubstring });
    mockRows([]);

    const { result } = renderSettled('alpha');

    await expect.poll(() => result.current.fileMentions[0]?.label).toBe('alpha.ts');
    act(() => {
      window.dispatchEvent(new Event('brainstrike:queue-drained'));
    });
    await expect.poll(() => findByNameSubstring.mock.calls.length).toBe(2);
    await expect.poll(() => result.current.fileMentions[0]?.label).toBe('alpha-new.ts');
  });

  it('disables the live query for an empty/whitespace query', () => {
    setRoots(['A'], { A: { rootId: 'A', displayName: 'Alpha', path: '/abs/alpha' } });
    mockRows([]);

    renderSettled('   ');

    const options = useBrainstrikeLiveQueryMock.mock.calls.at(-1)?.[0] as { enabled?: boolean };
    expect(options.enabled).toBe(false);
  });

  it('passes the debounced query + bounded limit to the live query', () => {
    setRoots([], {});
    mockRows([]);

    renderSettled('  app  ');

    const options = useBrainstrikeLiveQueryMock.mock.calls.at(-1)?.[0] as {
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

  // The assistant panel renders OUTSIDE the workspace-sync subtree, so the
  // root-identity translator is absent there. Without a verified-membership
  // fallback every row is dropped and the "@" picker is permanently empty even
  // though the live query returns matches (the live-debugged root cause).
  it('resolves rows via VERIFIED membership when the root-identity provider is ABSENT', () => {
    rootIdentityAbsent = true;
    // reconcileRoots makes roots.id === adapter rootId on desktop, so the DB
    // root_id is itself a currently-mounted adapter root.
    setRoots(['root-uuid'], {
      'root-uuid': { rootId: 'root-uuid', displayName: 'Repo', path: '/abs/repo' },
    });
    mockRows([
      { id: 'f', path: 'src/app.ts', name: 'app.ts', root_id: 'root-uuid', display_name: 'Repo' },
    ]);

    const { result } = renderSettled('app');
    expect(result.current.fileMentions).toEqual([
      { id: 'root-uuid::src/app.ts', label: 'app.ts', path: 'src/app.ts', rootLabel: 'Repo' },
    ]);
  });

  it('drops a row whose root_id is NOT a mounted adapter root when the provider is ABSENT (no invented mapping)', () => {
    rootIdentityAbsent = true;
    setRoots(['mounted-uuid'], {
      'mounted-uuid': { rootId: 'mounted-uuid', displayName: 'Repo', path: '/abs/repo' },
    });
    mockRows([
      // A divergent legacy DB id that matches no mounted adapter root → dropped.
      { id: 'g', path: 'x.ts', name: 'x.ts', root_id: 'unmounted-uuid', display_name: 'Other' },
    ]);

    const { result } = renderSettled('x');
    expect(result.current.fileMentions).toEqual([]);
  });
});
