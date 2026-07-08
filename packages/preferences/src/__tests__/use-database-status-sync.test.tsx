import {
  ElectronFileRecordRepository,
  type FileRecordRepository,
  useFileRecordRepository,
} from '@brainstrike/db';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const mockUseFileRecordRepository = vi.mocked(useFileRecordRepository);

describe('useDatabaseStatusSync', () => {
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
