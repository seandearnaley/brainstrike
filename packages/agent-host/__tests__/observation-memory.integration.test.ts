import { noopObserve } from '@mastra/core/tools';
import { parseObservationGroups } from '@mastra/memory/processors';
import { expect, onTestFinished, test, vi } from 'vitest';
import {
  chunkStateObservationText,
  StateStoreObservationMemory,
} from '../src/adapters/state-store-observation-memory.js';
import { StateStoreObservationVector } from '../src/adapters/state-store-observation-vector.js';
import { observationMemoryHost } from './fixtures/observation-memory-host.js';

test.each(['thread', 'resource'] as const)(
  'actual public Memory indexes committed native observation groups (%s)',
  async (scope) => {
    const f = await observationMemoryHost(scope);
    try {
      const messages = (await f.read()).filter((message) => message.threadId === f.threadId);
      const result = await f.engine.observe({
        messages,
        resourceId: f.host.resourceId,
        threadId: f.threadId,
      });
      expect(result.observed).toBe(true);
      const snapshot = await f.host.store.memory({
        operation: 'read',
        resourceId: f.host.resourceId,
      });
      const entity = snapshot.entities.find(
        (row) => row.kind === 'observation' && row.id === result.record.id
      );
      expect(entity?.payload['id']).toBe(result.record.id);
      const persisted = entity?.payload['activeObservations'];
      expect(typeof persisted).toBe('string');
      if (typeof persisted !== 'string') {
        throw new Error('Native observation group must be committed to the existing writer');
      }
      const groups = parseObservationGroups(persisted);
      expect(groups.length).toBeGreaterThan(0);
      console.error(
        'Committed native observation indexing receipt:',
        JSON.stringify({
          embeddingCalls: f.host.embeddingCalls,
          groups,
          messages: messages.map(({ id, threadId: owner }) => ({ id, threadId: owner })),
          observerCalls: f.observer.doStreamCalls.length,
          persisted,
          recordId: result.record.id,
          scope,
          upserts: f.recording.upserts.map(({ ids, indexName, metadata, vectors }) => ({
            dimensions: vectors.map((vector) => vector.length),
            ids,
            indexName,
            metadata,
          })),
        })
      );
      expect(f.recording.upserts.length).toBeGreaterThan(0);
      const indexed = f.recording.upserts.flatMap((call) => call.metadata ?? []);
      for (const group of groups) {
        expect(
          indexed.filter((row) => row['group_id'] === group.id).map((row) => row['text'])
        ).toEqual(chunkStateObservationText(group.content));
      }
    } finally {
      await f.close();
    }
  }
);

test('public recall resolves an unchanged Core JSON-array cursor as an individual message', async () => {
  const f = await observationMemoryHost('thread');
  try {
    const message = (await f.read()).filter((item) => item.threadId === f.threadId).at(-1);
    if (!message) {
      throw new Error('Actual committed assistant cursor is absent');
    }
    const read = vi.spyOn(f.domain, 'listMessagesById');
    const recall = f.memory.listTools()['recall'];
    if (!recall?.execute) {
      throw new Error('Pinned public Memory recall tool is absent');
    }
    const context = {
      agent: {
        agentId: 'recorded-observation-causal-agent',
        messages: [],
        resourceId: f.host.resourceId,
        suspend: async () => {
          throw new Error('Canonical cursor probe does not suspend');
        },
        threadId: f.threadId,
        toolCallId: 'recorded-canonical-cursor-probe',
      },
      memory: f.memory,
      observe: noopObserve,
    };
    const result: unknown = await recall.execute(
      { cursor: message.id, limit: 2, mode: 'messages', page: -1 },
      context
    );
    console.error(
      'Native canonical cursor receipt:',
      JSON.stringify({ cursor: message.id, reads: read.mock.calls, result })
    );
    expect(read).toHaveBeenCalledWith({ messageIds: [message.id] });
    expect(result).toMatchObject({ count: 1, cursor: message.id });
  } finally {
    await f.close();
  }
});

test('native observation range round-trips unchanged committed message endpoints', async () => {
  const f = await observationMemoryHost('thread');
  try {
    const messages = (await f.read()).filter((message) => message.threadId === f.threadId);
    const result = await f.engine.observe({
      messages,
      resourceId: f.host.resourceId,
      threadId: f.threadId,
    });
    const groups = parseObservationGroups(result.record.activeObservations);
    const first = messages[0];
    const last = messages.at(-1);
    if (!(first && last)) {
      throw new Error('Actual committed observation source requires its unchanged endpoints');
    }
    expect(groups[0]?.range).toBe(`${first.id}:${last.id}`);
  } finally {
    await f.close();
  }
});

