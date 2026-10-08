/**
 * Branch history through public native Memory (BST-1929, #3543 6054972701).
 * Memory's last-messages window covers every turn of the thread, siblings
 * included; the provider request for a regenerated or an edited run must
 * still carry the selected path only.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { expect, test } from 'vitest';
import { committedMemoryTranscript } from '../src/adapters/committed-memory-transcript.js';
import { StateStoreHostMemory } from '../src/adapters/state-store-host-memory.js';
import { committedRunIdentity } from '../src/committed-identities.js';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

/** Every call answers `answer N`, so a sibling's answer is detectable in a request. */
function answeringModel(): MockLanguageModelV4 {
  let calls = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const call = calls;
      calls += 1;
      return {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { id: 'text-1', type: 'text-start' },
            { delta: `answer ${call}`, id: 'text-1', type: 'text-delta' },
            { id: 'text-1', type: 'text-end' },
            { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
          ],
          initialDelayInMs: null,
        }),
      };
    },
  });
}

/** The provider-prepared request as `role: text` lines. */
function lines(messages: readonly ModelMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.role === 'system') {
      return [];
    }
    if (typeof message.content === 'string') {
      return [`${message.role}: ${message.content}`];
    }
    return message.content.flatMap((part) =>
      part.type === 'text' ? [`${message.role}: ${part.text}`] : []
    );
  });
}

test('native Memory history for a regenerated and an edited run is the selected path, never a sibling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-branch-memory-'));
  const store = await StateStore.open(root, {
    memoryCalculatorModule: fileURLToPath(
      new URL('../dist/adapters/memory-storage-calculator.js', import.meta.url)
    ),
  });
  const model = answeringModel();
  const resourceId = randomUUID();
  const requests: ModelMessage[][] = [];
  const platform: HostPlatform = {
    admitRun: async () => ({
      configuration: {},
      model,
      provider: {
        prepare: async ({ messages }) => {
          requests.push(structuredClone([...messages]));
          return { messages: [...messages], model };
        },
      },
      snapshot: { configuration: {}, maxSteps: 2, toolIdentities: {} },
      tools: {},
    }),
    close: async () => undefined,
    maxSteps: 2,
    openRun: (context) =>
      StateStoreHostMemory.open(context, {
        native: {
          options: {
            lastMessages: 40,
            observationalMemory: false,
            semanticRecall: false,
            workingMemory: { enabled: false },
          },
        },
        providerRequestContext: () => ({ inputTokenLimit: 30_000, provider: 'openai' }),
        recordObserverUsage: async () => undefined,
        recordPrompt: async () => undefined,
        resourceId,
        store,
      }),
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveModel: async () => model,
  };
  const core = await HostCore.open(store, platform, () => () => undefined);
  try {
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    const settle = async (runId: string) => {
      await expect
        .poll(async () =>
          (await core.read(threadId, 0)).some(
            (row) => row.event.type === 'run.finished' && row.event.runId === runId
          )
        )
        .toBe(true);
      return core.read(threadId, 0);
    };
    const run = (prompt: string, parentMessageId?: string | null) =>
      core.startRun({
        commandId: randomUUID(),
        modelId: 'scripted',
        ...(parentMessageId === undefined ? {} : { parentMessageId }),
        prompt,
        threadId,
      });
    const { runId: first } = await run('First');
    await settle(first);
    const { runId: second } = await run('Second');
    const afterSecond = await settle(second);
    const secondUser = committedRunIdentity(afterSecond, second).userMessageId;

    const { runId: regenerated } = await core.regenerateRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      threadId,
      userMessageId: secondUser,
    });
    await settle(regenerated);
    expect(lines(requests[2] ?? [])).toEqual([
      'user: First',
      'assistant: answer 0',
      'user: Second',
    ]);
    expect(JSON.stringify(requests[2])).not.toContain('answer 1');

    const { runId: edited } = await run('Second, edited', first);
    const rows = await settle(edited);
    expect(lines(requests[3] ?? [])).toEqual([
      'user: First',
      'assistant: answer 0',
      'user: Second, edited',
    ]);
    for (const sibling of ['"Second"', 'answer 1', 'answer 2']) {
      expect(JSON.stringify(requests[3])).not.toContain(sibling);
    }
    // The native transcript holds each committed user message once.
    const users = committedMemoryTranscript(rows, resourceId)
      .filter((message) => message.role === 'user')
      .map((message) => message.id);
    expect(users).toEqual([
      committedRunIdentity(rows, first).userMessageId,
      secondUser,
      committedRunIdentity(rows, edited).userMessageId,
    ]);
  } finally {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  }
});
