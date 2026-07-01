import { checkApiKeyAvailability } from '@brainstrike/embeddings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopTursoVectorQueueService } from '../vector-status/desktop-turso-vector-queue-service';
import type {
  VectorQueueDatabase,
  VectorQueueSnapshotReader,
} from '../vector-status/vector-queue-service';

vi.mock('@brainstrike/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/embeddings')>();
  return {
    ...actual,
    checkApiKeyAvailability: vi.fn(),
  };
});

describe('createDesktopTursoVectorQueueService', () => {
  const testWindow = window as Window & {
    electronAPI?: {
      db?: {
        tursoVectorQueueAction?: (
          operation: string,
          payload: unknown,
          options?: unknown
        ) => Promise<unknown>;
      };
    };
  };

  beforeEach(() => {
    vi.mocked(checkApiKeyAvailability).mockReset();
    vi.mocked(checkApiKeyAvailability).mockResolvedValue({ available: true });
  });

  afterEach(() => {
    Reflect.deleteProperty(testWindow, 'electronAPI');
  });

  it('routes Turso queue actions through the desktop owner bridge while snapshots stay read-only', async () => {
    const actionBridge = vi.fn(async (operation: string) =>
      operation === 'clearEmbeddingsForSet' ? { cleared: 7 } : undefined
    );
    Object.defineProperty(testWindow, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        db: {
          tursoVectorQueueAction: actionBridge,
        },
      },
    });
    const db: VectorQueueDatabase = {
      query: vi.fn(async () => ({
        rows: [{ modelKey: 'openai::text-embedding-3-small' }],
      })) as VectorQueueDatabase['query'],
    };
    const snapshotReader: VectorQueueSnapshotReader = {
      refresh: vi.fn(async () => ({
        activeSetQueueCounts: { failed: 0, queued: 1, running: 0, succeeded: 2 },
        coverage: { total: 3, withSet: 2 },
        lastError: null,
        latency: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
        queueCounts: { failed: 0, queued: 1, running: 0, succeeded: 2 },
        throughput: 5,
      })),
    };

    const service = createDesktopTursoVectorQueueService({ db, snapshotReader });

    expect(service).not.toBeNull();
    await expect(service?.refresh('set-1')).resolves.toMatchObject({ throughput: 5 });
    expect(snapshotReader.refresh).toHaveBeenCalledWith('set-1');
    await expect(service?.validateApiKeyForSet('set-1')).resolves.toEqual({ valid: true });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = ?'), ['set-1']);
    expect(db.query).toHaveBeenCalledWith(expect.not.stringContaining('$1'), ['set-1']);
    expect(db.query).toHaveBeenCalledWith(expect.not.stringContaining('dimensions'), ['set-1']);
    expect(checkApiKeyAvailability).toHaveBeenCalledWith('openai::text-embedding-3-small');

    await service?.retryFailed(12);
    await service?.clearQueue(['failed']);
    await service?.wipeQueue();
    await expect(service?.clearEmbeddingsForSet('set-1')).resolves.toBe(7);

    expect(actionBridge).toHaveBeenCalledWith(
      'retryFailed',
      { limit: 12 },
      { label: 'turso.vector-queue.action.retryFailed', priority: 'normal' }
    );
    expect(actionBridge).toHaveBeenCalledWith(
      'clearQueue',
      { states: ['failed'] },
      { label: 'turso.vector-queue.action.clearQueue', priority: 'normal' }
    );
    expect(actionBridge).toHaveBeenCalledWith('wipeQueue', null, {
      label: 'turso.vector-queue.action.wipeQueue',
      priority: 'normal',
    });
    expect(actionBridge).toHaveBeenCalledWith(
      'clearEmbeddingsForSet',
      { embeddingSetId: 'set-1' },
      { label: 'turso.vector-queue.action.clearEmbeddingsForSet', priority: 'normal' }
    );
  });

  it('returns null when the desktop owner bridge is unavailable', () => {
    Object.defineProperty(testWindow, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { db: {} },
    });
    const db: VectorQueueDatabase = {
      query: vi.fn(async () => ({ rows: [] })) as VectorQueueDatabase['query'],
    };
    const snapshotReader: VectorQueueSnapshotReader = {
      refresh: vi.fn(),
    };

    expect(createDesktopTursoVectorQueueService({ db, snapshotReader })).toBeNull();
  });

  it('fails closed for direct backfill calls that must use the embedding runtime controller', async () => {
    const actionBridge = vi.fn(async () => undefined);
    Object.defineProperty(testWindow, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        db: {
          tursoVectorQueueAction: actionBridge,
        },
      },
    });
    const db: VectorQueueDatabase = {
      query: vi.fn(async () => ({ rows: [] })) as VectorQueueDatabase['query'],
    };
    const snapshotReader: VectorQueueSnapshotReader = {
      refresh: vi.fn(),
    };
    const service = createDesktopTursoVectorQueueService({ db, snapshotReader });

    await expect(service?.backfill('set-1', { onProgress: vi.fn() })).rejects.toThrow(
      'Desktop Turso backfill must be enqueued through the embedding runtime controller.'
    );
    expect(actionBridge).not.toHaveBeenCalled();
  });

  it('fails closed for direct re-embed calls that must coordinate through clear plus host backfill', async () => {
    const actionBridge = vi.fn(async () => undefined);
    Object.defineProperty(testWindow, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        db: {
          tursoVectorQueueAction: actionBridge,
        },
      },
    });
    const db: VectorQueueDatabase = {
      query: vi.fn(async () => ({ rows: [] })) as VectorQueueDatabase['query'],
    };
    const snapshotReader: VectorQueueSnapshotReader = {
      refresh: vi.fn(),
    };
    const service = createDesktopTursoVectorQueueService({ db, snapshotReader });

    await expect(service?.reembedSet('set-1', vi.fn())).rejects.toThrow(
      'Desktop Turso re-embed must be coordinated through the embedding runtime controller.'
    );
    expect(actionBridge).not.toHaveBeenCalled();
  });
});
