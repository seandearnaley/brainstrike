import {
  extractDbExecutionClient,
  JobQueue,
  TursoJobQueue,
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
  TursoJobQueue: vi.fn(function MockTursoJobQueue(
    this: { db: unknown; kind: string },
    db: unknown
  ) {
    this.db = db;
    this.kind = 'turso';
  }),
  extractDbExecutionClient: vi.fn((db: { raw?: unknown }) => db.raw ?? null),
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
    expect(TursoJobQueue).not.toHaveBeenCalled();
    expect(result.current).toEqual(expect.objectContaining({ kind: 'pglite' }));
  });

  it('uses the Turso job queue for Turso profiles', () => {
    mockReport('turso');
    const rawClient = { exec: vi.fn(), query: vi.fn(), transaction: vi.fn() };
    vi.mocked(useModelRegistryDbClient).mockReturnValue({
      query: vi.fn(),
      raw: rawClient,
    } as never);

    const { result } = renderHook(() => useEmbeddingJobQueue());

    expect(extractDbExecutionClient).toHaveBeenCalledWith(
      expect.objectContaining({ raw: rawClient })
    );
    expect(TursoJobQueue).toHaveBeenCalledWith(rawClient);
    expect(JobQueue).not.toHaveBeenCalled();
    expect(result.current).toEqual(expect.objectContaining({ kind: 'turso' }));
  });

  it('returns null for Turso profiles without a runtime execution client', () => {
    mockReport('turso');

    const { result } = renderHook(() => useEmbeddingJobQueue());

    expect(TursoJobQueue).not.toHaveBeenCalled();
    expect(JobQueue).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('returns null until the runtime report is ready', () => {
    mockReport('turso', false);

    const { result } = renderHook(() => useEmbeddingJobQueue());

    expect(JobQueue).not.toHaveBeenCalled();
    expect(TursoJobQueue).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});
