import assert from 'node:assert/strict';
import test from 'node:test';
import { Coalescer } from '../../packages/state-store/src/coalescer.ts';
import { configureCoalescer, MeasurementCoalescer, stateAdapter } from './adapters.mjs';

configureCoalescer(Coalescer);

test('historical exclusive read advances the production inclusive cursor exactly once', async () => {
  const reads = [];
  const store = {
    read: async (threadId, fromSeq) => {
      reads.push([threadId, fromSeq]);
      return [
        /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
          threadId,
          seq: fromSeq,
          event: { type: 'run.started' },
        },
      ];
    },
  };
  const adapter = stateAdapter(store);
  const rows = await adapter.read('thread', 3);
  assert.deepEqual(reads, [['thread', 4]]);
  assert.equal(rows[0].seq, 4);
  await adapter.read('thread');
  assert.deepEqual(reads[1], ['thread', 1]);
});

test('the real Coalescer delivers after commit and issues the actual sync without waiting for it', async () => {
  const trace = [];
  const committed = Promise.withResolvers();
  const synced = Promise.withResolvers();
  const store = {
    append: async (_items, onCommitted) => {
      await committed.promise;
      trace.push('commit');
      onCommitted();
      return [];
    },
    syncBoundary: async (threadId) => {
      trace.push(`sync:${threadId}`);
      await synced.promise;
    },
  };
  const co = new MeasurementCoalescer(stateAdapter(store), 20, 'after-commit', () =>
    trace.push('display')
  );
  co.push('thread', 'run', { type: 'finish-step' });
  co.show('thread', 'run', { type: 'finish-step' });
  const flushed = co.flush();
  assert.deepEqual(trace, []);
  committed.resolve();
  await flushed;
  assert.deepEqual(trace, ['commit', 'display', 'sync:thread']);
  assert.equal(co.displayLatencies.length, 1);
  assert.equal(co.latencies.length, 1);
  assert.equal(co.boundarySyncs.length, 1);
  assert.equal(co.boundarySyncs[0].t1, undefined);
  synced.resolve();
  await co.drainSyncs();
  assert.equal(typeof co.boundarySyncs[0].t1, 'number');
});
