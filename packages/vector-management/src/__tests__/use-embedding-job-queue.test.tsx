import {
  createTursoJobQueueReadModel,
  JobQueue,
  useModelRegistryDbClient,
  useOptionalProfileBootstrapReport,
} from '@brainstrike/db';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmbeddingJobQueue } from '../use-embedding-job-queue';

vi.mock('@brainstrike/db', () => ({
  JobQueue: vi.fn(function MockJobQueue(this: { db: unknown; kind: string }, db: unknown) {
    this.db = db;
    this.kind = 'pglite';
  }),
  createTursoJobQueueReadModel: vi.fn((db: unknown) => ({
    db,
    getQueueStats: vi.fn(),
    kind: 'turso-read',
  })),
  useModelRegistryDbClient: vi.fn(),
  useOptionalProfileBootstrapReport: vi.fn(),
}));

function mockReport(engine: 'pglite' | 'turso', ready = true) {
  vi.mocked(useOptionalProfileBootstrapReport).mockReturnValue({
    ready,
    runtime: { engine },
  } as never);
}

describe('useEmbeddingJobQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useModelRegistryDbClient).mockReturnValue({ query: vi.fn() } as never);
    mockReport('pglite');
  });

  it('uses the PGlite job queue for PGlite profiles', () => {
    const { result } = renderHook(() => useEmbeddingJobQueue());

    expect(JobQueue).toHaveBeenCalledWith({ query: expect.any(Function) });
    expect(createTursoJobQueueReadModel).not.toHaveBeenCalled();
    expect(result.current).toEqual(expect.objectContaining({ kind: 'pglite' }));
  });

  it('uses the Turso read model without exposing retry mutations for Turso profiles', () => {
    mockReport('turso');
    const db = { query: vi.fn() };
    vi.mocked(useModelRegistryDbClient).mockReturnValue(db as never);

    const { result } = renderHook(() => useEmbeddingJobQueue());

    expect(createTursoJobQueueReadModel).toHaveBeenCalledWith(db);
    expect(JobQueue).not.toHaveBeenCalled();
    expect(result.current).toEqual(expect.objectContaining({ kind: 'turso-read' }));
    expect('repairUnclaimableQueued' in (result.current ?? {})).toBe(false);
    expect('requeueFailed' in (result.current ?? {})).toBe(false);
  });

  it('returns null for Turso profiles without a db client', () => {
    mockReport('turso');
    vi.mocked(useModelRegistryDbClient).mockReturnValue(null);

    const { result } = renderHook(() => useEmbeddingJobQueue());

    expect(createTursoJobQueueReadModel).not.toHaveBeenCalled();
    expect(JobQueue).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('returns null until the runtime report is ready', () => {
    mockReport('turso', false);

    const { result } = renderHook(() => useEmbeddingJobQueue());

    expect(JobQueue).not.toHaveBeenCalled();
    expect(createTursoJobQueueReadModel).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});