test.each(['thread', 'resource'] as const)(
  'borrowed observation bridge prepares committed truth before native embedding and searches SQLite (%s)',
  async (scope) => {
    let fixture: Awaited<ReturnType<typeof observationMemoryHost>> | undefined;
    let indexing = true;
    const preparations: string[] = [];
    const f = await observationMemoryHost(scope, {
      beforeEmbedding: async (values) => {
        if (!indexing) {
          return;
        }
        if (!fixture) {
          throw new Error('Observation embedding ran before fixture authority was acquired');
        }
        const port = fixture.host.indexer;
        if (!port) {
          throw new Error('Borrowed actual observation writer is absent');
        }
        expect(preparations.length).toBeGreaterThan(0);
        const snapshot = await fixture.host.store.memory({
          operation: 'read',
          resourceId: fixture.host.resourceId,
        });
        const committed = snapshot.entities
          .filter((row) => row.kind === 'observation')
          .flatMap((row) =>
            typeof row.payload['activeObservations'] === 'string'
              ? parseObservationGroups(row.payload['activeObservations'])
              : []
          );
        expect(values.every((text) => committed.some((group) => group.content === text))).toBe(
          true
        );
      },
      realIndexer: true,
    });
    fixture = f;
    try {
      const port = f.host.indexer;
      if (!(port && f.vector instanceof StateStoreObservationVector)) {
        throw new Error('Qualification requires the real borrowed indexer/bridge');
      }
      const prepare = port.prepareStateObservationVectors.bind(port);
      vi.spyOn(port, 'prepareStateObservationVectors').mockImplementation(async (request) => {
        const plan = await prepare(request);
        preparations.push(plan.observation.groupId);
        return plan;
      });
      const nativeUpserts = vi.spyOn(f.vector, 'upsert');
      const writes = vi.spyOn(port, 'upsertStateObservationVectors');
      const messages = (await f.read()).filter((message) => message.threadId === f.threadId);
      const observed = await f.engine.observe({
        messages,
        resourceId: f.host.resourceId,
        threadId: f.threadId,
      });
      expect(observed.observed).toBe(true);
      indexing = false;
      const groups = parseObservationGroups(observed.record.activeObservations);
      expect(preparations).toEqual(expect.arrayContaining(groups.map((group) => group.id)));
      expect(writes).toHaveBeenCalledTimes(groups.length);
      for (const [write] of writes.mock.calls) {
        const native = nativeUpserts.mock.calls.find(
          ([call]) => call.metadata?.[0]?.['group_id'] === write.plan.observation.groupId
        )?.[0];
        expect(write.segments.map((segment) => segment.id)).toEqual(native?.ids);
        expect(write.segments.map((segment) => segment.text)).toEqual(write.plan.chunks);
        expect(
          write.segments.every((segment) =>
            /^[\da-f]{8}-[\da-f]{4}-8[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(segment.id)
          )
        ).toBe(true);
      }
      const all = await f.memory.searchMessages({ query: 'Paris', resourceId: f.host.resourceId });
      expect(all.results.map((hit) => hit.groupId).sort()).toEqual(
        groups.map((group) => group.id).sort()
      );
      const own = await f.memory.searchMessages({
        filter: { threadId: f.threadId },
        query: 'Paris',
        resourceId: f.host.resourceId,
        topK: 1,
      });
      expect(own.results).toHaveLength(1);
      expect(own.results[0]?.threadId).toBe(f.threadId);
      const date = own.results[0]?.observedAt;
      if (!date) {
        throw new Error('Native invocation date was lost by SQLite retrieval');
      }
      const excluded = await f.memory.searchMessages({
        filter: { observedAfter: date, observedBefore: date, threadId: f.threadId },
        query: 'Paris',
        resourceId: f.host.resourceId,
        topK: 1,
      });
      expect(excluded.results).toEqual([]);
      expect(
        all.results.every((hit) =>
          groups.some(
            (group) =>
              group.id === hit.groupId && group.range === hit.range && group.content === hit.text
          )
        )
      ).toBe(true);
    } finally {
      await f.close();
    }
  }
);

test('public group parser reads unchanged legacy SQLite JSON-array range bytes', async () => {
  const f = await observationMemoryHost('thread');
  try {
    const messages = (await f.read()).filter((message) => message.threadId === f.threadId);
    const observed = await f.engine.observe({
      messages,
      resourceId: f.host.resourceId,
      threadId: f.threadId,
    });
    const group = parseObservationGroups(observed.record.activeObservations)[0];
    if (!group) {
      throw new Error('Native legacy probe requires its original committed anchor');
    }
    const legacy = `<observation-group id="${group.id}" range="${group.range}">\n${group.content}\n</observation-group>`;
    await f.domain.updateActiveObservations({
      id: observed.record.id,
      lastObservedAt: observed.record.lastObservedAt ?? new Date(),
      observations: legacy,
      tokenCount: observed.record.observationTokenCount,
    });
    const readBytes = async () =>
      (
        await f.host.store.memory({ operation: 'read', resourceId: f.host.resourceId })
      ).entities.find((row) => row.kind === 'observation' && row.id === observed.record.id)
        ?.payload['activeObservations'];
    expect(await readBytes()).toBe(legacy);
    expect(parseObservationGroups(legacy)[0]).toMatchObject(group);
    expect(await readBytes()).toBe(legacy);
  } finally {
    await f.close();
  }
});

test('overlapping actual native observation calls retain separate committed plans', async () => {
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let holding = false;
  const f = await observationMemoryHost('resource', {
    beforeEmbedding: async (values) => {
      if (holding && values.some((text) => text.includes('observation 0.'))) {
        held.resolve();
        await release.promise;
      }
    },
    realIndexer: true,
  });
  const tasks: Promise<void>[] = [];
  onTestFinished(async () => {
    release.resolve();
    await Promise.allSettled(tasks);
  });
  try {
    const port = f.host.indexer;
    if (!(port && f.vector instanceof StateStoreObservationVector)) {
      throw new Error('Concurrent qualification requires the same actual borrowed writer');
    }
    const observed = await f.engine.observe({
      messages: (await f.read()).filter((message) => message.threadId === f.threadId),
      resourceId: f.host.resourceId,
      threadId: f.threadId,
    });
    const groups = parseObservationGroups(observed.record.activeObservations);
    expect(groups).toHaveLength(2);
    const memory = new StateStoreObservationMemory(
      {
        ...f.native,
        options: { observationalMemory: false, semanticRecall: false },
      },
      f.vector
    );
    const writes = vi.spyOn(port, 'upsertStateObservationVectors');
    holding = true;
    const inputs = groups.map((group, ordinal) => {
      const threadId = f.threads[ordinal];
      if (!threadId) {
        throw new Error('Native attributed thread is absent');
      }
      return {
        groupId: group.id,
        observedAt: new Date(),
        range: group.range,
        resourceId: f.host.resourceId,
        text: group.content,
        threadId,
      };
    });
    const first = inputs[0];
    const second = inputs[1];
    if (!(first && second)) {
      throw new Error('Actual overlapping native groups are absent');
    }
    tasks.push(memory.indexObservation(first));
    tasks[0]?.catch(() => undefined);
    await held.promise;
    tasks.push(memory.indexObservation(second));
    await tasks[1];
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]?.[0].plan.observation.groupId).toBe(second.groupId);
    release.resolve();
    await tasks[0];
    expect(writes.mock.calls.map(([request]) => request.plan.observation.groupId)).toEqual([
      second.groupId,
      first.groupId,
    ]);
    expect(
      writes.mock.calls.every(([request]) =>
        request.segments
          .map((segment) => segment.text)
          .every((text, ordinal) => text === request.plan.chunks[ordinal])
      )
    ).toBe(true);
    const result = await memory.searchMessages({ query: 'Paris', resourceId: f.host.resourceId });
    expect(result.results.map((hit) => hit.groupId).sort()).toEqual(
      groups.map((group) => group.id).sort()
    );
  } finally {
    release.resolve();
    await Promise.allSettled(tasks);
    await f.close();
  }
});

