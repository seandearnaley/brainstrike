import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import type { HostEvent, HostLogRow } from '../src/protocol.js';
import { foldHostRuns } from '../src/thread-view.js';

type Chunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C>
    ? C
    : never;
type FinishReason = Extract<Chunk, { type: 'finish' }>['finishReason'];
type Finished = Extract<HostEvent, { type: 'run.finished' }>;
// The machine runs many suites at once; a run's terminal commit can take seconds.
const TERMINAL_POLL = { interval: 50, timeout: 30_000 };

// The pinned provider v4 stream contract, as the recorded scripted fixtures use it.
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const finish = (unified: FinishReason['unified'], raw: string): Chunk => ({
  finishReason: { raw, unified },
  type: 'finish',
  usage,
});
const text = (delta: string): Chunk[] => [
  { id: 'text-1', type: 'text-start' },
  { delta, id: 'text-1', type: 'text-delta' },
  { id: 'text-1', type: 'text-end' },
];

/** One scripted provider response per step, in order. */
function stepsModel(steps: readonly (readonly Chunk[])[]): MockLanguageModelV4 {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[Math.min(step, steps.length - 1)] ?? [];
      step += 1;
      return {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [{ type: 'stream-start', warnings: [] }, ...chunks],
          initialDelayInMs: null,
        }),
      };
    },
  });
}

async function finishedRun(
  model: MockLanguageModelV4,
  overrides: Partial<HostPlatform> = {}
): Promise<{ readonly rows: readonly HostLogRow[]; readonly terminal: Finished }> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-run-outcome-'));
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
      prompt: 'Synthetic offline run outcome test.',
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

test('a normal reply completes', async () => {
  const { terminal } = await finishedRun(stepsModel([[...text('Done.'), finish('stop', 'stop')]]));
  expect(terminal.outcome).toBe('completed');
  expect(terminal.detail).toBeUndefined();
});

test.each([
  ['no output at all', [finish('stop', 'stop')]],
  ['whitespace-only text', [...text(' \n\t '), finish('stop', 'end_turn')]],
])('an empty reply (%s) is a visible failure, not success', async (_case, chunks) => {
  const { terminal } = await finishedRun(stepsModel([chunks]));
  expect(terminal.outcome).toBe('failed');
  expect(terminal.detail).toMatch(/returned an empty response/u);
  expect(terminal.detail).toContain('finish reason "stop"');
});

test('a reply after a completed tool step may end without new text', async () => {
  const { terminal, rows } = await finishedRun(
    stepsModel([
      [
        {
          input: JSON.stringify({ text: 'look' }),
          toolCallId: 'recorded-call-1',
          toolName: 'probe',
          type: 'tool-call',
        },
        finish('tool-calls', 'tool_use'),
      ],
      [finish('stop', 'end_turn')],
    ]),
    {
      readPermissionPolicy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES, read: 'allow' },
        yolo: false,
      }),
      tools: {
        probe: {
          description: 'Read-only probe',
          execute: async () => ({ seen: true }),
          identity: 'probe-identity',
          inputSchema: z.object({ text: z.string() }),
          risk: 'read',
        },
      },
    }
  );
  expect(rows.some((row) => row.event.type === 'effect.finished')).toBe(true);
  expect(terminal.outcome).toBe('completed');
});

test.each([
  [
    'length',
    'max_tokens',
    'Assistant stopped because the model reached its output token limit before completing the response.',
  ],
  [
    'content-filter',
    'refusal',
    'Assistant stopped because the provider content filter ended the response.',
  ],
  ['other', 'pause_turn', 'Assistant stream ended without a normal stop signal.'],
] as const)(
  'finish reason %s is a visible failure that keeps the partial text',
  async (unified, raw, detail) => {
    const { rows, terminal } = await finishedRun(
      stepsModel([[...text('Partial answer'), finish(unified, raw)]])
    );
    expect(terminal.outcome).toBe('failed');
    expect(terminal.detail).toBe(detail);
    // The ended step's committed `model.step` keeps the partial text.
    expect(foldHostRuns(rows)[0]?.text).toBe('Partial answer');
  }
);
