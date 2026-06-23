import {
  ElectronFileRecordRepository,
  type FileRecordRepository,
  useFileRecordRepository,
  useOptionalDbInitializationStatus,
  useOptionalProfileBootstrapReport,
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
    useOptionalDbInitializationStatus: vi.fn(),
    useOptionalProfileBootstrapReport: vi.fn(),
  };
});

const mockUseOptionalDbInitializationStatus = vi.mocked(useOptionalDbInitializationStatus);
const mockUseFileRecordRepository = vi.mocked(useFileRecordRepository);
const mockUseOptionalProfileBootstrapReport = vi.mocked(useOptionalProfileBootstrapReport);

describe('useDatabaseStatusSync', () => {
  beforeEach(() => {
    __resetDatabaseStatusStoreForTests();
    mockUseOptionalDbInitializationStatus.mockReset();
    mockUseFileRecordRepository.mockReset();
    mockUseOptionalProfileBootstrapReport.mockReset();
    mockUseOptionalDbInitializationStatus.mockReturnValue('idle');
    mockUseOptionalProfileBootstrapReport.mockReturnValue({
      checks: [],
      failure: null,
      phase: 'opening-store',
      profileId: 'test',
      ready: false,
      runtime: {
        engine: 'pglite',
        host: 'browser',
        persistence: 'memory',
      },
      search: {
        indexedSearch: 'available',
        message: 'Indexed search is owned by the primary database store.',
        ownershipMode: 'primary-store-indexes',
      },
      startedAt: '2026-06-22T19:00:00.000Z',
      updatedAt: '2026-06-22T19:00:00.000Z',
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
      query: async () => ({ rows: [] }),
      exec: async () => {},
    });

    mockUseFileRecordRepository.mockReturnValue(electronRepo as unknown as FileRecordRepository);

    renderHook(() => useDatabaseStatusSync());

    await waitFor(() => expect(useDatabaseStatusStore.getState().connected).toBe(true));

    const state = useDatabaseStatusStore.getState();
    expect(state.location).toBe('Main Process');
    expect(state.testResult).toBe('Connected (IPC)');
  });

  it('marks Turso partial repository coverage connected without a file-record repository', async () => {
    mockUseOptionalDbInitializationStatus.mockReturnValue('ready');
    mockUseFileRecordRepository.mockReturnValue(null);
    mockUseOptionalProfileBootstrapReport.mockReturnValue({
      checks: [],
      failure: null,
      phase: 'ready',
      profileId: 'test',
      ready: true,
      runtime: {
        engine: 'turso',
        host: 'electron-utility',
        persistence: 'filesystem',
      },
      search: {
        indexedSearch: 'available',
        message: 'Indexed search is owned by a split search index store.',
        ownershipMode: 'split-search-index-store',
      },
      startedAt: '2026-06-22T19:00:00.000Z',
      updatedAt: '2026-06-22T19:00:01.000Z',
    });

    renderHook(() => useDatabaseStatusSync());

    await waitFor(() => expect(useDatabaseStatusStore.getState().connected).toBe(true));

    const state = useDatabaseStatusStore.getState();
    expect(state.loading).toBe(false);
    expect(state.location).toBe('Turso');
    expect(state.testResult).toBe('Connected (partial: file_records)');
  });

  it('uses the ready Turso bootstrap report even when a file-record repository is available', async () => {
    mockUseOptionalDbInitializationStatus.mockReturnValue('ready');
    mockUseFileRecordRepository.mockReturnValue({} as FileRecordRepository);
    mockUseOptionalProfileBootstrapReport.mockReturnValue({
      checks: [],
      failure: null,
      phase: 'ready',
      profileId: 'test',
      ready: true,
      runtime: {
        engine: 'turso',
        host: 'electron-utility',
        persistence: 'filesystem',
      },
      search: {
        indexedSearch: 'available',
        message: 'Indexed search is owned by a split search index store.',
        ownershipMode: 'split-search-index-store',
      },
      startedAt: '2026-06-22T19:00:00.000Z',
      updatedAt: '2026-06-22T19:00:01.000Z',
    });

    renderHook(() => useDatabaseStatusSync());

    await waitFor(() => expect(useDatabaseStatusStore.getState().connected).toBe(true));

    const state = useDatabaseStatusStore.getState();
    expect(state.location).toBe('Turso');
    expect(state.testResult).toBe('Connected (partial: file_records)');
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
