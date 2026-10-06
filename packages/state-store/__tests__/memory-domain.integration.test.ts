import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import {
  executeMemoryRequest,
  executeNativeMemoryRequest,
  MEMORY_SCHEMA,
  MemoryRevisionConflictError,
} from '../src/memory-domain.mjs';
import type { MemoryEntity, MemorySnapshot } from '../src/memory-types.js';
import { migrate } from '../src/schema.mjs';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrate(db);
  db.exec(MEMORY_SCHEMA);
  db.prepare('INSERT INTO threads(id,last_seq,created_at,updated_at) VALUES(?,0,0,0)').run(
    'thread'
  );
  return db;
}

const thread: MemoryEntity = {
  id: 'thread',
  kind: 'thread',
  payload: { id: 'thread', metadata: {}, resourceId: 'resource' },
  threadId: 'thread',
};
const resource: MemoryEntity = {
  id: 'resource',
  kind: 'resource',
  payload: { id: 'resource', workingMemory: 'retained' },
  threadId: null,
};
const observation: MemoryEntity = {
  id: 'observation',
  kind: 'observation',
  payload: {
    activeObservations: 'shared',
    id: 'observation',
    resourceId: 'resource',
    threadId: null,
  },
  threadId: null,
};
function commit(
  db: Database.Database,
  expectedRevision: number,
  entities: readonly MemoryEntity[]
): MemorySnapshot {
  return executeMemoryRequest(db, {
    changes: entities.map((entity) => ({ entity, operation: 'put' })),
    expectedRevision,
    operation: 'commit',
    resourceId: 'resource',
  });
}

describe('memory leaf on an isolated SQLite connection (not host qualification)', () => {
  test('a stale atomic update cannot overwrite metadata or partially insert observations', () => {
    const db = setup();
    try {
      const original = commit(db, 0, [thread, resource]);
      expect(() =>
        commit(db, 0, [
          observation,
          { ...resource, payload: { ...resource.payload, workingMemory: 'stale' } },
        ])
      ).toThrow(MemoryRevisionConflictError);
      expect(executeMemoryRequest(db, { operation: 'read', resourceId: 'resource' })).toEqual(
        original
      );
      expect(() =>
        commit(db, 1, [
          observation,
          {
            ...thread,
            id: 'absent',
            payload: { id: 'absent', resourceId: 'resource' },
            threadId: 'absent',
          },
        ])
      ).toThrow(/FOREIGN KEY/);
      expect(executeMemoryRequest(db, { operation: 'read', resourceId: 'resource' })).toEqual(
        original
      );
    } finally {
      db.close();
    }
  });

  test('native calculation commits only against its exact input snapshot', async () => {
    const db = setup();
    try {
      commit(db, 0, [thread]);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const pending = executeNativeMemoryRequest(
        db,
        { arguments: [], method: 'saveResource', operation: 'native', resourceId: 'resource' },
        async () => {
          entered.resolve();
          await release.promise;
          return { changes: [{ entity: resource, operation: 'put' }], value: null };
        }
      );
      await entered.promise;
      const latest = commit(db, 1, [observation]);
      release.resolve();
      await expect(pending).rejects.toBeInstanceOf(MemoryRevisionConflictError);
      expect(executeMemoryRequest(db, { operation: 'read', resourceId: 'resource' })).toEqual(
        latest
      );
    } finally {
      db.close();
    }
  });

  test('thread purge makes its shared-resource erasure policy explicit', () => {
    const db = setup();
    try {
      commit(db, 0, [thread, resource, observation]);
      const retained = executeMemoryRequest(db, {
        operation: 'purge-thread',
        resourceId: 'resource',
        sharedResource: 'preserve',
        threadId: 'thread',
      });
      expect(retained.entities.map((entry) => entry.kind).sort()).toEqual([
        'observation',
        'resource',
      ]);
      const cleared = executeMemoryRequest(db, {
        operation: 'purge-thread',
        resourceId: 'resource',
        sharedResource: 'clear',
        threadId: 'thread',
      });
      expect(cleared.entities).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('the leaf cannot move an identity across resource owners', () => {
    const db = setup();
    try {
      commit(db, 0, [thread]);
      expect(() =>
        executeMemoryRequest(db, {
          changes: [
            {
              entity: { ...thread, payload: { ...thread.payload, resourceId: 'other' } },
              operation: 'put',
            },
          ],
          expectedRevision: 0,
          operation: 'commit',
          resourceId: 'other',
        })
      ).toThrow(/another resource/);
      expect(executeMemoryRequest(db, { operation: 'read', resourceId: 'other' })).toEqual({
        entities: [],
        revision: 0,
      });
    } finally {
      db.close();
    }
  });
});