test.each(['purge', 'cancel'] as const)(
  'an actual held native observation embedding cannot write after %s',
  async (mode) => {
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holding = false;
    let retired = false;
    const f = await observationMemoryHost('thread', {
      beforeEmbedding: async () => {
        if (holding) {
          held.resolve();
          await release.promise;
          retired = true;
        }
      },
      realIndexer: true,
    });
    let task: Promise<void> | undefined;
    onTestFinished(async () => {
      release.resolve();
      await task?.catch(() => undefined);
    });
    try {
      const port = f.host.indexer;
      if (!(port && f.vector instanceof StateStoreObservationVector)) {
        throw new Error('Late native qualification requires its actual shared writer');
      }
      const observed = await f.engine.observe({
        messages: (await f.read()).filter((message) => message.threadId === f.threadId),
        resourceId: f.host.resourceId,
        threadId: f.threadId,
      });
      const group = parseObservationGroups(observed.record.activeObservations)[0];
      if (!group) {
        throw new Error('Committed native source is absent');
      }
      const memory = new StateStoreObservationMemory(
        {
          ...f.native,
          options: { observationalMemory: false, semanticRecall: false },
        },
        f.vector
      );
      holding = true;
      task = memory.indexObservation({
        groupId: group.id,
        range: group.range,
        resourceId: f.host.resourceId,
        text: group.content,
        threadId: f.threadId,
      });
      const outcome = task.then(
        () => ({ fulfilled: true }),
        (cause: unknown) => ({ cause, fulfilled: false })
      );
      const writes = vi.spyOn(port, 'upsertStateObservationVectors');
      await held.promise;
      expect(retired).toBe(false);
      if (mode === 'purge') {
        await port.purgeStateObservationVectors({
          resourceId: f.host.resourceId,
          rootId: f.host.root,
        });
      } else {
        f.controller.abort(new Error('Captured observation owner cancelled'));
      }
      release.resolve();
      expect(await outcome).toMatchObject({ fulfilled: false });
      expect(retired).toBe(true);
      holding = false;
      if (mode === 'purge') {
        expect(
          (await memory.searchMessages({ query: 'Paris', resourceId: f.host.resourceId })).results
        ).toEqual([]);
      } else {
        expect(writes).not.toHaveBeenCalled();
        expect(
          (
            await f.host.store.memory({ operation: 'read', resourceId: f.host.resourceId })
          ).entities.find((row) => row.id === observed.record.id)?.payload['activeObservations']
        ).toBe(observed.record.activeObservations);
      }
    } finally {
      release.resolve();
      await task?.catch(() => undefined);
      await f.close();
    }
  }
);

