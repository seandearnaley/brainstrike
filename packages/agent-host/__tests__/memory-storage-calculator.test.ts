import { expect, test } from 'vitest';
import type { MemoryNativeRequest, MemorySnapshot } from '../../state-store/dist/memory-types.js';
import { calculateMemoryMutation } from '../src/adapters/memory-storage-calculator.js';
import {
  decodeMemory,
  encodeMemory,
  memoryConfiguration,
} from '../src/adapters/memory-storage-codec.js';

test('the data codec preserves own JSON keys without changing object prototypes', () => {
  const data = JSON.parse(
    '{"__proto__":{"fixture":true},"ordinary":"retained","metadata":{"__proto__":{"nested":true}}}'
  );
  const wire = JSON.stringify(encodeMemory(data));
  expect(wire).toBe(JSON.stringify(data));
  expect(JSON.stringify(decodeMemory(JSON.parse(wire)))).toBe(wire);
  expect(JSON.stringify(memoryConfiguration(data))).toBe(wire);
});

test('public native calculator preserves buffer activation, reflection generations and history', async () => {
  let snapshot: MemorySnapshot = { entities: [], revision: 0 };
  async function call(
    method: MemoryNativeRequest['method'],
    ...input: unknown[]
  ): Promise<unknown> {
    const argumentsValue = encodeMemory(input);
    if (!Array.isArray(argumentsValue)) {
      throw new Error('Invalid fixture arguments');
    }
    const result = await calculateMemoryMutation(snapshot, {
      arguments: argumentsValue,
      method,
      operation: 'native',
      resourceId: 'resource',
    });
    const rows = new Map(snapshot.entities.map((row) => [`${row.kind}:${row.id}`, row]));
    for (const change of result.changes) {
      if (change.operation === 'put') {
        rows.set(`${change.entity.kind}:${change.entity.id}`, change.entity);
      } else {
        rows.delete(`${change.kind}:${change.id}`);
      }
    }
    snapshot = { entities: [...rows.values()], revision: snapshot.revision + 1 };
    return decodeMemory(result.value);
  }
  const initial = (await call('initializeObservationalMemory', {
    config: {},
    resourceId: 'resource',
    scope: 'resource',
    threadId: null,
  })) as { id: string };
  const at = new Date('2026-10-06T19:00:00Z');
  await call('updateBufferedObservations', {
    chunk: {
      cycleId: 'cycle',
      lastObservedAt: at,
      messageIds: ['committed'],
      messageTokens: 100,
      observations: '- A retained fact.',
      tokenCount: 10,
    },
    id: initial.id,
    lastBufferedAtTime: at,
  });
  const swapped = (await call('swapBufferedToActive', {
    activationRatio: 1,
    currentPendingTokens: 100,
    id: initial.id,
    messageTokensThreshold: 100,
  })) as { activatedMessageIds: string[] };
  expect(swapped.activatedMessageIds).toEqual(['committed']);
  const active = (await call('getObservationalMemory', null, 'resource')) as {
    activeObservations: string;
    lastObservedAt: Date;
  };
  expect(active.activeObservations).toContain('retained fact');
  expect(active.lastObservedAt).toBeInstanceOf(Date);
  const reflected = (await call('createReflectionGeneration', {
    currentRecord: active,
    reflection: '- Condensed retained fact.',
    tokenCount: 4,
  })) as { id: string; generationCount: number };
  expect(reflected.generationCount).toBe(1);
  const history = (await call('getObservationalMemoryHistory', null, 'resource')) as {
    id: string;
  }[];
  expect(history.map((record) => record.id)).toEqual([reflected.id, initial.id]);
});

test('native runtime capabilities remain out of persisted data and owner crossing fails visibly', async () => {
  const snapshot: MemorySnapshot = { entities: [], revision: 0 };
  await expect(
    calculateMemoryMutation(snapshot, {
      arguments: [null, 'other'],
      method: 'getObservationalMemory',
      operation: 'native',
      resourceId: 'resource',
    })
  ).rejects.toThrow(/resource owner/);
  expect(() => encodeMemory({ metadata: { runtime: () => undefined } })).toThrow(/data-only/);
});
