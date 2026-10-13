import { randomUUID } from 'node:crypto';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { committedMemoryTranscript } from '../src/adapters/committed-memory-transcript.js';
import { readHostRow } from '../src/event-storage.js';
import type { HostEvent } from '../src/protocol.js';
import { captureHostFailureDiagnostics } from './fixtures/host-failure-diagnostics.js';
import {
  deterministicEmbedding,
  memoryVectorHost as fixture,
  RecordedVectorCalls,
} from './fixtures/memory-vector-host.js';
import {
  RECORDED_VECTOR_PROFILE,
  recordedMemoryVectorPort,
} from './fixtures/recorded-memory-vector-port.js';

const fetch = vi.fn(async () => {
  throw new Error('This packet makes no provider requests');
});
beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => {
  expect(fetch.mock.calls.length).toBe(0);
  vi.unstubAllGlobals();
});

function recordedSystem(model: MockLanguageModelV4 | undefined): string {
  return (
    model?.doStreamCalls[0]?.prompt
      .flatMap((message) => (message.role === 'system' ? [message.content] : []))
      .join('\n') ?? ''
  );
}

test.each(['thread', 'resource'] as const)(
  'public working memory persists through real SQLite reopen and honors %s scope',
  async (scope) => {
    const current = await fixture({ workingScope: scope });
    try {
      const { threadId } = await current.core.startThread({ commandId: randomUUID() });
      const text = '# Fixture facts\n- Retained SQLite working-memory value';
      current.seedWorkingMemory(text);
      await current.run(threadId, 'Record the working-memory fact.');
      const before = await current.core.read(threadId, 0);
      const snapshot = await current.store.memory({
        operation: 'read',
        resourceId: current.resourceId,
      });
      await current.reopen();
      expect(await current.core.read(threadId, 0)).toEqual(before);
      expect(
        await current.store.memory({ operation: 'read', resourceId: current.resourceId })
      ).toEqual(snapshot);
      await current.run(threadId, 'Recall the retained working-memory fact.');
      expect(current.workingReads.at(-1)?.value).toBe(text);
      expect(recordedSystem(current.models.at(-1))).toContain(text);
      const other = await current.core.startThread({ commandId: randomUUID() });
      await current.run(other.threadId, 'Read this thread working memory.');
      expect(current.workingReads.at(-1)?.value).toBe(scope === 'resource' ? text : null);
      expect(recordedSystem(current.models.at(-1)).includes(text)).toBe(scope === 'resource');
      expect(await current.store.check()).toEqual({ gaps: 0, integrity: 'ok' });
      expect(current.embeddingCalls).toHaveLength(0);
    } finally {
      await current.close();
    }
  }
);

test.each(['thread', 'resource'] as const)(
  'public recall uses recorded vector calls and canonical SQLite messages (%s scope; not production vector parity)',
  async (scope) => {
    const vector = new RecordedVectorCalls();
    const current = await fixture({ semanticScope: scope, vector });
    try {
      const first = await current.core.startThread({ commandId: randomUUID() });
      await current.run(first.threadId, 'Paris recorded canonical fact.');
      const before = await current.core.read(first.threadId, 0);
      const transcript = committedMemoryTranscript(before, current.resourceId);
      const recalled = transcript.findLast((message) => message.role === 'assistant');
      if (!recalled) {
        throw new Error('Recorded SDK step has no committed assistant identity');
      }
      vector.results = [
        {
          id: recalled.id,
          metadata: {
            message_id: recalled.id,
            resource_id: current.resourceId,
            thread_id: first.threadId,
          },
          score: 1,
        },
      ];
      const queriesBefore = vector.queries.length;
      await current.reopen();
      const target =
        scope === 'resource' ? await current.core.startThread({ commandId: randomUUID() }) : first;
      await current.run(target.threadId, 'Recall Paris beyond the one-message history window.');
      const prompt = current.models.at(-1)?.doStreamCalls[0]?.prompt;
      expect(
        prompt?.filter((message) => message.role !== 'system').map((message) => message.role)
      ).toEqual(['user', 'assistant', 'user']);
      expect(JSON.stringify(prompt)).toContain('Paris recorded canonical fact.');
      const queries = vector.queries.slice(queriesBefore);
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.at(-1)).toMatchObject({
        filter:
          scope === 'thread' ? { thread_id: first.threadId } : { resource_id: current.resourceId },
        queryVector: deterministicEmbedding('Paris'),
        topK: 1,
      });
      expect(
        current.embeddingCalls.some((values) =>
          values.includes('Recall Paris beyond the one-message history window.')
        )
      ).toBe(true);
      expect(vector.creates.every(({ dimension }) => dimension === 384)).toBe(true);
      const all = committedMemoryTranscript(
        await Promise.all(
          (await current.store.readAll()).map((row) => readHostRow(current.store, row))
        ),
        current.resourceId
      );
      const ids = new Set(all.map((message) => message.id));
      expect(vector.upserts.length).toBeGreaterThan(0);
      expect(vector.upserts.every(({ ids: generated }) => generated === undefined)).toBe(true);
      expect(
        vector.upserts
          .flatMap(({ metadata }) => metadata ?? [])
          .every(
            (metadata) =>
              typeof metadata['message_id'] === 'string' && ids.has(metadata['message_id'])
          )
      ).toBe(true);
      expect((await current.core.read(first.threadId, 0)).slice(0, before.length)).toEqual(before);
      expect(await current.store.check()).toEqual({ gaps: 0, integrity: 'ok' });
    } finally {
      await current.close();
    }
  }
);