test('uncommitted native observation input refuses before embedding', async () => {
  const f = await observationMemoryHost('thread', { realIndexer: true });
  try {
    const observed = await f.engine.observe({
      messages: (await f.read()).filter((message) => message.threadId === f.threadId),
      resourceId: f.host.resourceId,
      threadId: f.threadId,
    });
    const group = parseObservationGroups(observed.record.activeObservations)[0];
    if (!group) {
      throw new Error('Actual committed source is absent');
    }
    const before = f.host.embeddingCalls.length;
    await expect(
      f.memory.indexObservation({
        groupId: group.id,
        range: group.range,
        resourceId: f.host.resourceId,
        text: `${group.content} Forged content.`,
        threadId: f.threadId,
      })
    ).rejects.toThrow();
    expect(f.host.embeddingCalls).toHaveLength(before);
  } finally {
    await f.close();
  }
});

test('native buffer activation keeps original groups readable through SQLite reopen', async () => {
  let fixture: Awaited<ReturnType<typeof observationMemoryHost>> | undefined;
  let buffering = true;
  const f = await observationMemoryHost('thread', {
    beforeEmbedding: async (values) => {
      if (!buffering) {
        return;
      }
      if (!fixture) {
        throw new Error('Native buffer embedding preceded acquired fixture authority');
      }
      const snapshot = await fixture.host.store.memory({
        operation: 'read',
        resourceId: fixture.host.resourceId,
      });
      const chunks = snapshot.entities
        .filter((row) => row.kind === 'observation')
        .flatMap((row) =>
          Array.isArray(row.payload['bufferedObservationChunks'])
            ? row.payload['bufferedObservationChunks']
            : []
        );
      expect(
        chunks.some(
          (chunk) =>
            typeof chunk === 'object' &&
            chunk !== null &&
            'observations' in chunk &&
            typeof chunk.observations === 'string' &&
            parseObservationGroups(chunk.observations).some((group) =>
              values.includes(group.content)
            )
        )
      ).toBe(true);
    },
    buffered: true,
    realIndexer: true,
  });
  fixture = f;
  try {
    const buffered = await f.engine.buffer({
      messages: (await f.read()).filter((message) => message.threadId === f.threadId),
      resourceId: f.host.resourceId,
      skipMinimumTokenCheck: true,
      threadId: f.threadId,
    });
    expect(buffered.buffered).toBe(true);
    buffering = false;
    const before = await f.memory.searchMessages({ query: 'Paris', resourceId: f.host.resourceId });
    expect(before.results).toHaveLength(1);
    const activated = await f.engine.activate({
      resourceId: f.host.resourceId,
      threadId: f.threadId,
    });
    expect(activated.activated).toBe(true);
    const groups = parseObservationGroups(activated.record.activeObservations);
    expect(groups.map((group) => group.id)).toEqual(before.results.map((hit) => hit.groupId));
    const memory = await f.reopenObservations();
    expect(
      (await memory.searchMessages({ query: 'Paris', resourceId: f.host.resourceId })).results
    ).toEqual(before.results);
  } finally {
    await f.close();
  }
});
