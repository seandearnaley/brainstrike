import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import type { HostEvent, HostLogRow } from '../src/protocol.js';

type Chunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C>
    ? C
    : never;
type Finished = Extract<HostEvent, { type: 'run.finished' }>;
/** A provider stream part, or a pause in milliseconds before the next one. */
type Timeline = readonly (Chunk | number)[];

// Short, ordered windows (the resilience config enforces their order). The
// machine runs many suites at once, so every healthy pause keeps wide slack.
const WINDOWS = {
  BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS: '1500',
  BRAINSTRIKE_STREAM_INACTIVITY_MS: '1000',
  BRAINSTRIKE_STREAM_REASONING_GAP_MS: '4000',
  BRAINSTRIKE_TOOL_CALL_INPUT_MS: '2000',
} as const;
const TERMINAL_POLL = { interval: 50, timeout: 30_000 };

beforeEach(() => {
  for (const [name, value] of Object.entries(WINDOWS)) {
    vi.stubEnv(name, value);
  }
});
afterEach(() => vi.unstubAllEnvs());

// The pinned provider v4 stream contract, as the recorded scripted fixtures use it.
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const stop: Chunk = { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage };
const text = (delta: string): Chunk[] => [
  { id: 'text-1', type: 'text-start' },
  { delta, id: 'text-1', type: 'text-delta' },
  { id: 'text-1', type: 'text-end' },
];

/**
 * One timeline per provider call. A timeline without a `finish` part leaves
 * the provider stream open until the request is aborted, like a wedged route.
 */
function timedModel(calls: readonly Timeline[]): {
  readonly model: MockLanguageModelV4;
  readonly aborted: () => number;
} {
  let call = 0;
  let aborted = 0;
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const timeline = calls[Math.min(call, calls.length - 1)] ?? [];
      call += 1;
      const stream = new ReadableStream<Chunk>({
        start(controller) {
          abortSignal?.addEventListener(
            'abort',
            () => {
              aborted += 1;
              controller.error(abortSignal.reason);
            },
            { once: true }
          );
          void (async () => {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            for (const entry of timeline) {
              if (typeof entry === 'number') {
                await sleep(entry);
              } else if (!abortSignal?.aborted) {
                controller.enqueue(entry);
              }
            }
            if (timeline.some((entry) => typeof entry !== 'number' && entry.type === 'finish')) {
              controller.close();
            }
          })();
        },
      });
      return { stream };
    },
  });
  return { aborted: () => aborted, model };
}

async function finishedRun(
  model: MockLanguageModelV4,
  overrides: Partial<HostPlatform> = {}
): Promise<{ readonly rows: readonly HostLogRow[]; readonly terminal: Finished }> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-run-watchdog-'));
  const store = await StateStore.open(root);
  const core = await HostCore.open(
    store,
    {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveModel: async () => model,
      tools: {},
      ...overrides,
    },
    () => () => undefined
  );
  try {
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Synthetic offline watchdog test.',
      threadId,
    });
    let terminal: Finished | undefined;
    let rows: readonly HostLogRow[] = [];
    await expect
      .poll(async () => {
        rows = await core.read(threadId, 0);
        terminal = rows
          .map((row) => row.event)
          .find(
            (event): event is Finished => event.type === 'run.finished' && event.runId === runId
          );
        return terminal !== undefined;
      }, TERMINAL_POLL)
      .toBe(true);
    if (!terminal) {
      throw new Error('Run did not finish');
    }
    return { rows, terminal };
  } finally {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  }
}

function committedTextDeltas(rows: readonly HostLogRow[]): string[] {
  return rows.flatMap((row) =>
    row.event.type === 'stream.chunk' &&
    typeof row.event.chunk === 'object' &&
    row.event.chunk !== null &&
    !Array.isArray(row.event.chunk) &&
    row.event.chunk['type'] === 'text-delta' &&
    typeof row.event.chunk['text'] === 'string'
      ? [row.event.chunk['text']]
      : []
  );
}

