import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { ElectronFileRecordRepository, type FileRecordRepository } from '@brainstrike/db';
import { useFileRecordRepository } from '@brainstrike/db/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDatabaseStatusSync } from '../hooks/use-database-status-sync';
import {
  __resetDatabaseStatusStoreForTests,
  useDatabaseStatusStore,
} from '../stores/database-status-store';

vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/db')>('@brainstrike/db');
  return {
    ...actual,
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    useFileRecordRepository: vi.fn(),
  };
});
vi.mock('@brainstrike/db/react', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/db/react')>('@brainstrike/db/react');
  return {
    ...actual,
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    useFileRecordRepository: vi.fn(),
  };
});

const mockUseFileRecordRepository = vi.mocked(useFileRecordRepository);

describe('useDatabaseStatusSync', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('reports the native writer only after its catalog read and disables the PG arm', async () => {
    const pending = Promise.withResolvers<BoundaryResult<{ models: []; providers: [] }>>();
    vi.stubGlobal('modelCatalog', { read: () => pending.promise });
    mockUseFileRecordRepository.mockImplementation((options) => {
      if (options?.enabled !== false) {
        throw new Error('Desktop requested PG repository');
      }
      return null;
    });
    renderHook(() => useDatabaseStatusSync());
    expect(useDatabaseStatusStore.getState().loading).toBe(true);
    await act(async () => pending.resolve({ ok: true, value: { models: [], providers: [] } }));
    expect(useDatabaseStatusStore.getState()).toMatchObject({
      connected: true,
      loading: false,
      location: 'SQLite',
    });
  });
  it('re-reads the native catalog when the host reopens after a Clear refusal', async () => {
    // Recorded from the replacement renderer while Clear held the native index closed.
    const closed = {
      category: 'availability',
      code: 'native-index-closed',
      kind: 'refusal',
      message: 'The search index is closed.',
      remedy: 'Reopen the workspace to search again.',
    } as const;
    const read = vi
      .fn()
      .mockResolvedValueOnce({ error: closed, ok: false })
      .mockResolvedValueOnce({ ok: true, value: { models: [], providers: [] } });
    let notify: ((observation: { generation: number; kind: 'ready' }) => void) | undefined;
    const unsubscribe = vi.fn();
    vi.stubGlobal('modelCatalog', { read });
    vi.stubGlobal('indexSearch', {
      onLifecycleChanged: (listener: typeof notify) => {
        notify = listener;
        return unsubscribe;
      },
    });
    mockUseFileRecordRepository.mockReturnValue(null);
    const hook = renderHook(() => useDatabaseStatusSync());
    await waitFor(() =>
      expect(useDatabaseStatusStore.getState()).toMatchObject({
        connected: false,
        loading: false,
        testResult: closed.message,
      })
    );
    await act(async () => notify?.({ generation: 2, kind: 'ready' }));
    await waitFor(() =>
      expect(useDatabaseStatusStore.getState()).toMatchObject({ connected: true, loading: false })
    );
    expect(read).toHaveBeenCalledTimes(2);
    hook.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('reports a failed native writer without selecting the PG arm', async () => {
    vi.stubGlobal('modelCatalog', {
      read: async () => ({ error: INTERNAL_FAULT, ok: false }),
    });
    mockUseFileRecordRepository.mockReturnValue(null);
    renderHook(() => useDatabaseStatusSync());
    await waitFor(() =>
      expect(useDatabaseStatusStore.getState()).toMatchObject({
        connected: false,
        loading: false,
        location: 'SQLite',
        testResult: INTERNAL_FAULT.message,
      })
    );
    expect(mockUseFileRecordRepository).toHaveBeenCalledWith({ enabled: false });
  });
  beforeEach(() => {
    __resetDatabaseStatusStoreForTests();
    mockUseFileRecordRepository.mockReset();
  });

  it('keeps loading when repository is not available', () => {
    mockUseFileRecordRepository.mockReturnValue(null);

    renderHook(() => useDatabaseStatusSync());

    const state = useDatabaseStatusStore.getState();
    expect(state.loading).toBe(true);
    expect(state.connected).toBe(false);
  });

  it('marks connection as connected for PGlite repository', async () => {
    mockUseFileRecordRepository.mockReturnValue({} as FileRecordRepository);

    renderHook(() => useDatabaseStatusSync());

    await waitFor(() => expect(useDatabaseStatusStore.getState().connected).toBe(true));

    const state = useDatabaseStatusStore.getState();
    expect(state.loading).toBe(false);
    expect(state.location).toBe('PGlite WASM');
    expect(state.testResult).toBe('connected');
  });

  it('detects Electron repository and sets IPC location', async () => {
    const electronRepo = new ElectronFileRecordRepository({
      exec: async () => {},
      query: async () => ({ rows: [] }),
    });

    mockUseFileRecordRepository.mockReturnValue(electronRepo as unknown as FileRecordRepository);

    renderHook(() => useDatabaseStatusSync());

    await waitFor(() => expect(useDatabaseStatusStore.getState().connected).toBe(true));

    const state = useDatabaseStatusStore.getState();
    expect(state.location).toBe('Main Process');
    expect(state.testResult).toBe('Connected (IPC)');
  });

  it('reverts to loading when repository disappears after being connected', async () => {
    const repoRef: { current: FileRecordRepository | null } = {
      current: {} as FileRecordRepository,
    };

    mockUseFileRecordRepository.mockImplementation(
      () => repoRef.current as FileRecordRepository | null
    );

    const { rerender } = renderHook(() => useDatabaseStatusSync());

    await waitFor(() => expect(useDatabaseStatusStore.getState().connected).toBe(true));

    act(() => {
      repoRef.current = null;
    });
    rerender();

    await waitFor(() => expect(useDatabaseStatusStore.getState().loading).toBe(true));
  });
});
