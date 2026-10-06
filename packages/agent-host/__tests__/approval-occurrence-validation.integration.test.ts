import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import { parallelToolModel } from './fixtures/scripted-model.js';

test('parallel identical RAW calls retain their distinct admitted occurrence objects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-identical-raw-'));
  const store = await StateStore.open(root);
  const source = parallelToolModel('counter');
  const admitted: unknown[] = [];
  const executed: unknown[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const response = await source.doStream(options);
      return {
        ...response,
        stream: response.stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              controller.enqueue(
                chunk.type === 'tool-call'
                  ? { ...chunk, input: JSON.stringify({ text: 'identical RAW' }) }
                  : chunk
              );
            },
          })
        ),
      };
    },
  });
  const core = await HostCore.open(
    store,
    {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveModel: async () => model,
      tools: {
        counter: {
          description: 'Distinct schema admission for identical provider arguments',
          execute: async (input) => {
            executed.push(input);
            return { executed: true };
          },
          identity: 'counter',
          inputSchema: z.object({ text: z.string() }).transform(({ text }) => {
            const value = { admission: admitted.length + 1, text };
            admitted.push(value);
            return value;
          }),
          risk: 'edit',
        },
      },
    },
    () => () => undefined
  );
  try {
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Both calls',
      threadId,
    });
    await expect
      .poll(
        async () =>
          (await core.read(threadId, 0)).filter((row) => row.event.type === 'interaction.requested')
            .length
      )
      .toBe(2);
    const approvals = (await core.read(threadId, 0))
      .map((row) => row.event)
      .filter((event) => event.type === 'interaction.requested');
    const expected = [...admitted];
    for (const approval of approvals) {
      await core.respond({
        commandId: randomUUID(),
        decision: 'approve',
        interactionId: approval.interactionId,
        runId,
        threadId,
      });
    }
    await expect
      .poll(async () =>
        (await core.read(threadId, 0)).some((row) => row.event.type === 'run.finished')
      )
      .toBe(true);
    expect(executed).toHaveLength(2);
    expect(executed[0]).toBe(expected[0]);
    expect(executed[1]).toBe(expected[1]);
    expect(admitted).toHaveLength(2);
    expect(
      (await core.read(threadId, 0)).filter((row) => row.event.type === 'effect.finished')
    ).toHaveLength(2);
  } finally {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  }
});
