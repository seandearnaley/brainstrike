import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiKeyAuthInput, type RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { HostCore } from '../src/core.js';
import { storedHostEvent } from '../src/event-storage.js';
import { createProductionHostPlatform } from '../src/production-platform.js';
import type { HostEvent } from '../src/protocol.js';

const candidate = join(import.meta.dirname, '../../..');
const provider = 'openai';
const modelId = 'gpt-6-sol';

afterEach(() => vi.unstubAllGlobals());

/** A committed earlier turn: its prompt and one long assistant answer. */
function recordedTurn(threadId: string, index: number, answerChars: number): HostEvent[] {
  const runId = randomUUID();
  const commandId = randomUUID();
  const prompt = `Earlier question ${index}`;
  return [
    {
      commandId,
      method: 'run/start',
      payload: { commandId, modelId, prompt, threadId },
      result: { runId },
      type: 'command.accepted',
    },
    {
      modelId,
      prompt,
      runId,
      snapshot: { configuration: { model: modelId, provider }, maxSteps: 1, toolIdentities: {} },
      type: 'run.started',
    },
    {
      messages: [
        {
          content: [
            { text: `answer-${index} ${'lorem ipsum '.repeat(answerChars / 12)}`, type: 'text' },
          ],
          role: 'assistant',
        },
      ],
      model: { modelId, provider: 'openai.responses' },
      runId,
      stepNumber: 0,
      type: 'model.step',
      usage: { inputTokens: 11, outputTokens: 12, totalTokens: 23 },
    },
    { outcome: 'completed', runId, type: 'run.finished' },
  ];
}

async function longThreadHost(turns: number, answerChars: number, inputTokenLimit: number) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-context-compaction-'));
  const store = await StateStore.open(root, {
    memoryCalculatorModule: join(
      candidate,
      'packages/agent-host/dist/adapters/memory-storage-calculator.js'
    ),
  });
  let core: HostCore | undefined;
  onTestFinished(async () => {
    await core?.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const threadId = randomUUID();
  for (let index = 0; index < turns; index += 1) {
    await store.append(
      recordedTurn(threadId, index, answerChars).map((event) => storedHostEvent(threadId, event)),
      undefined,
      'full'
    );
  }
  const configuration: RuntimeData = { model: modelId, provider };
  const platform = await createProductionHostPlatform({
    close: async () => undefined,
    readConfiguration: async () => ({
      configuration,
      durableConfiguration: { model: modelId, provider },
      maxSteps: 1,
      memory: {
        native: {
          options: {
            lastMessages: 200,
            observationalMemory: false,
            semanticRecall: false,
            workingMemory: { enabled: false },
          },
        },
        recordPrompt: async () => undefined,
        resourceId: 'm3-context-compaction-fixture',
      },
      providerRequestContext: { inputTokenLimit, provider, runtimeData: configuration },
      resolvedToolResultBudget: resolveScaledToolResultBudget(inputTokenLimit),
      tools: {},
      toolTimeoutMs: 1000,
    }),
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveProviderAuth: async () => apiKeyAuthInput('offline-context-fixture-key'),
    startup: { register: async () => undefined, signal: new AbortController().signal, store },
  });
  core = await HostCore.open(store, platform, () => () => undefined);
  const opened = core;
  return {
    run: async (prompt: string) => {
      const finished = Promise.withResolvers<Extract<HostEvent, { type: 'run.finished' }>>();
      const unsubscribe = opened.onCommitted((row) => {
        if (row.threadId === threadId && row.event.type === 'run.finished') {
          finished.resolve(row.event);
        }
      });
      try {
        await opened.startRun({ commandId: randomUUID(), modelId, prompt, threadId });
        const terminal = await finished.promise;
        return { events: (await opened.read(threadId, 0)).map((row) => row.event), terminal };
      } finally {
        unsubscribe();
      }
    },
  };
}

test('a thread longer than its input budget compacts its oldest turns before the request instead of dropping them silently', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push(await new Request(input, init).text());
      return Response.json(
        { error: { message: 'Offline compaction fixture', type: 'fixture_terminal' } },
        { status: 400 }
      );
    })
  );
  // 12 earlier turns of ~2,500 estimated tokens against a 20,000-token budget.
  const host = await longThreadHost(12, 10_000, 20_000);
  const { events } = await host.run('Latest question');

  const compacted = events.filter((event) => event.type === 'context.compacted');
  expect(compacted).toHaveLength(1);
  const [compaction] = compacted;
  expect(compaction).toMatchObject({ kind: 'deterministic', reason: 'pre-request' });
  expect(requests).toHaveLength(1);
  const [request] = requests;
  // The oldest turn is replaced by the committed summary, the newest kept whole.
  expect(request).not.toContain('answer-0 ');
  expect(request).toContain('answer-11 ');
  expect(request).toContain(
    compaction?.type === 'context.compacted' ? compaction.summary : 'missing summary'
  );
});
