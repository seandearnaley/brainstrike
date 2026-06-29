import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingRuntimeProvider, useSharedEmbeddingRuntime } from '../embedding-runtime-provider';

const {
  createTursoVectorQueueSnapshotReaderMock,
  createVectorQueueServiceMock,
  createVectorQueueServiceForRuntimeMock,
  createTursoJobQueueReadModelMock,
  JobQueueMock,
  useEmbeddingRuntimeControllerMock,
  useFileChunkRepositoryMock,
  useModelRegistryDbClientMock,
  useOptionalProfileBootstrapReportMock,
  useVectorPreferencesStoreMock,
} = vi.hoisted(() => ({
  createTursoVectorQueueSnapshotReaderMock: vi.fn(),
  createVectorQueueServiceMock: vi.fn(),
  createVectorQueueServiceForRuntimeMock: vi.fn(),
  createTursoJobQueueReadModelMock: vi.fn((db: unknown) => ({ db })),
  JobQueueMock: vi.fn(function MockJobQueue(this: { db: unknown }, db: unknown) {
    this.db = db;
  }),
  useEmbeddingRuntimeControllerMock: vi.fn(),
  useFileChunkRepositoryMock: vi.fn(),
  useModelRegistryDbClientMock: vi.fn(),
  useOptionalProfileBootstrapReportMock: vi.fn(),
  useVectorPreferencesStoreMock: vi.fn(),
}));

vi.mock('@brainstrike/db', () => ({
  createTursoJobQueueReadModel: createTursoJobQueueReadModelMock,
  JobQueue: JobQueueMock,
  useFileChunkRepository: useFileChunkRepositoryMock,
  useModelRegistryDbClient: useModelRegistryDbClientMock,
  useOptionalProfileBootstrapReport: useOptionalProfileBootstrapReportMock,
}));

vi.mock('@brainstrike/preferences/stores/vector-preferences-store', () => ({
  useVectorPreferencesStore: useVectorPreferencesStoreMock,
}));

vi.mock('../vector-status/embedding-runtime-controller', () => ({
  useEmbeddingRuntimeController: useEmbeddingRuntimeControllerMock,
}));

vi.mock('../vector-status/vector-queue-service', () => ({
  createVectorQueueService: createVectorQueueServiceMock,
  createVectorQueueServiceForRuntime: createVectorQueueServiceForRuntimeMock,
}));

vi.mock('../vector-status/turso-vector-queue-metrics-repository', () => ({
  createTursoVectorQueueSnapshotReader: createTursoVectorQueueSnapshotReaderMock,
}));

