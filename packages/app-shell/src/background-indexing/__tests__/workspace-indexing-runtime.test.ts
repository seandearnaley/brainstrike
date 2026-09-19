import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceIndexingQosResolver,
  createWorkspaceIndexingRepositories,
} from '../workspace-indexing-runtime';

describe('workspace indexing runtime construction', () => {
  it('rejects a database handle that cannot support repository writes', () => {
    const db = {
      query: async () => ({ rows: [] }),
    } as unknown as DbHandle;

    expect(() => createWorkspaceIndexingRepositories(db)).toThrow(
      'Background indexing requires database exec support.'
    );
  });

  it('rejects QoS resolution without scheduler pressure readers', async () => {
    const resolveQosPolicy = createWorkspaceIndexingQosResolver({
      observeTransition: vi.fn(),
      readBackgroundIndexingPaused: () => false,
      readDatabasePressure: null,
      readForegroundQueryActive: () => false,
      readPipelineInputs: null,
      readPowerSnapshot: null,
      readRecentUserInputMs: () => null,
      readWindowVisible: () => true,
    });

    await expect(resolveQosPolicy()).rejects.toThrow(
      'Workspace Index QoS requires database scheduler snapshots.'
    );
  });

  it('binds repository database methods and exposes the atomic insert capability conditionally', async () => {
    const db = {
      exec(this: { marker: string }) {
        expect(this.marker).toBe('database-handle');
        return Promise.resolve();
      },
      insertChunksAndEnqueueEmbeddingJobs(this: { marker: string }) {
        expect(this.marker).toBe('database-handle');
        return Promise.resolve();
      },
      marker: 'database-handle',
      query(this: { marker: string }) {
        expect(this.marker).toBe('database-handle');
        return Promise.resolve({ rows: [] });
      },
    } as unknown as DbHandle;

    const repositories = createWorkspaceIndexingRepositories(db);
    const repositoryDb = (
      repositories.chunkRepository as unknown as {
        db: {
          insertChunksAndEnqueueEmbeddingJobs?: (...args: unknown[]) => Promise<void>;
          query: (sql: string) => Promise<{ rows: unknown[] }>;
        };
      }
    ).db;

    await expect(repositoryDb.query('SELECT 1')).resolves.toEqual({ rows: [] });
    expect(repositoryDb.insertChunksAndEnqueueEmbeddingJobs).toBeTypeOf('function');
    await expect(repositoryDb.insertChunksAndEnqueueEmbeddingJobs?.()).resolves.toBeUndefined();

    const withoutAtomicInsert = createWorkspaceIndexingRepositories({
      exec: async () => undefined,
      query: async () => ({ rows: [] }),
    } as unknown as DbHandle);
    const repositoryDbWithoutAtomicInsert = (
      withoutAtomicInsert.chunkRepository as unknown as {
        db: { insertChunksAndEnqueueEmbeddingJobs?: unknown };
      }
    ).db;
    expect(repositoryDbWithoutAtomicInsert.insertChunksAndEnqueueEmbeddingJobs).toBeUndefined();
  });
});
