import { type DrizzleFileRecordRepository, useFileRecordRepository } from '@brainstrike/db';
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
    useFileRecordRepository: vi.fn(),
  };
});

const mockUseFileRecordRepository = vi.mocked(useFileRecordRepository);

describe('useDatabaseStatusSync', () => {
  beforeEach(() => {
    __resetDatabaseStatusStoreForTests();
    mockUseFileRecordRepository.mockReset();
  });

  afterEach(() => {
    // Clean up any electronAPI mock
    Object.defineProperty(window, 'electronAPI', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  it('keeps loading when repository is not available', () => {
    mockUseFileRecordRepository.mockReturnValue(null);

    renderHook(() => useDatabaseStatusSync());

    const state = useDatabaseStatusStore.getState();
    expect(state.loading).toBe(true);
    expect(state.connected).toBe(false);
  });

  it('marks connection as connected for PGlite repository', async () => {
    mockUseFileRecordRepository.mockReturnValue({} as DrizzleFileRecordRepository);

    renderHook(() => useDatabaseStatusSync());

    await waitFor(() => expect(useDatabaseStatusStore.getState().connected).toBe(true));

    const state = useDatabaseStatusStore.getState();
    expect(state.loading).toBe(false);
    expect(state.location).toBe('PGlite WASM');
    expect(state.testResult).toBe('connected');
  });

  it('detects Electron environment and sets IPC location', async () => {
    // Mock window.electronAPI to simulate Electron environment
    // Use Object.defineProperty to bypass strict type checking for the mock
    Object.defineProperty(window, 'electronAPI', {
      value: { db: {} },
      writable: true,
      configurable: true,
    });

    mockUseFileRecordRepository.mockReturnValue({} as DrizzleFileRecordRepository);

    renderHook(() => useDatabaseStatusSync());

    await waitFor(() => expect(useDatabaseStatusStore.getState().connected).toBe(true));

    const state = useDatabaseStatusStore.getState();
    expect(state.location).toBe('Main Process');
    expect(state.testResult).toBe('Connected (IPC)');
  });

  it('reverts to loading when repository disappears after being connected', async () => {
    const repoRef: { current: DrizzleFileRecordRepository | null } = {
      current: {} as DrizzleFileRecordRepository,
    };

    mockUseFileRecordRepository.mockImplementation(
      () => repoRef.current as DrizzleFileRecordRepository | null
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