test('missing semantic capability fails the run before embedding or the SDK call', async () => {
  const diagnostics = captureHostFailureDiagnostics();
  const current = await fixture({ semanticScope: 'thread' });
  try {
    const { threadId } = await current.core.startThread({ commandId: randomUUID() });
    const { runId } = await current.core.startRun({
      commandId: randomUUID(),
      modelId: 'recorded-sdk-fixture',
      prompt: 'Request unavailable semantic recall.',
      threadId,
    });
    let finished: HostEvent | undefined;
    await expect
      .poll(
        async () => {
          finished = (await current.core.read(threadId, 0))
            .map((row) => row.event)
            .find((event) => event.type === 'run.finished' && event.runId === runId);
          return finished !== undefined;
        },
        { timeout: 30_000 }
      )
      .toBe(true);
    // The public run stays safe; diagnostics name the actual missing capability.
    expect(finished).toMatchObject({
      detail: INTERNAL_FAULT.message,
      outcome: 'failed',
    });
    diagnostics.expectCause('Semantic recall requires the borrowed vector owner');
    expect(current.embeddingCalls).toHaveLength(0);
    expect(current.models.flatMap((model) => model.doStreamCalls)).toHaveLength(0);
    expect(current.workingReads).toHaveLength(0);
    expect(await current.store.check()).toEqual({ gaps: 0, integrity: 'ok' });
  } finally {
    await current.closeRejectedAdmission();
  }
});

test('public vector bridge prepares actual committed SDK sources before save inference', async () => {
  const recorded = recordedMemoryVectorPort();
  const current = await fixture({
    onEmbedding: (values) => {
      if (values.includes('Host run completed.')) {
        recorded.events.push('assistant-embedding');
      }
    },
    semanticScope: 'resource',
    vectorPort: recorded.port,
  });
  try {
    const first = await current.core.startThread({ commandId: randomUUID() });
    await current.run(first.threadId, 'Paris source for the existing public bridge.');
    const rows = await current.core.read(first.threadId, 0);
    const transcript = committedMemoryTranscript(rows, current.resourceId);
    const source = rows.findLast(
      (row) => row.event.type === 'model.step' && row.event.messages.length > 0
    );
    const assistant = transcript.findLast((message) => message.role === 'assistant');
    if (!(source && assistant)) {
      throw new Error('Actual committed SDK step has no source identity');
    }
    expect(recorded.events.indexOf('prepare')).toBeLessThan(
      recorded.events.indexOf('assistant-embedding')
    );
    expect(recorded.upserts[0]?.plan).toBe(recorded.plans[0]);
    expect(recorded.prepares[0]?.messages).toContainEqual({
      messageId: assistant.id,
      seq: source.seq,
    });
    recorded.setHits([
      {
        messageId: assistant.id,
        score: 1,
        segmentOrdinal: 0,
        seq: source.seq,
        threadId: first.threadId,
      },
    ]);
    const target = await current.core.startThread({ commandId: randomUUID() });
    await current.run(target.threadId, 'Recall the Paris source through the borrowed port.');
    expect(JSON.stringify(current.models.at(-1)?.doStreamCalls[0]?.prompt)).toContain(
      'Paris source for the existing public bridge.'
    );
    expect(recorded.queries.at(-1)?.scope).toMatchObject({
      resourceId: current.resourceId,
      threadId: target.threadId,
    });
    expect(await current.store.check()).toEqual({ gaps: 0, integrity: 'ok' });
  } finally {
    await current.close();
  }
});

