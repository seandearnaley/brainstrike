import type { DbHandle } from '@brainstrike/db/react';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMock,
}));

import { useThreadFolderRows } from '../hooks/use-thread-folder-rows';

interface RootsRow {
  readonly displayName: string;
  readonly id: string;
  readonly path: string | null;
}

const ROOT_ROWS: readonly RootsRow[] = [
  { displayName: 'Project A', id: 'root-a', path: '/work/a' },
  { displayName: 'Project B', id: 'root-b', path: null },
];

const query = vi.fn();

// A STABLE handle: the hook keys its effect on the handle identity, so a
// fresh object per render would re-query forever.
const DATABASE = { query } as unknown as DbHandle;

beforeEach(() => {
  query.mockReset();
  loggerMock.error.mockClear();
  loggerMock.warn.mockClear();
  query.mockImplementation(async (sql: string, params: readonly unknown[]) => {
    if (!sql.includes('FROM roots')) {
      throw new Error(`Unexpected query: ${sql}`);
    }
    const ids = params[0] as readonly string[];
    return { rows: ROOT_ROWS.filter((row) => ids.includes(row.id)) };
  });
});

describe('useThreadFolderRows', () => {
  it('resolves display rows for the requested root ids in ONE batched query', async () => {
    const { result } = renderHook(() => useThreadFolderRows(DATABASE, ['root-b', 'root-a']));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.rowsByRootId.get('root-a')).toEqual({
      displayName: 'Project A',
      path: '/work/a',
      rootId: 'root-a',
    });
    expect(result.current.rowsByRootId.get('root-b')).toEqual({
      displayName: 'Project B',
      path: null,
      rootId: 'root-b',
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('FROM roots WHERE id = ANY($1::text[])');
  });

  it('re-queries only when the distinct id SET changes, not on reordering or repeats', async () => {
    const { rerender, result } = renderHook(
      (rootIds: readonly string[]) => useThreadFolderRows(DATABASE, rootIds),
      { initialProps: ['root-a', 'root-b'] as readonly string[] }
    );
    await waitFor(() => {
      expect(result.current.rowsByRootId.size).toBe(2);
    });
    expect(query).toHaveBeenCalledTimes(1);

    // Same set, different order and a duplicate: no new round trip.
    rerender(['root-b', 'root-a', 'root-a']);
    await waitFor(() => {
      expect(result.current.rowsByRootId.size).toBe(2);
    });
    expect(query).toHaveBeenCalledTimes(1);

    rerender(['root-a']);
    await waitFor(() => {
      expect(result.current.rowsByRootId.size).toBe(1);
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[1]).toEqual([['root-a']]);
  });

  it('does not query and reports resolved emptiness for an empty id list', async () => {
    const { result } = renderHook(() => useThreadFolderRows(DATABASE, []));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.rowsByRootId.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('stays loading with no rows while there is no database handle', () => {
    const { result } = renderHook(() => useThreadFolderRows(null, ['root-a']));

    expect(result.current.loading).toBe(true);
    expect(result.current.rowsByRootId.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  // The pure section builder deliberately does not log an unresolved root id
  // (it stays DB-free); this hook is where that gap becomes observable.
  it('warns ONCE per unresolved root id and invents no display row for it', async () => {
    const { rerender, result } = renderHook(
      (rootIds: readonly string[]) => useThreadFolderRows(DATABASE, rootIds),
      { initialProps: ['root-a', 'root-missing'] as readonly string[] }
    );

    await waitFor(() => {
      expect(result.current.rowsByRootId.size).toBe(1);
    });
    expect(result.current.rowsByRootId.has('root-missing')).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn.mock.calls[0]?.[1]).toEqual({ rootId: 'root-missing' });

    rerender(['root-missing']);
    await waitFor(() => {
      expect(result.current.rowsByRootId.size).toBe(0);
    });
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  // The failure must be REPORTABLE, not just logged: an empty map with
  // `loading: false` and no error renders every thread under "No folder",
  // which is the silent degrade this projection's sibling already refuses.
  it('surfaces the query failure as an error instead of an empty resolved map', async () => {
    query.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useThreadFolderRows(DATABASE, ['root-a']));

    await waitFor(() => {
      expect(loggerMock.error).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('boom');
    expect(result.current.rowsByRootId.size).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reports no error on a resolved id set', async () => {
    const { result } = renderHook(() => useThreadFolderRows(DATABASE, ['root-a']));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBeNull();
  });

  // A failure belongs to the id set it failed FOR. A later set that resolves
  // must not inherit it (and must not be blocked by it).
  it('clears the error when a different id set resolves', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const { rerender, result } = renderHook(
      (rootIds: readonly string[]) => useThreadFolderRows(DATABASE, rootIds),
      { initialProps: ['root-a'] as readonly string[] }
    );
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
    });

    rerender(['root-b']);

    await waitFor(() => {
      expect(result.current.rowsByRootId.size).toBe(1);
    });
    expect(result.current.error).toBeNull();
  });

  // Value-keyed results: a resolution for one id set must never be rendered
  // under another (the panel would show the wrong folder names).
  it('never renders a previous id set’s rows under a new id set', async () => {
    const { rerender, result } = renderHook(
      (rootIds: readonly string[]) => useThreadFolderRows(DATABASE, rootIds),
      { initialProps: ['root-a'] as readonly string[] }
    );
    await waitFor(() => {
      expect(result.current.rowsByRootId.size).toBe(1);
    });

    let release: (() => void) | undefined;
    query.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ rows: [ROOT_ROWS[1]] });
          };
        })
    );
    rerender(['root-b']);

    expect(result.current.rowsByRootId.size).toBe(0);
    expect(result.current.loading).toBe(true);
    release?.();
    await waitFor(() => {
      expect(result.current.rowsByRootId.get('root-b')?.displayName).toBe('Project B');
    });
  });
});
