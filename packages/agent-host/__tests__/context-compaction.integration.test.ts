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

const SUMMARY = [
  'Goal: answer the latest question.',
  'State: twelve earlier questions were answered.',
  'Decisions: None.',
  'Next: None.',
  'Files touched: None.',
].join('\n');

/**
 * The summarizer's non-streaming call gets the final Responses object of the
 * recorded SDK7 fixture (host-capabilities standalone-production-http.mjs);
 * the run's streaming request gets a terminal 400.
 */
function stubProvider(summary: string): { requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const body = (await new Request(input, init).json()) as Record<string, unknown>;
      requests.push(body);
      if (body['stream'] === true) {
        return Response.json(
          { error: { message: 'Offline compaction fixture', type: 'fixture_terminal' } },
          { status: 400 }
        );
      }
      const part = { annotations: [], text: summary, type: 'output_text' };
      return Response.json({
        created_at: 1_753_600_000,
        id: 'resp_compaction_1',
        model: body['model'],
        object: 'response',
        output: [
          {
            content: [part],
            id: 'msg_compaction_1',
            role: 'assistant',
            status: 'completed',
            type: 'message',
          },
        ],
        status: 'completed',
        usage: { input_tokens: 42, output_tokens: 9, total_tokens: 51 },
      });
    })
  );
  return { requests };
}

function compactionOf(events: readonly HostEvent[]) {
  const compacted = events.filter(
    (event): event is Extract<HostEvent, { type: 'context.compacted' }> =>
      event.type === 'context.compacted'
  );
  expect(compacted).toHaveLength(1);
  const [compaction] = compacted;
  if (!compaction) {
    throw new Error('No committed compaction');
  }
  return compaction;
}

// 12 earlier turns of ~10,000 estimated tokens against a 100,000-token budget:
// past the trigger, with the newest 20,000 tokens (answer-10, answer-11) protected.
const TURNS = 12;
const ANSWER_CHARS = 40_000;
const BUDGET = 100_000;

test('a thread longer than its input budget commits an agentic summary of its earlier turns before the request', async () => {
  const { requests } = stubProvider(SUMMARY);
  const host = await longThreadHost(TURNS, ANSWER_CHARS, BUDGET);
  const { events } = await host.run('Latest question');

  const compaction = compactionOf(events);
  expect(compaction).toMatchObject({
    kind: 'agentic',
    modelId,
    reason: 'pre-request',
    summary: SUMMARY,
    usage: { inputTokens: 42, outputTokens: 9, totalTokens: 51 },
  });
  expect(compaction.compactedRunIds).toHaveLength(10);
  expect(requests).toHaveLength(2);
  const [summarizer, request] = requests.map((body) => JSON.stringify(body));
  expect(summarizer).toContain('Create a concise conversation state summary');
  expect(summarizer).toContain('answer-0 ');
  expect(summarizer).toContain('answer-9 ');
  expect(summarizer).not.toContain('answer-10 ');
  expect(request).not.toContain('answer-0 ');
  expect(request).not.toContain('answer-9 ');
  expect(request).toContain('answer-10 ');
  expect(request).toContain('answer-11 ');
  expect(request).toContain('State: twelve earlier questions were answered.');
});

test('a summarizer answer outside the five-section schema commits the labelled deterministic fallback', async () => {
  const { requests } = stubProvider('Just a sentence.');
  const host = await longThreadHost(TURNS, ANSWER_CHARS, BUDGET);
  const { events } = await host.run('Latest question');

  const compaction = compactionOf(events);
  expect(compaction).toMatchObject({
    kind: 'deterministic',
    modelId,
    usage: { inputTokens: 42, outputTokens: 9 },
  });
  expect(compaction.summary).toContain('after an agentic summarizer failure');
  const request = JSON.stringify(requests.at(-1));
  expect(request).not.toContain('answer-0 ');
  expect(request).toContain('answer-11 ');
  expect(request).toContain(compaction.summary);
});

/** The provider's own overflow answer (OpenAI's `context_length_exceeded`), then a terminal 400. */
function stubOverflowThenTerminal(): { requests: string[] } {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push(await new Request(input, init).text());
      return requests.length === 1
        ? Response.json(
            {
              error: {
                code: 'context_length_exceeded',
                message: "This model's maximum context length was exceeded.",
                param: 'input',
                type: 'invalid_request_error',
              },
            },
            { status: 400 }
          )
        : Response.json(
            { error: { message: 'Offline compaction fixture', type: 'fixture_terminal' } },
            { status: 400 }
          );
    })
  );
  return { requests };
}

test('a provider context overflow commits a deterministic compaction and a recovered attempt over the compacted branch', async () => {
  const { requests } = stubOverflowThenTerminal();
  // Six earlier turns of ~10,000 tokens: under the pre-request trigger of 100,000,
  // with answer-4 and answer-5 inside the protect window.
  const host = await longThreadHost(6, ANSWER_CHARS, BUDGET);
  const { events, terminal } = await host.run('Latest question');

  const compaction = compactionOf(events);
  expect(compaction).toMatchObject({ kind: 'deterministic', reason: 'context-overflow' });
  expect(compaction.summary).toContain('after a provider context-overflow error');
  expect(compaction).not.toHaveProperty('usage');
  const attempts = events.filter((event) => event.type === 'run.attempt');
  expect(attempts).toEqual([
    expect.objectContaining({ attempt: 1, reason: 'context-overflow', recovered: true }),
  ]);
  // The compaction commits before the attempt row that announces the recovery.
  expect(events.indexOf(compaction)).toBeLessThan(events.indexOf(attempts[0] as HostEvent));
  expect(requests).toHaveLength(2);
  expect(requests[0]).toContain('answer-0 ');
  expect(requests[1]).not.toContain('answer-0 ');
  expect(requests[1]).toContain('answer-5 ');
  expect(requests[1]).toContain(compaction.summary);
  expect(terminal.outcome).toBe('failed');
});

test('a provider context overflow with nothing droppable fails the run without a compaction or attempt', async () => {
  const { requests } = stubOverflowThenTerminal();
  const host = await longThreadHost(2, ANSWER_CHARS, BUDGET);
  const { events, terminal } = await host.run('Latest question');

  expect(events.filter((event) => event.type === 'context.compacted')).toEqual([]);
  expect(events.filter((event) => event.type === 'run.attempt')).toEqual([]);
  expect(requests).toHaveLength(1);
  expect(terminal).toMatchObject({ outcome: 'failed' });
  expect(terminal.detail).toContain('maximum context length');
});
