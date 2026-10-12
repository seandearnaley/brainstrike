import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import {
  executeMemoryRequest,
  executeNativeMemoryRequest,
  MemoryRevisionConflictError,
} from '../src/memory-domain.mjs';
import type { MemoryEntity, MemorySnapshot } from '../src/memory-types.js';
import { migrate } from '../src/schema.mjs';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrate(db);
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
const calculator = new URL(
  '../../agent-host/dist/adapters/memory-storage-calculator.js',
  import.meta.url
).href;

/** Mastra OM's own observation token counter, from the module the production writer loads. */
async function observationTokenCounter(): Promise<(text: string) => number> {
  const module: unknown = await import(calculator);
  if (
    !(
      module &&
      typeof module === 'object' &&
      'countObservationTokens' in module &&
      typeof module.countObservationTokens === 'function'
    )
  ) {
    throw new Error('The memory calculator exports no observation token counter');
  }
  const counter = module.countObservationTokens;
  return (text) => {
    const counted: unknown = counter(text);
    if (typeof counted !== 'number') {
      throw new TypeError('The observation token counter returned no number');
    }
    return counted;
  };
}

const section = (id: string, text: string): string =>
  `<thread id="${id}">\nDate: Oct 7, 2026\n${text}\n</thread>`;
const boundary = '\n\n--- message boundary (2026-10-07T01:02:03.000Z) ---\n\n';
const detach = {
  operation: 'purge-thread',
  resourceId: 'resource',
  sharedResource: 'detach-thread',
  threadId: 'thread',
} as const;

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

  test('detaching a deleted thread removes only its sections and recounts their token fields', async () => {
    const count = await observationTokenCounter();
    const db = setup();
    const kept = [section('other', 'kept one'), section('other', 'kept two')].join(boundary);
    const keptChunk = section('other', 'kept chunk');
    const keptReflection = section('other', 'reflected kept');
    // Mastra reflected the first two sections and their boundary (4 + 3 + 4 lines);
    // only 'kept one' is left of that prefix.
    const keptReflectedLines = 4;
    try {
      commit(db, 0, [
        thread,
        resource,
        {
          ...observation,
          payload: {
            ...observation.payload,
            activeObservations: [
              section('thread', 'deleted first'),
              section('other', 'kept one'),
              section('thread', 'deleted middle'),
              section('other', 'kept two'),
            ].join(boundary),
            bufferedObservationChunks: [
              {
                messageIds: ['a'],
                observations: section('thread', 'deleted chunk'),
                tokenCount: 50,
              },
              {
                messageIds: ['b'],
                observations: [section('thread', 'mixed deleted'), keptChunk].join('\n\n'),
                tokenCount: 60,
              },
              { messageIds: ['c'], observations: section('other', 'untouched'), tokenCount: 7 },
            ],
            bufferedObservations: null,
            bufferedReflection: [section('thread', 'reflected deleted'), keptReflection].join(
              '\n\n'
            ),
            bufferedReflectionInputTokens: 90,
            bufferedReflectionTokens: 40,
            observationTokenCount: 120,
            reflectedObservationLineCount: 11,
          },
        },
      ]);
      const detached = executeMemoryRequest(db, detach, count);
      expect(detached.entities.map((entry) => entry.kind).sort()).toEqual([
        'observation',
        'resource',
      ]);
      expect(detached.entities.find((entry) => entry.kind === 'resource')).toEqual(resource);
      expect(kept.split('\n').slice(0, keptReflectedLines).join('\n')).toBe(
        section('other', 'kept one')
      );
      expect(detached.entities.find((entry) => entry.kind === 'observation')?.payload).toEqual({
        ...observation.payload,
        activeObservations: kept,
        bufferedObservationChunks: [
          { messageIds: ['b'], observations: keptChunk, tokenCount: count(keptChunk) },
          { messageIds: ['c'], observations: section('other', 'untouched'), tokenCount: 7 },
        ],
        bufferedObservations: null,
        bufferedReflection: keptReflection,
        // Mastra's own slice estimate: the record's tokens per active line, times the reflected lines.
        bufferedReflectionInputTokens: Math.round(
          (count(kept) / kept.split('\n').length) * keptReflectedLines
        ),
        bufferedReflectionTokens: count(keptReflection),
        observationTokenCount: count(kept),
        reflectedObservationLineCount: keptReflectedLines,
      });
    } finally {
      db.close();
    }
  });

  test('a buffered reflection of only the deleted thread is cleared, as Mastra clears an activated one', async () => {
    const count = await observationTokenCounter();
    const db = setup();
    const kept = section('other', 'kept');
    try {
      commit(db, 0, [
        thread,
        {
          ...observation,
          payload: {
            ...observation.payload,
            activeObservations: [section('thread', 'deleted'), kept].join(boundary),
            bufferedReflection: section('thread', 'reflected deleted'),
            bufferedReflectionInputTokens: 20,
            bufferedReflectionTokens: 10,
            observationTokenCount: 30,
            reflectedObservationLineCount: 4,
          },
        },
      ]);
      const detached = executeMemoryRequest(db, detach, count);
      expect(detached.entities.find((entry) => entry.kind === 'observation')?.payload).toEqual({
        ...observation.payload,
        activeObservations: kept,
        observationTokenCount: count(kept),
      });
    } finally {
      db.close();
    }
  });

  test('detaching without the observation token counter fails and changes nothing', () => {
    const db = setup();
    try {
      const before = commit(db, 0, [
        thread,
        {
          ...observation,
          payload: {
            ...observation.payload,
            activeObservations: [section('thread', 'deleted'), section('other', 'kept')].join(
              boundary
            ),
            observationTokenCount: 30,
          },
        },
      ]);
      expect(() => executeMemoryRequest(db, detach)).toThrow(/observation token counter/);
      expect(executeMemoryRequest(db, { operation: 'read', resourceId: 'resource' })).toEqual(
        before
      );
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
