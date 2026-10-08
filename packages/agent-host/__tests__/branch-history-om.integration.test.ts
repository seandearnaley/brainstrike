/**
 * Observational memory on a branched thread. OM keeps one merged observation
 * text per thread, so after an edit its observations can summarise the
 * sibling branch. The edited branch's provider request must not carry them;
 * an unbranched thread keeps OM as before.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { expect, test } from 'vitest';
import { StateStoreHostMemory } from '../src/adapters/state-store-host-memory.js';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';

const MARKER = 'SIBLING-ONLY-FACT-7731';
const FILLER = ' Plan the release carefully.'.repeat(40);
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

function textStream(text: string) {
  return {
    stream: simulateReadableStream({
      chunkDelayInMs: null,
      chunks: [
        { type: 'stream-start' as const, warnings: [] },
        { id: 'text-1', type: 'text-start' as const },
        { delta: text, id: 'text-1', type: 'text-delta' as const },
        { id: 'text-1', type: 'text-end' as const },
        {
          finishReason: { raw: 'stop', unified: 'stop' as const },
          type: 'finish' as const,
          usage,
        },
      ],
      initialDelayInMs: null,
    }),
  };
}

/** The system text the chat model actually received on each call. */
function systemText(model: MockLanguageModelV4, call: number): string {
  return (model.doStreamCalls[call]?.prompt ?? [])
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-branch-om-'));
  const store = await StateStore.open(root, {
    memoryCalculatorModule: fileURLToPath(
      new URL('../dist/adapters/memory-storage-calculator.js', import.meta.url)
    ),
  });
  let answers = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      answers += 1;
      return textStream(`answer ${answers}`);
    },
  });
  // Summarises what it observed: it reports the marker only when it saw it.
  const observer = new MockLanguageModelV4({
    doStream: async ({ prompt }) =>
      textStream(
        JSON.stringify(prompt).includes(MARKER)
          ? `<observations>\n- The user stated ${MARKER}.\n</observations>`
          : '<observations>\n- The user is planning a release.\n</observations>'
      ),
  });
  const resourceId = randomUUID();
  const platform: HostPlatform = {
    admitRun: async () => ({
      configuration: {},
      model,
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
            observationalMemory: {
              model: observer,
              observation: { bufferOnIdle: false, bufferTokens: false, messageTokens: 30 },
              reflection: { observationTokens: 50_000 },
            },
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
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  const run = async (prompt: string, parentMessageId?: string | null) => {
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      ...(parentMessageId === undefined ? {} : { parentMessageId }),
      prompt,
      threadId,
    });
    await expect
      .poll(async () =>
        (await core.read(threadId, 0)).some(
          (row) => row.event.type === 'run.finished' && row.event.runId === runId
        )
      )
      .toBe(true);
    return runId;
  };
  const close = async () => {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  };
  return { close, core, model, observer, run, threadId };
}

test('an edited branch never receives observations of its sibling branch', async () => {
  const host = await harness();
  try {
    const first = await host.run(`First question.${FILLER}`);
    await host.run(`Second question: ${MARKER}.${FILLER}`);
    // The sibling's observations exist before the edit.
    expect(host.observer.doStreamCalls.length).toBeGreaterThan(0);
    expect(systemText(host.model, 1)).toContain(MARKER);

    await host.run(`Second question, edited.${FILLER}`, first);
    expect(host.model.doStreamCalls).toHaveLength(3);
    expect(systemText(host.model, 2)).not.toContain(MARKER);
    expect(JSON.stringify(host.model.doStreamCalls[2]?.prompt)).not.toContain(MARKER);
    // The reason is committed with the run, not dropped silently.
    const withheld = (await host.core.read(host.threadId, 0)).filter(
      (row) => row.event.type === 'memory.observation.withheld'
    );
    expect(withheld.map(({ event }) => event)).toEqual([
      expect.objectContaining({ reason: 'branched-thread' }),
    ]);
  } finally {
    await host.close();
  }
});

test('an unbranched thread keeps observational memory as before', async () => {
  const host = await harness();
  try {
    await host.run(`First question: ${MARKER}.${FILLER}`);
    await host.run(`Second question.${FILLER}`);
    expect(systemText(host.model, 1)).toContain(MARKER);
    const withheld = (await host.core.read(host.threadId, 0)).filter(
      (row) => row.event.type === 'memory.observation.withheld'
    );
    expect(withheld).toEqual([]);
  } finally {
    await host.close();
  }
});
