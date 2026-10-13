import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DebugBundleDatabase } from '../diagnostics/debug-bundle';
import { useDebugBundleBinding } from '../hooks/use-debug-bundle';

const useOptionalPGliteDatabaseMock = vi.hoisted(() => vi.fn());
const buildThreadPackMock = vi.hoisted(() => vi.fn().mockResolvedValue('{}'));
vi.mock('../diagnostics/thread-debug-pack', () => ({ buildThreadDebugPack: buildThreadPackMock }));

vi.mock('@brainstrike/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalPGliteDatabase: useOptionalPGliteDatabaseMock,
}));
vi.mock('@brainstrike/db/react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalPGliteDatabase: useOptionalPGliteDatabaseMock,
}));

// Minimal stub covering exactly the SQL branches `collectThreadDebugBundleData`
// issues for a thread with no matching run (empty rows throughout) — the
// header renders unconditionally, so this is enough to prove delegation.
function makeStubDb(): DebugBundleDatabase {
  return {
    query: async <T>(sql: string): Promise<{ rows: T[] }> => {
      if (sql.includes('FROM brainstrike_assistant_thread_runs')) {
        return { rows: [] as unknown as T[] };
      }
      if (sql.includes('FROM mastra_messages')) {
        return { rows: [] as unknown as T[] };
      }
      if (sql.includes('FROM brainstrike_diagnostic_events')) {
        return { rows: [] as unknown as T[] };
      }
      throw new Error(`Unexpected SQL in stub: ${sql}`);
    },
  };
}

describe('useDebugBundleBinding', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopDiagnostics');
  });

  it('binds full exports to the current selected thread after navigation', async () => {
    const db = makeStubDb();
    useOptionalPGliteDatabaseMock.mockReturnValue(db);
    const { result, rerender } = renderHook(({ threadId }) => useDebugBundleBinding(threadId), {
      initialProps: { threadId: 'root' },
    });
    await result.current?.buildThreadPack?.();
    // No desktop diagnostics bridge in this environment: the pack is told so.
    expect(buildThreadPackMock).toHaveBeenLastCalledWith(db, 'root', null);
    rerender({ threadId: 'child' });
    await result.current?.buildThreadPack?.();
    expect(buildThreadPackMock).toHaveBeenLastCalledWith(db, 'child', null);
  });

  it('hands the pack the desktop diagnostics bridge when the preload exposes both host readers', async () => {
    const db = makeStubDb();
    useOptionalPGliteDatabaseMock.mockReturnValue(db);
    const bridge = {
      getSnapshot: vi.fn(),
      readMainLogWindow: vi.fn(),
      readProcessCounters: vi.fn(),
    };
    Object.assign(window, { desktopDiagnostics: bridge });
    const { result } = renderHook(() => useDebugBundleBinding('thread-1'));
    await result.current?.buildThreadPack?.();
    expect(buildThreadPackMock).toHaveBeenLastCalledWith(
      db,
      'thread-1',
      expect.objectContaining({
        readMainLogWindow: expect.any(Function),
        readProcessCounters: expect.any(Function),
      })
    );
  });

  it('is null without a db handle', () => {
    useOptionalPGliteDatabaseMock.mockReturnValue(null);
    const { result } = renderHook(() => useDebugBundleBinding('thread-1'));
    expect(result.current).toBeNull();
  });

  it('is null without a selected thread', () => {
    useOptionalPGliteDatabaseMock.mockReturnValue(makeStubDb());
    expect(renderHook(() => useDebugBundleBinding(null)).result.current).toBeNull();
    expect(renderHook(() => useDebugBundleBinding(undefined)).result.current).toBeNull();
  });

  it('delegates buildBundle to the real buildThreadDebugBundle collector + formatter', async () => {
    useOptionalPGliteDatabaseMock.mockReturnValue(makeStubDb());
    const { result } = renderHook(() => useDebugBundleBinding('thread-1'));

    expect(result.current).not.toBeNull();
    const bundle = await result.current?.buildBundle({ runId: 'r1' });

    expect(bundle).toContain('# BrainStrike Debug Bundle');
    expect(bundle).toContain('thread_id: thread-1');
  });
});
