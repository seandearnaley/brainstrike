import type { FileExplorerState } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const usePGliteLiveQueryMock = vi.fn();

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: (...parts: unknown[]) => parts.map((p) => String(p)).join(':'),
  QUICK_OPEN_MAX_LIMIT: 50,
  QUICK_OPEN_NAME_SEARCH_SQL: 'SELECT ... quick-open',
  usePGliteLiveQuery: (options: unknown) => usePGliteLiveQueryMock(options),
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

import { useFileMentions } from '../use-file-mentions';

interface DbRow {
  display_name: string | null;
  id: string;
  name: string;
  path: string;
  root_id: string | null;
}

function mockRows(rows: DbRow[], loading = false): void {
  usePGliteLiveQueryMock.mockReturnValue({ error: null, loading, refresh: vi.fn(), rows });
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
  rootIdentityAbsent = false;
  setRoots([], {});
});

describe('useFileMentions', () => {
  it('maps a row to a FileMention whose directive id encodes the DB root_id + path', () => {
    // DB roots.id = 'D', adapter rootId = 'A' (divergent). The mention id MUST
    // carry the DB id 'D' (server resolves against roots.id), NOT the adapter id.
    setRoots(['A'], { A: { displayName: 'Alpha', path: '/abs/alpha', rootId: 'A' } });
    adapterByDbRootId = new Map([['D', 'A']]);
    mockRows([
      { display_name: 'Alpha', id: 'f1', name: 'index.ts', path: 'src/index.ts', root_id: 'D' },
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
    setRoots(['A'], { A: { displayName: 'Alpha', path: '/abs/alpha', rootId: 'A' } });
    adapterByDbRootId = new Map([['D', 'A']]);
    mockRows([
      { display_name: 'Alpha', id: 'a', name: 'a.ts', path: 'a.ts', root_id: 'D' },
      { display_name: 'Ghost', id: 'b', name: 'b.ts', path: 'b.ts', root_id: 'GHOST' },
    ]);

    const { result } = renderSettled('ts');
    expect(result.current.fileMentions.map((f) => f.label)).toEqual(['a.ts']);
  });

  it('omits a file whose mapped adapter root is not currently mounted', () => {
    setRoots([], {});
    adapterByDbRootId = new Map([['D', 'A']]);
    mockRows([{ display_name: 'Alpha', id: 'a', name: 'a.ts', path: 'a.ts', root_id: 'D' }]);

    const { result } = renderSettled('ts');
    expect(result.current.fileMentions).toEqual([]);
  });

  it('omits legacy NULL root_id rows', () => {
    setRoots(['A'], { A: { displayName: 'Alpha', path: '/abs/alpha', rootId: 'A' } });
    mockRows([{ display_name: null, id: 'x', name: 'x.ts', path: 'x.ts', root_id: null }]);

    const { result } = renderSettled('x');
    expect(result.current.fileMentions).toEqual([]);
  });

  it('exposes NO candidates while a debounce is pending (no stale list)', () => {
    setRoots(['A'], { A: { displayName: 'Alpha', path: '/abs/alpha', rootId: 'A' } });
    adapterByDbRootId = new Map([['A', 'A']]);
    mockRows([{ display_name: 'Alpha', id: 's', name: 's.ts', path: 's.ts', root_id: 'A' }]);

    const { result, rerender } = renderSettled('ap');
    expect(result.current.fileMentions.map((f) => f.label)).toEqual(['s.ts']);

    act(() => {
      rerender('app');
    });
    expect(result.current.fileMentions).toEqual([]);
    expect(result.current.loading).toBe(true);
  });

  it('disables the live query for an empty/whitespace query', () => {
    setRoots(['A'], { A: { displayName: 'Alpha', path: '/abs/alpha', rootId: 'A' } });
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
    setRoots(['A'], { A: { displayName: 'Renamed', path: '/abs/alpha', rootId: 'A' } });
    adapterByDbRootId = new Map([['D', 'A']]);
    mockRows([{ display_name: 'Old', id: 'a', name: 'a.ts', path: 'a.ts', root_id: 'D' }]);

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
      'root-uuid': { displayName: 'Repo', path: '/abs/repo', rootId: 'root-uuid' },
    });
    mockRows([
      { display_name: 'Repo', id: 'f', name: 'app.ts', path: 'src/app.ts', root_id: 'root-uuid' },
    ]);

    const { result } = renderSettled('app');
    expect(result.current.fileMentions).toEqual([
      { id: 'root-uuid::src/app.ts', label: 'app.ts', path: 'src/app.ts', rootLabel: 'Repo' },
    ]);
  });

  it('drops a row whose root_id is NOT a mounted adapter root when the provider is ABSENT (no invented mapping)', () => {
    rootIdentityAbsent = true;
    setRoots(['mounted-uuid'], {
      'mounted-uuid': { displayName: 'Repo', path: '/abs/repo', rootId: 'mounted-uuid' },
    });
    mockRows([
      // A divergent legacy DB id that matches no mounted adapter root → dropped.
      { display_name: 'Other', id: 'g', name: 'x.ts', path: 'x.ts', root_id: 'unmounted-uuid' },
    ]);

    const { result } = renderSettled('x');
    expect(result.current.fileMentions).toEqual([]);
  });
});