describe('EmbeddingRuntimeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useModelRegistryDbClientMock.mockReturnValue({ dialect: 'pglite' });
    useOptionalProfileBootstrapReportMock.mockReturnValue({
      runtime: { engine: 'pglite', host: 'browser', persistence: 'memory' },
    });
    useFileChunkRepositoryMock.mockReturnValue({
      clearEmbeddingsForSet: vi.fn(),
      getCoverageForSet: vi.fn(),
    });
    useVectorPreferencesStoreMock.mockImplementation(
      (selector: (state: { devicePref: 'wasm' | 'webgpu'; reinitEveryN: number }) => unknown) =>
        selector({
          devicePref: 'webgpu',
          reinitEveryN: 250,
        })
    );
    createVectorQueueServiceMock.mockReturnValue({ backfill: vi.fn() });
    createVectorQueueServiceForRuntimeMock.mockImplementation(
      (input: { chunkRepository: unknown; runtimeEngine: string }) => {
        if (!input.chunkRepository) {
          return {
            available: false,
            reason: 'missing-db-or-coverage-repository',
            service: null,
          };
        }
        if (input.runtimeEngine === 'turso') {
          return {
            available: false,
            reason: 'turso-vector-backfill-not-migrated',
            service: null,
          };
        }
        return {
          available: true,
          reason: null,
          service: { backfill: vi.fn() },
        };
      }
    );
    useEmbeddingRuntimeControllerMock.mockReturnValue({
      ensureStarted: vi.fn(),
    });
    createTursoVectorQueueSnapshotReaderMock.mockReturnValue({
      refresh: vi.fn(),
    });
  });

  it('throws when the shared runtime hook is used outside the provider', () => {
    expect(() => renderHook(() => useSharedEmbeddingRuntime())).toThrow(
      'EmbeddingRuntimeProvider is required before using the shared embedding runtime.'
    );
  });

  it('creates a queue service when both db and coverage repository are available', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EmbeddingRuntimeProvider>{children}</EmbeddingRuntimeProvider>
    );

    const { result } = renderHook(() => useSharedEmbeddingRuntime(), { wrapper });

    expect(createVectorQueueServiceForRuntimeMock).toHaveBeenCalledWith({
      db: { dialect: 'pglite' },
      chunkRepository: expect.objectContaining({
        clearEmbeddingsForSet: expect.any(Function),
        getCoverageForSet: expect.any(Function),
      }),
      createPGliteJobQueue: expect.any(Function),
      runtimeEngine: 'pglite',
    });
    const factoryArgs = createVectorQueueServiceForRuntimeMock.mock.calls[0]?.[0];
    expect(factoryArgs?.createPGliteJobQueue({ dialect: 'pglite' })).toEqual(
      expect.objectContaining({ db: { dialect: 'pglite' } })
    );
    expect(useEmbeddingRuntimeControllerMock).toHaveBeenCalledWith({
      db: { dialect: 'pglite' },
      devicePreference: 'webgpu',
      reinitEveryN: 250,
      service: createVectorQueueServiceForRuntimeMock.mock.results[0]?.value.service ?? null,
    });
    expect(result.current.service).toBe(
      createVectorQueueServiceForRuntimeMock.mock.results[0]?.value.service
    );
  });

  it('falls back to a null service when the repository is not coverage-capable', () => {
    useFileChunkRepositoryMock.mockReturnValue({
      count: vi.fn(),
    });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <EmbeddingRuntimeProvider>{children}</EmbeddingRuntimeProvider>
    );

    const { result } = renderHook(() => useSharedEmbeddingRuntime(), { wrapper });

    expect(createVectorQueueServiceMock).not.toHaveBeenCalled();
    expect(createVectorQueueServiceForRuntimeMock).toHaveBeenCalledWith({
      db: { dialect: 'pglite' },
      chunkRepository: null,
      createPGliteJobQueue: expect.any(Function),
      runtimeEngine: 'pglite',
    });
    expect(useEmbeddingRuntimeControllerMock).toHaveBeenCalledWith({
      db: { dialect: 'pglite' },
      devicePreference: 'webgpu',
      reinitEveryN: 250,
      service: null,
    });
    expect(result.current.service).toBeNull();
  });

  it('passes turso runtime through as unavailable while constructing a read-only snapshot reader', () => {
    useModelRegistryDbClientMock.mockReturnValue({ dialect: 'turso' });
    useOptionalProfileBootstrapReportMock.mockReturnValue({
      runtime: { engine: 'turso', host: 'electron-utility', persistence: 'filesystem' },
    });
    createVectorQueueServiceForRuntimeMock.mockReturnValue({
      available: false,
      reason: 'turso-vector-backfill-not-migrated',
      service: null,
    });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <EmbeddingRuntimeProvider>{children}</EmbeddingRuntimeProvider>
    );

    const { result } = renderHook(() => useSharedEmbeddingRuntime(), { wrapper });

    expect(createVectorQueueServiceForRuntimeMock).toHaveBeenCalledWith({
      db: { dialect: 'turso' },
      chunkRepository: expect.objectContaining({
        clearEmbeddingsForSet: expect.any(Function),
        getCoverageForSet: expect.any(Function),
      }),
      createPGliteJobQueue: expect.any(Function),
      runtimeEngine: 'turso',
    });
    expect(JobQueueMock).not.toHaveBeenCalled();
    expect(createVectorQueueServiceMock).not.toHaveBeenCalled();
    expect(createTursoJobQueueReadModelMock).toHaveBeenCalledWith({ dialect: 'turso' });
    expect(createTursoVectorQueueSnapshotReaderMock).toHaveBeenCalledWith({
      chunkRepository: expect.objectContaining({
        clearEmbeddingsForSet: expect.any(Function),
        getCoverageForSet: expect.any(Function),
      }),
      jobQueue: expect.objectContaining({ db: { dialect: 'turso' } }),
    });
    expect(useEmbeddingRuntimeControllerMock).toHaveBeenCalledWith({
      db: null,
      devicePreference: 'webgpu',
      reinitEveryN: 250,
      service: null,
    });
    expect(result.current.service).toBeNull();
    expect(result.current.snapshotReader).toBe(
      createTursoVectorQueueSnapshotReaderMock.mock.results[0]?.value
    );
    expect(result.current.serviceUnavailableReason).toBe('turso-vector-backfill-not-migrated');
  });
});
