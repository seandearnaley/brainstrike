/**
 * BST-1932 child-run fixtures: a real HostCore over a real StateStore, a
 * scripted model only, and a crash that stops the old process's writes.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
} from '@brainstrike/assistant-contract';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { RuntimeSubagentSettings } from '@brainstrike/assistant-contract/subagent-settings';
import { type AppendItem, StateStore } from '@brainstrike/state-store';
import { type MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { expect } from 'vitest';
import { z } from 'zod';
import { HostCore, type HostEventStore } from '../../src/core.js';
import type { HostClientOrigin, HostPlatform } from '../../src/ports.js';
import type { HostLogRow } from '../../src/protocol.js';

export type Chunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C>
    ? C
    : never;
export type CallOptions = MockLanguageModelV4['doStreamCalls'][number];
type StreamOptions = Parameters<MockLanguageModelV4['doStream']>[0];

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
export const EXPLORER_INSTRUCTIONS = 'You are the Explorer persona. Cite path:line.';
export const NOTES = 'notes-file-content-7f3a';
export const explorer: AssistantPersonaDefinition = {
  allowedToolIds: ['read_file', 'write_file'],
  description: 'Explores the workspace.',
  id: 'explore',
  instructions: EXPLORER_INSTRUCTIONS,
  label: 'Explorer',
  maxSteps: 4,
  mode: 'read-only',
};

export function userTexts(call: Pick<CallOptions, 'prompt'>): string[] {
  return call.prompt.flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
      : []
  );
}
export function systemText(call: CallOptions): string {
  return call.prompt
    .flatMap((message) => (message.role === 'system' ? [message.content] : []))
    .join('\n');
}
export function toolNames(call: Pick<CallOptions, 'tools'>): string[] {
  return (call.tools ?? []).map((tool) => tool.name).sort();
}
export function toolResults(call: CallOptions): unknown[] {
  return call.prompt.flatMap((message) =>
    message.role === 'tool'
      ? message.content.flatMap((part) => (part.type === 'tool-result' ? [part.output] : []))
      : []
  );
}
export function stream(chunks: Chunk[]) {
  return {
    stream: simulateReadableStream({ chunkDelayInMs: null, chunks, initialDelayInMs: null }),
  };
}
export function toolCalls(calls: readonly [string, unknown, string][]): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    ...calls.map(
      ([toolName, input, toolCallId]): Chunk => ({
        input: JSON.stringify(input),
        toolCallId,
        toolName,
        type: 'tool-call',
      })
    ),
    { finishReason: { raw: 'tool_calls', unified: 'tool-calls' }, type: 'finish', usage },
  ];
}
export function toolCall(toolName: string, input: unknown, toolCallId: string): Chunk[] {
  return toolCalls([[toolName, input, toolCallId]]);
}
export function text(value: string): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { id: 'text-1', type: 'text-start' },
    { delta: value, id: 'text-1', type: 'text-delta' },
    { id: 'text-1', type: 'text-end' },
    { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
  ];
}
/** A provider stream that stays open until its run is aborted. */
export function blocked(options: StreamOptions) {
  return {
    stream: new ReadableStream<Chunk>({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        const signal = options.abortSignal;
        // A Stop can land before the provider call starts; that call must still end.
        if (signal?.aborted) {
          controller.error(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }),
  };
}

export function fixturePlatform(
  model: MockLanguageModelV4,
  writes: string[] = [],
  settings: Partial<RuntimeSubagentSettings> = {}
): HostPlatform {
  return {
    close: async () => undefined,
    delegation: {
      personas: [explorer],
      settings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, ...settings },
    },
    maxSteps: 4,
    readPermissionPolicy: () => ({
      policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'allow', read: 'allow' },
      yolo: false,
    }),
    resolveModel: async () => model,
    tools: {
      read_file: {
        description: 'Read a workspace file',
        execute: async () => ({ content: NOTES }),
        identity: 'native-read-generation-1',
        inputSchema: z.object({ path: z.string() }),
        risk: 'read',
      },
      write_file: {
        description: 'Write a workspace file',
        execute: async (input) => {
          writes.push(JSON.stringify(input));
          return { written: true };
        },
        identity: 'native-write-generation-1',
        inputSchema: z.object({ path: z.string() }),
        risk: 'edit',
      },
    },
  };
}

/** `cleanup` receives the harness teardown; the caller runs it after the test. */
export async function setupChildRunHost(
  model: MockLanguageModelV4,
  cleanup: (() => Promise<void>)[],
  settings: Partial<RuntimeSubagentSettings> = {},
  /** Replaces the default admission, as a production platform's `admitRun` does. */
  admit?: (platform: HostPlatform) => HostPlatform['admitRun']
) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m4-child-runs-'));
  const store = await StateStore.open(root);
  const batches: AppendItem[][] = [];
  /** A crashed process writes nothing more; its successor opens the same store. */
  const writer = (): { dead: boolean; port: HostEventStore } => {
    const state = { dead: false } as { dead: boolean; port: HostEventStore };
    state.port = {
      append: (items, committed, durability) => {
        if (state.dead) {
          return Promise.reject(new Error('process crashed'));
        }
        batches.push([...items]);
        return store.append(items, committed, durability);
      },
      read: (threadId, fromSeq) => store.read(threadId, fromSeq),
      root: store.root,
      syncBoundary: (threadId) => store.syncBoundary(threadId),
      threads: () => store.threads(),
    };
    return state;
  };
  let current = writer();
  const writes: string[] = [];
  const base = fixturePlatform(model, writes, settings);
  const admitRun = admit?.(base);
  const platform: HostPlatform = admitRun ? { ...base, admitRun } : base;
  let core = await HostCore.open(current.port, platform, () => () => undefined);
  const crashed: HostCore[] = [];
  cleanup.push(async () => {
    await core.close();
    // A crashed Core can no longer commit its own teardown; only its joins matter here.
    await Promise.allSettled(crashed.map((dead) => dead.close()));
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  return {
    batches,
    core: () => core,
    /** The process dies mid-work; a fresh Core boots over the same committed store. */
    crash: async () => {
      current.dead = true;
      crashed.push(core);
      current = writer();
      core = await HostCore.open(current.port, platform, () => () => undefined);
    },
    model,
    start: async (prompt: string, origin?: HostClientOrigin): Promise<string> =>
      (
        await core.startRun(
          {
            commandId: randomUUID(),
            modelId: 'scripted',
            prompt,
            threadId,
          },
          origin
        )
      ).runId,
    store,
    threadId,
    writes,
  };
}
export type ChildRunHarness = Awaited<ReturnType<typeof setupChildRunHost>>;

export async function rowsUntil(
  harness: ChildRunHarness,
  threadId: string,
  done: (row: HostLogRow) => boolean
): Promise<HostLogRow[]> {
  let rows: HostLogRow[] = [];
  await expect
    .poll(async () => {
      rows = await harness.core().read(threadId, 0);
      return rows.some(done);
    })
    .toBe(true);
  return rows;
}
export const finished = (runId: string) => (row: HostLogRow) =>
  row.event.type === 'run.finished' && row.event.runId === runId;

/** Every child thread committed so far, in commit order of their origins. */
export async function childThreads(harness: ChildRunHarness): Promise<string[]> {
  return (await harness.store.threads()).filter((id) => id !== harness.threadId);
}
