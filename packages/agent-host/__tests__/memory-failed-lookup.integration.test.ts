/**
 * A Memory storage operation that fails during a run (a lookup that cannot
 * read the transcript) is that run's outcome. The run is released, so the
 * thread takes its next message.
 */
import type { MemoryDomainPort, StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { StateStoreHostMemory } from '../src/adapters/state-store-host-memory.js';
import type { HostPlatform } from '../src/ports.js';
import { hostRunMemoryOptions } from '../src/production-platform.js';
import type { HostLogRow } from '../src/protocol.js';
import { finished, rowsUntil, setupChildRunHost, stream, text } from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

test('a run whose Memory lookup failed still lets the thread take its next message', async () => {
  // The storage's lookups fail through the first run, as a lookup that read a
  // damaged thread did; the next run reads normally.
  const reads = { failing: false };
  const model = new MockLanguageModelV4({
    doStream: async () => stream(text('Answered.')),
  });
  const memory = (store: StateStore): HostPlatform['openRun'] => {
    const failingStore: MemoryDomainPort = {
      memory: (request) =>
        // Only the storage's own lookups read without an owner thread.
        reads.failing && request.operation === 'read' && request.ownerThreadId === undefined
          ? Promise.reject(new Error('The transcript cannot be read'))
          : store.memory(request),
    };
    const options = {
      native: {
        options: {
          lastMessages: 10,
          observationalMemory: false as const,
          workingMemory: { enabled: true, scope: 'thread' as const },
        },
      },
      recordPrompt: async () => undefined,
      resourceId: 'resource-failed-lookup',
    };
    return (context) =>
      StateStoreHostMemory.open(context, {
        ...hostRunMemoryOptions(options, context),
        providerRequestContext: () => ({ inputTokenLimit: 30_000, provider: 'openai' }),
        store: new Proxy(store, {
          get: (target, key) =>
            key === 'memory' ? failingStore.memory : Reflect.get(target, key, target),
        }),
      });
  };
  const harness = await setupChildRunHost(model, cleanup, { memory });

  reads.failing = true;
  const first = await harness.start('First question.');
  const firstRows = await rowsUntil(harness, harness.threadId, finished(first), 15_000);
  reads.failing = false;
  const failedFirst = (row: HostLogRow) =>
    row.event.type === 'memory.settlement.failed' ||
    (row.event.type === 'run.finished' && row.event.outcome === 'failed');
  expect(firstRows.some(failedFirst)).toBe(true);

  const next = await harness.start('Continue.');
  const rows = await rowsUntil(harness, harness.threadId, finished(next), 15_000);
  expect(rows.find(finished(next))?.event).toMatchObject({ outcome: 'completed' });
});
