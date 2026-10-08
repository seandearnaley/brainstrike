import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { expect, vi } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../../src/core.js';
import type { HostPlatform } from '../../src/ports.js';
import type { HostEvent, HostLogRow } from '../../src/protocol.js';

/**
 * Host runs over a scripted provider whose stream parts arrive on a timeline,
 * for the stream watchdog and attempt-recovery proofs.
 */
export type Chunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C>
    ? C
    : never;
export type Finished = Extract<HostEvent, { type: 'run.finished' }>;
/** A provider stream part, or a pause in milliseconds before the next one. */
export type Timeline = readonly (Chunk | number)[];

// Short, ordered windows (the resilience config enforces their order). The
// machine runs many suites at once, so every healthy pause keeps wide slack.
export const WINDOWS = {
  BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS: '1500',
  BRAINSTRIKE_STREAM_INACTIVITY_MS: '1000',
  BRAINSTRIKE_STREAM_REASONING_GAP_MS: '4000',
  BRAINSTRIKE_TOOL_CALL_INPUT_MS: '2000',
} as const;
export const TERMINAL_POLL = { interval: 50, timeout: 30_000 };

/** Stub the windows (and any other resilience settings) for one test. */
export function stubResilience(overrides: Record<string, string> = {}): void {
  for (const [name, value] of Object.entries({ ...WINDOWS, ...overrides })) {
    vi.stubEnv(name, value);
  }
}

// The pinned provider v4 stream contract, as the recorded scripted fixtures use it.
export const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
export const stop: Chunk = {
  finishReason: { raw: 'stop', unified: 'stop' },
  type: 'finish',
  usage,
};
export const text = (delta: string): Chunk[] => [
  { id: 'text-1', type: 'text-start' },
  { delta, id: 'text-1', type: 'text-delta' },
  { id: 'text-1', type: 'text-end' },
];

/**
 * One timeline per provider call. A timeline without a `finish` part leaves
 * the provider stream open until the request is aborted, like a wedged route;
 * a provider `error` part ends the response, as a provider does.
 */
export function timedModel(calls: readonly Timeline[]): {
  readonly model: MockLanguageModelV4;
  readonly aborted: () => number;
  readonly calls: () => number;
} {
  let call = 0;
  let aborted = 0;
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const timeline = calls[Math.min(call, calls.length - 1)] ?? [];
      call += 1;
      const stream = new ReadableStream<Chunk>({
        start(controller) {
          // Counts only a request aborted while its response is still open.
          const abort = (): void => {
            aborted += 1;
            controller.error(abortSignal?.reason);
          };
          abortSignal?.addEventListener('abort', abort, { once: true });
          void (async () => {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            for (const entry of timeline) {
              if (typeof entry === 'number') {
                await sleep(entry);
              } else if (!abortSignal?.aborted) {
                controller.enqueue(entry);
              }
            }
            // A finish or a provider error part ends the provider's response.
            if (
              timeline.some(
                (entry) =>
                  typeof entry !== 'number' && (entry.type === 'finish' || entry.type === 'error')
              )
            ) {
              abortSignal?.removeEventListener('abort', abort);
              controller.close();
            }
          })();
        },
      });
      return { stream };
    },
  });
  return { aborted: () => aborted, calls: () => call, model };
}

export async function finishedRun(
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

export function committedTextDeltas(rows: readonly HostLogRow[]): string[] {
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

export const probeTool = (delayMs: number): Partial<HostPlatform> => ({
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
