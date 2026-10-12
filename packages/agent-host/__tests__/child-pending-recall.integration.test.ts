import { randomUUID } from 'node:crypto';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import type { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { committedMemoryTranscript } from '../src/adapters/committed-memory-transcript.js';
import { StateStoreHostMemory } from '../src/adapters/state-store-host-memory.js';
import { withHostDelegationTools } from '../src/child-runs.js';
import type { HostPlatform } from '../src/ports.js';
import {
  childThreads,
  finished,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCalls,
  toolNames,
} from './fixtures/child-run-host.js';
import recorded from './fixtures/luna-parallel-skill-children.json' with { type: 'json' };
import { deterministicEmbedding, RecordedVectorCalls } from './fixtures/memory-vector-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

test('resource recall keeps a pending parent approval out of all three children', async () => {
  const resourceId = randomUUID();
  const childPrompts: string[] = [];
  const memory =
    (store: StateStore): HostPlatform['openRun'] =>
    async (context) => {
      // The captured parent committed its incomplete tool batch before child recall.
      if (context.threadId !== harness.threadId) {
        await rowsUntil(
          harness,
          harness.threadId,
          (row) =>
            row.event.type === 'model.step' &&
            JSON.stringify(row.event.messages).includes(recorded[0]?.toolCallId ?? 'missing'),
          15_000
        );
      }
      const vector = new RecordedVectorCalls();
      vector.query = async () => {
        const rows = context
          .readCommittedRows(new Set(await store.threads()))
          .filter((row) => row.threadId !== context.threadId);
        return committedMemoryTranscript(rows, resourceId)
          .filter((message) => message.role === 'assistant')
          .map((message) => ({
            id: message.id,
            metadata: {
              message_id: message.id,
              resource_id: resourceId,
              thread_id: message.threadId,
            },
            score: 1,
          }));
      };
      return StateStoreHostMemory.open(context, {
        native: {
          embedder: {
            doEmbed: async ({ values }) => ({
              embeddings: values.map(deterministicEmbedding),
              warnings: [],
            }),
            maxEmbeddingsPerCall: 1,
            modelId: 'recorded-recall',
            provider: 'local-fixture',
            specificationVersion: 'v3',
            supportsParallelCalls: false,
          },
          options: {
            lastMessages: 10,
            observationalMemory: false,
            semanticRecall: { messageRange: 0, scope: 'resource', topK: 4 },
            workingMemory: { enabled: false },
          },
          vector,
        },
        recordPrompt: async () => undefined,
        resourceId,
        store,
      });
    };
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (!toolNames(call).includes('agent-explore')) {
        childPrompts.push(JSON.stringify(call.prompt));
        return stream(text('Explorer completed.'));
      }
      if (!call.prompt.some((message) => message.role === 'tool')) {
        return stream(
          toolCalls(recorded.map((entry) => [entry.toolName, entry.input, entry.toolCallId]))
        );
      }
      return stream(text('Parent completed.'));
    },
  });
  const harness = await setupChildRunHost(
    model,
    cleanup,
    {
      memory,
      policy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES, execute: 'ask' }, yolo: false }),
    },
    (platform) => async () => {
      const tools = withHostDelegationTools(
        {
          ...platform.tools,
          brainstrike_runSkillScript: {
            description: 'Execute the captured skill call',
            execute: async () => ({ ok: true }),
            identity: 'captured-skill',
            inputSchema: z.record(z.string(), z.unknown()),
            risk: 'execute',
          },
        },
        platform.delegation
      );
      return {
        configuration: {},
        delegation: platform.delegation,
        model,
        snapshot: {
          configuration: {},
          maxSteps: 4,
          toolIdentities: Object.fromEntries(
            Object.entries(tools).map(([id, tool]) => [id, tool.identity])
          ),
        },
        tools,
      };
    }
  );
  const runId = await harness.start('Delegate while this skill needs approval.');
  await expect.poll(async () => (await childThreads(harness)).length).toBe(3);
  const ids = await childThreads(harness);
  const outcomes = await Promise.all(
    ids.map(async (id) => {
      const rows = await rowsUntil(harness, id, (row) => row.event.type === 'run.finished', 15_000);
      return rows.find((row) => row.event.type === 'run.finished')?.event;
    })
  );
  expect(outcomes).toEqual(
    Array.from({ length: 3 }, () => expect.objectContaining({ outcome: 'completed' }))
  );
  expect(childPrompts).toHaveLength(3);
  expect(
    childPrompts.every((prompt) => !prompt.includes(recorded[0]?.toolCallId ?? 'missing'))
  ).toBe(true);
  const parent = await harness.core().read(harness.threadId, 0);
  expect(parent.some(finished(runId))).toBe(false);
  const approval = parent.find((row) => row.event.type === 'interaction.requested');
  expect(approval?.event.type).toBe('interaction.requested');
  if (approval?.event.type !== 'interaction.requested') {
    throw new Error('Parent approval missing');
  }
  await harness.core().respond({
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: approval.event.interactionId,
    runId,
    threadId: harness.threadId,
  });
  const completed = await rowsUntil(harness, harness.threadId, finished(runId));
  expect(completed.find(finished(runId))?.event).toMatchObject({ outcome: 'completed' });
});
