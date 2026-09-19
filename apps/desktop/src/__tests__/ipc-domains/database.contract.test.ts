import { describe, expect, it } from 'vitest';
import {
  databaseChunkingContract,
  databaseContract,
  databaseEmbeddingContract,
  databaseLiveContract,
  databasePathContract,
} from '../../ipc-domains/database.contract';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

describe('database IPC contracts', () => {
  it('pins the visible database bridge to raw manifest channels and exact sender roles', () => {
    expect(Object.keys(databaseContract).sort()).toEqual([
      'applyManagedCacheBatch',
      'clearAll',
      'diagnostics',
      'exec',
      'insertChunksAndEnqueueEmbeddingJobs',
      'invalidateManagedCacheEntriesByIdentity',
      'ping',
      'query',
      'resetLocal',
      'runTransaction',
      'schedulerSnapshot',
      'test',
    ]);
    expect(databaseContract.query).toMatchObject({
      channel: DESKTOP_IPC_CHANNELS.db.query,
      envelope: 'raw',
      roles: ['chunking-host', 'embedding-host', 'visible-ui'],
    });
    for (const [key, spec] of Object.entries(databaseContract)) {
      expect(spec.kind, key).toBe('invoke');
      expect(spec.envelope, key).toBe('raw');
      if (key !== 'query' && key !== 'clearAll' && key !== 'ping' && key !== 'resetLocal') {
        expect(spec.roles, key).toEqual(['embedding-host', 'visible-ui']);
      }
    }
    for (const key of ['clearAll', 'ping', 'resetLocal'] as const) {
      expect(databaseContract[key].roles).toEqual(['visible-ui']);
    }
  });

  it('derives exact role-specific hidden-host subsets without widening capabilities', () => {
    expect(Object.keys(databaseChunkingContract)).toEqual(['query']);
    expect(Object.keys(databaseEmbeddingContract).sort()).toEqual([
      'applyManagedCacheBatch',
      'diagnostics',
      'exec',
      'insertChunksAndEnqueueEmbeddingJobs',
      'invalidateManagedCacheEntriesByIdentity',
      'query',
      'runTransaction',
      'schedulerSnapshot',
      'test',
    ]);
    expect(databaseEmbeddingContract).not.toHaveProperty('clearAll');
    expect(databaseEmbeddingContract).not.toHaveProperty('ping');
    expect(databaseEmbeddingContract).not.toHaveProperty('resetLocal');
  });

  it('keeps live query and database path capabilities visible-UI-only', () => {
    expect(Object.keys(databaseLiveContract).sort()).toEqual([
      'onUpdate',
      'refresh',
      'start',
      'stop',
    ]);
    expect(databaseLiveContract.onUpdate).toEqual({
      channel: DESKTOP_IPC_CHANNELS.db.liveQueryUpdate,
      kind: 'push',
    });
    for (const spec of Object.values(databaseLiveContract)) {
      if (spec.kind === 'invoke') {
        expect(spec.roles).toEqual(['visible-ui']);
        expect(spec.envelope).toBe('raw');
      }
    }
    expect(databasePathContract.getUserDataPath).toMatchObject({
      channel: DESKTOP_IPC_CHANNELS.db.getUserDataPath,
      envelope: 'raw',
      roles: ['visible-ui'],
    });
  });

  it('normalizes public chunk arguments into the canonical tuple without moving validation', () => {
    const chunks = [{ id: 'chunk-1' }];
    const options = { model: 'model-1', targetDimension: 384 };
    const workOptions = { priority: 'background' as const };
    expect(
      databaseContract.insertChunksAndEnqueueEmbeddingJobs.parseArgs([
        chunks,
        'file-1',
        options,
        workOptions,
      ])
    ).toEqual([chunks, 'file-1', options, workOptions]);
    expect(() =>
      databaseContract.insertChunksAndEnqueueEmbeddingJobs.parseArgs([chunks, 'file-1'])
    ).toThrow('database insertChunksAndEnqueueEmbeddingJobs requires between 3 and 4 arguments');
  });

  it('rejects malformed top-level argument shapes before handlers run', () => {
    expect(() => databaseContract.query.parseArgs([42])).toThrow(
      'database query sql must be a string'
    );
    expect(() => databaseContract.runTransaction.parseArgs([[]])).toThrow(
      'database runTransaction requires between 2 and 3 arguments'
    );
    expect(() => databaseContract.runTransaction.parseArgs([[], 0, undefined, 'extra'])).toThrow(
      'database runTransaction requires between 2 and 3 arguments'
    );
    expect(() => databaseLiveContract.stop.parseArgs(['1'])).toThrow(
      'database live stop id must be a finite number'
    );
    expect(() => databasePathContract.getUserDataPath.parseArgs(['extra'])).toThrow(
      'database getUserDataPath requires exactly 0 arguments'
    );
  });
});