const probeTool = (delayMs: number): Partial<HostPlatform> => ({
  tools: {
    probe: {
      description: 'Read-only probe',
      execute: async () => {
        await sleep(delayMs);
        return { seen: true };
      },
      identity: 'probe-identity',
      inputSchema: z.object({ text: z.string() }),
      risk: 'read',
    },
  },
});

test('a provider that never answers fails after the first-output window and is cancelled', async () => {
  const { aborted, model } = timedModel([[]]);
  const { terminal } = await finishedRun(model);
  expect(terminal.outcome).toBe('failed');
  expect(terminal.detail).toBe(
    'The model produced no output within 1500ms of the request starting.'
  );
  expect(aborted()).toBe(1);
});

test('a stream that goes quiet mid-answer fails after the inter-output window', async () => {
  const { aborted, model } = timedModel([
    [
      { id: 'text-1', type: 'text-start' },
      { delta: 'Partial', id: 'text-1', type: 'text-delta' },
    ],
  ]);
  const { rows, terminal } = await finishedRun(model);
  expect(terminal.outcome).toBe('failed');
  expect(terminal.detail).toBe('The model stream stalled after 1000ms without output.');
  expect(committedTextDeltas(rows)).toEqual(['Partial']);
  expect(aborted()).toBe(1);
});

test('a stream that stops mid-reasoning fails after the reasoning-gap window', async () => {
  const { model } = timedModel([
    [
      { id: 'reasoning-1', type: 'reasoning-start' },
      { delta: 'Thinking', id: 'reasoning-1', type: 'reasoning-delta' },
    ],
  ]);
  const { terminal } = await finishedRun(model);
  expect(terminal.outcome).toBe('failed');
  expect(terminal.detail).toBe(
    'The model stopped mid-reasoning, producing nothing further for 4000ms. Retry, or lower the reasoning effort if it recurs.'
  );
});

test('a reasoning pause and a running tool may outlast the inter-output window', async () => {
  const { model } = timedModel([
    [
      { id: 'reasoning-1', type: 'reasoning-start' },
      { delta: 'Thinking', id: 'reasoning-1', type: 'reasoning-delta' },
      2000,
      { delta: ' more', id: 'reasoning-1', type: 'reasoning-delta' },
      { id: 'reasoning-1', type: 'reasoning-end' },
      {
        input: JSON.stringify({ text: 'look' }),
        toolCallId: 'recorded-call-1',
        toolName: 'probe',
        type: 'tool-call',
      },
      { finishReason: { raw: 'tool_use', unified: 'tool-calls' }, type: 'finish', usage },
    ],
    [...text('Done.'), stop],
  ]);
  const { rows, terminal } = await finishedRun(model, probeTool(2500));
  expect(terminal.detail).toBeUndefined();
  expect(terminal.outcome).toBe('completed');
  expect(rows.some((row) => row.event.type === 'effect.finished')).toBe(true);
});

test('a tool call whose arguments never finish streaming fails before it executes', async () => {
  const deltas = Array.from(
    { length: 40 },
    (): Timeline => [300, { delta: ' ', id: 'call-1', type: 'tool-input-delta' }]
  ).flat();
  const { aborted, model } = timedModel([
    [
      { id: 'call-1', toolName: 'probe', type: 'tool-input-start' },
      { delta: '{"text":', id: 'call-1', type: 'tool-input-delta' },
      ...deltas,
    ],
  ]);
  const { rows, terminal } = await finishedRun(model, probeTool(0));
  expect(terminal.outcome).toBe('failed');
  expect(terminal.detail).toBe(
    "The model did not finish streaming a tool call's arguments within 2000ms. The incomplete tool call was cancelled before execution."
  );
  expect(rows.some((row) => row.event.type === 'effect.started')).toBe(false);
  expect(aborted()).toBe(1);
});
