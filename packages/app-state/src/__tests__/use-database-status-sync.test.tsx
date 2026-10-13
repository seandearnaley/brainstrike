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
    const pending = Promise.withResolvers<{ models: []; providers: [] }>();
    vi.stubGlobal('modelCatalog', { read: () => pending.promise });
    mockUseFileRecordRepository.mockImplementation((options) => {
      if (options?.enabled !== false) {
        throw new Error('Desktop requested PG repository');
      }
      return null;
    });
    renderHook(() => useDatabaseStatusSync());
    expect(useDatabaseStatusStore.getState().loading).toBe(true);
    await act(async () => pending.resolve({ models: [], providers: [] }));
    expect(useDatabaseStatusStore.getState()).toMatchObject({
      connected: true,
      loading: false,
      location: 'SQLite',
    });
  });
  it('reports a failed native writer without selecting the PG arm', async () => {
    vi.stubGlobal('modelCatalog', {
      read: async () => {
        throw new Error('Host unavailable');
      },
    });
    mockUseFileRecordRepository.mockReturnValue(null);
    renderHook(() => useDatabaseStatusSync());
    await waitFor(() =>
      expect(useDatabaseStatusStore.getState()).toMatchObject({
        connected: false,
        loading: false,
        location: 'SQLite',
        testResult: 'Host unavailable',
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
