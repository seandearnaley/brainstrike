import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingRuntimeProvider, useSharedEmbeddingRuntime } from '../embedding-runtime-provider';

const {
  createVectorQueueServiceMock,
  JobQueueMock,
  useEmbeddingRuntimeControllerMock,
  useFileChunkRepositoryMock,
  usePGliteDatabaseMock,
  useVectorPreferencesStoreMock,
} = vi.hoisted(() => ({
  createVectorQueueServiceMock: vi.fn(),
  JobQueueMock: vi.fn(function MockJobQueue(this: { db: unknown }, db: unknown) {
    this.db = db;
  }),
  useEmbeddingRuntimeControllerMock: vi.fn(),
  useFileChunkRepositoryMock: vi.fn(),
  usePGliteDatabaseMock: vi.fn(),
  useVectorPreferencesStoreMock: vi.fn(),
}));

vi.mock('@brainstrike/db', () => ({
  JobQueue: JobQueueMock,
  useFileChunkRepository: useFileChunkRepositoryMock,
  usePGliteDatabase: usePGliteDatabaseMock,
}));

vi.mock('@brainstrike/preferences/stores/vector-preferences-store', () => ({
  useVectorPreferencesStore: useVectorPreferencesStoreMock,
}));

vi.mock('../vector-status/embedding-runtime-controller', () => ({
  useEmbeddingRuntimeController: useEmbeddingRuntimeControllerMock,
}));

vi.mock('../vector-status/vector-queue-service', () => ({
  createVectorQueueService: createVectorQueueServiceMock,
}));

describe('EmbeddingRuntimeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePGliteDatabaseMock.mockReturnValue({ dialect: 'pglite' });
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
    useEmbeddingRuntimeControllerMock.mockReturnValue({
      ensureStarted: vi.fn(),
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

    expect(createVectorQueueServiceMock).toHaveBeenCalledWith({
      db: { dialect: 'pglite' },
      jobQueue: expect.objectContaining({
        db: { dialect: 'pglite' },
      }),
      chunkRepository: expect.objectContaining({
        clearEmbeddingsForSet: expect.any(Function),
        getCoverageForSet: expect.any(Function),
      }),
    });
    expect(useEmbeddingRuntimeControllerMock).toHaveBeenCalledWith({
      db: { dialect: 'pglite' },
      devicePreference: 'webgpu',
      reinitEveryN: 250,
      service: createVectorQueueServiceMock.mock.results[0]?.value ?? null,
    });
    expect(result.current.service).toBe(createVectorQueueServiceMock.mock.results[0]?.value);
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
    expect(useEmbeddingRuntimeControllerMock).toHaveBeenCalledWith({
      db: { dialect: 'pglite' },
      devicePreference: 'webgpu',
      reinitEveryN: 250,
      service: null,
    });
    expect(result.current.service).toBeNull();
  });
});