test.each(['thread', 'resource'] as const)(
  'actual Core/indexer/public Memory recall preserves committed IDs and scores across reopen (%s)',
  async (scope) => {
    const current = await fixture({ realIndexer: true, semanticScope: scope });
    try {
      const first = await current.core.startThread({ commandId: randomUUID() });
      const fact = 'Paris actual SQLite vector source.';
      await current.run(first.threadId, fact);
      const rows = await current.core.read(first.threadId, 0);
      const transcript = committedMemoryTranscript(rows, current.resourceId);
      const query = {
        limit: 10,
        profile: RECORDED_VECTOR_PROFILE,
        scope: {
          resourceId: current.resourceId,
          rootId: current.root,
          threadId: first.threadId,
        },
        vector: deterministicEmbedding('Host run completed.'),
      };
      if (!current.indexer) {
        throw new Error('Actual indexer acquisition is missing');
      }
      const before = await current.indexer.queryStateMessageVectors(query);
      expect(before.map((hit) => hit.messageId).sort()).toEqual(
        transcript.map((message) => message.id).sort()
      );
      expect(before[0]?.score).toBeCloseTo(1);
      expect(before[0]?.messageId).toBe(
        transcript.find((message) => message.role === 'assistant')?.id
      );
      expect(before.every((hit) => rows.some((row) => row.seq === hit.seq))).toBe(true);
      await current.reopen();
      expect(await current.core.read(first.threadId, 0)).toEqual(rows);
      expect(await current.indexer.queryStateMessageVectors(query)).toEqual(before);
      const target =
        scope === 'resource' ? await current.core.startThread({ commandId: randomUUID() }) : first;
      await current.run(
        target.threadId,
        'Recall the completed SDK response beyond the one-message history window.'
      );
      const prompt = current.models.at(-1)?.doStreamCalls[0]?.prompt;
      expect(JSON.stringify(prompt)).toContain(fact);
      expect(
        prompt?.filter((message) => message.role !== 'system').map((message) => message.role)
      ).toEqual(['user', 'assistant', 'user']);
      expect(await current.store.check()).toEqual({ gaps: 0, integrity: 'ok' });
    } finally {
      await current.close();
    }
  }
);

test('empty semantic results preserve the bounded history window', async () => {
  const vector = new RecordedVectorCalls();
  const current = await fixture({ lastMessages: 2, semanticScope: 'thread', vector });
  try {
    const { threadId } = await current.core.startThread({ commandId: randomUUID() });
    await current.run(threadId, 'Paris fact outside the next bounded window.');
    await current.run(threadId, 'An unrelated current query.');
    const prompt = current.models.at(-1)?.doStreamCalls[0]?.prompt;
    expect(
      prompt?.filter((message) => message.role !== 'system').map((message) => message.role)
    ).toEqual(['user']);
    expect(JSON.stringify(prompt)).not.toContain('Paris fact outside the next bounded window.');
    expect(vector.queries.length).toBeGreaterThan(0);
  } finally {
    await current.close();
  }
});

test.each([
  ['foreign resource', 'resource', true],
  ['foreign resource', 'thread', true],
  ['foreign thread', 'thread', false],
] as const)(
  '%s vector hit cannot authorize %s recall',
  async (_boundary, scope, separateResource) => {
    const vector = new RecordedVectorCalls();
    const current = await fixture({ semanticScope: scope, vector });
    try {
      const foreignResourceId = separateResource ? randomUUID() : current.resourceId;
      const foreign = await current.core.startThread({ commandId: randomUUID() });
      const foreignText = 'Foreign-resource committed fact: 5b4fa5cc.';
      await current.run(foreign.threadId, foreignText, foreignResourceId);
      const before = await current.core.read(foreign.threadId, 0);
      const foreignMessage = committedMemoryTranscript(before, foreignResourceId).findLast(
        (message) => message.role === 'assistant'
      );
      if (!foreignMessage) {
        throw new Error('Foreign recorded SDK step has no committed assistant identity');
      }
      await current.reopen();
      const foreignSnapshot = await current.store.memory({
        operation: 'read',
        resourceId: foreignResourceId,
      });
      expect(foreignSnapshot.entities).toContainEqual(
        expect.objectContaining({
          id: foreign.threadId,
          kind: 'thread',
          payload: expect.objectContaining({ resourceId: foreignResourceId }),
          threadId: foreign.threadId,
        })
      );
      const target = await current.core.startThread({ commandId: randomUUID() });
      vector.results = [
        {
          id: foreignMessage.id,
          metadata: {
            message_id: foreignMessage.id,
            resource_id: current.resourceId,
            thread_id: foreign.threadId,
          },
          score: 1,
        },
      ];
      await current.run(target.threadId, 'Recall only this resource.');
      const targetSnapshot = await current.store.memory({
        operation: 'read',
        resourceId: current.resourceId,
      });
      expect(targetSnapshot.entities).toContainEqual(
        expect.objectContaining({ id: target.threadId, kind: 'thread' })
      );
      expect(targetSnapshot.entities.some((entity) => entity.threadId === foreign.threadId)).toBe(
        !separateResource
      );
      const prompt = current.models.at(-1)?.doStreamCalls[0]?.prompt;
      expect(JSON.stringify(prompt)).not.toContain(foreignText);
      expect(
        prompt?.filter((message) => message.role !== 'system').map((message) => message.role)
      ).toEqual(['user']);
      expect(vector.queries.at(-1)?.filter).toEqual(
        scope === 'resource' ? { resource_id: current.resourceId } : { thread_id: target.threadId }
      );
      expect((await current.core.read(foreign.threadId, 0)).slice(0, before.length)).toEqual(
        before
      );
      expect(await current.store.check()).toEqual({ gaps: 0, integrity: 'ok' });
    } finally {
      await current.close();
    }
  }
);
