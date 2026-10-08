/**
 * BST-1932 S1: a foreground persona delegation is a host run in a Core-created
 * child thread. Its origin commits with the parent's effect in one StateStore
 * transaction, its authority is the parent's admitted tools narrowed by the
 * persona, and only its final text reaches the parent's model context.
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
import { type AppendItem, StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore, type HostEventStore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';

type Chunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C>
    ? C
    : never;
type CallOptions = MockLanguageModelV4['doStreamCalls'][number];

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const EXPLORER_INSTRUCTIONS = 'You are the Explorer persona. Cite path:line.';
const NOTES = 'notes-file-content-7f3a';
const explorer: AssistantPersonaDefinition = {
  allowedToolIds: ['read_file', 'write_file'],
  description: 'Explores the workspace.',
  id: 'explore',
  instructions: EXPLORER_INSTRUCTIONS,
  label: 'Explorer',
  maxSteps: 4,
  mode: 'read-only',
};

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

function userTexts(call: CallOptions): string[] {
  return call.prompt.flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
      : []
  );
}
function systemText(call: CallOptions): string {
  return call.prompt
    .flatMap((message) => (message.role === 'system' ? [message.content] : []))
    .join('\n');
}
function toolNames(call: CallOptions): string[] {
  return (call.tools ?? []).map((tool) => tool.name).sort();
}
function toolResults(call: CallOptions): unknown[] {
  return call.prompt.flatMap((message) =>
    message.role === 'tool'
      ? message.content.flatMap((part) => (part.type === 'tool-result' ? [part.output] : []))
      : []
  );
}
function stream(chunks: Chunk[]) {
  return {
    stream: simulateReadableStream({ chunkDelayInMs: null, chunks, initialDelayInMs: null }),
  };
}
function toolCall(toolName: string, input: unknown, toolCallId: string): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { input: JSON.stringify(input), toolCallId, toolName, type: 'tool-call' },
    { finishReason: { raw: 'tool_calls', unified: 'tool-calls' }, type: 'finish', usage },
  ];
}
function text(value: string): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { id: 'text-1', type: 'text-start' },
    { delta: value, id: 'text-1', type: 'text-delta' },
    { id: 'text-1', type: 'text-end' },
    { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
  ];
}

/** Parent and child are told apart by tool surface and task marker, like the desktop shim. */
function delegationModel(task: string) {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const names = (options.tools ?? []).map((tool) => tool.name);
      const answered = options.prompt.some((message) => message.role === 'tool');
      if (names.includes('agent-explore')) {
        return stream(
          answered
            ? text('Parent consumed the child result.')
            : toolCall('agent-explore', { prompt: task }, 'parent-call-1')
        );
      }
      const user = userTexts(options as CallOptions).join('\n');
      if (user.includes('BLOCK_TASK')) {
        return {
          stream: new ReadableStream<Chunk>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              options.abortSignal?.addEventListener(
                'abort',
                () => controller.error(options.abortSignal?.reason),
                { once: true }
              );
            },
          }),
        };
      }
      if (user.includes('FAIL_TASK')) {
        throw new Error('child provider failed');
      }
      return stream(
        answered
          ? text('Child found the notes.')
          : toolCall('read_file', { path: 'notes.txt' }, 'child-call-1')
      );
    },
  });
}

async function setup(task: string) {
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
  const model = delegationModel(task);
  const writes: string[] = [];
  const platform: HostPlatform = {
    close: async () => undefined,
    delegation: { personas: [explorer], settings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS },
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
    store,
    threadId,
    writes,
  };
}
type Harness = Awaited<ReturnType<typeof setup>>;

async function rowsUntil(
  harness: Harness,
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
const finished = (runId: string) => (row: HostLogRow) =>
  row.event.type === 'run.finished' && row.event.runId === runId;

async function childThreadOf(harness: Harness): Promise<string> {
  let childThreadId: string | undefined;
  await expect
    .poll(async () => {
      childThreadId = (await harness.store.threads()).find((id) => id !== harness.threadId);
      return childThreadId;
    })
    .toBeDefined();
  return childThreadId as string;
}

test('a foreground persona child runs in its own thread with narrowed tools and returns only its final text', async () => {
  const task = 'EXPLORE_TASK: find what notes.txt says.';
  const harness = await setup(task);
  const { runId } = await harness.core().startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Delegate the notes question to Explorer.',
    threadId: harness.threadId,
  });
  const parentRows = await rowsUntil(harness, harness.threadId, finished(runId));
  expect(parentRows.find(finished(runId))?.event).toMatchObject({ outcome: 'completed' });

  const [parentFirst, childFirst, childSecond, parentSecond] = harness.model.doStreamCalls;
  expect(harness.model.doStreamCalls).toHaveLength(4);
  // The parent advertises the persona's delegation tool beside its own catalog.
  expect(toolNames(parentFirst as CallOptions)).toEqual([
    'agent-explore',
    'read_file',
    'write_file',
  ]);
  // The read-only child: persona instructions, a fresh context holding only the
  // task, and the parent's admitted tools narrowed to read risk. No delegation.
  const child = childFirst as CallOptions;
  expect(systemText(child)).toContain(EXPLORER_INSTRUCTIONS);
  expect(userTexts(child)).toEqual([task]);
  expect(toolNames(child)).toEqual(['read_file']);
  expect(JSON.stringify(childSecond?.prompt)).toContain(NOTES);
  // Only the child's final text reaches the parent, never its tool results.
  const parentResult = JSON.stringify(toolResults(parentSecond as CallOptions));
  expect(parentResult).toContain('Child found the notes.');
  expect(parentResult).not.toContain(NOTES);
  expect(harness.writes).toEqual([]);

  const childThreadId = await childThreadOf(harness);
  const childRows = await harness.core().read(childThreadId, 0);
  const started = childRows.find((row) => row.event.type === 'run.started');
  expect(childRows[0]?.event).toEqual({
    origin: {
      background: false,
      depth: 1,
      parentRunId: runId,
      parentThreadId: harness.threadId,
      persona: 'explore',
      toolCallId: 'parent-call-1',
      turnId: runId,
    },
    type: 'thread.started',
  });
  expect(started?.event).toMatchObject({ parentMessageId: null, prompt: task });
  const childRunId = started?.event.type === 'run.started' ? started.event.runId : '';
  expect(childRows.find(finished(childRunId))?.event).toMatchObject({ outcome: 'completed' });
  expect(
    parentRows.find(
      (row) => row.event.type === 'effect.finished' && row.event.toolCallId === 'parent-call-1'
    )?.event
  ).toMatchObject({
    output: { childThreadId, status: 'completed', text: 'Child found the notes.' },
  });

  // One StateStore transaction holds the parent's effect and the child's origin and start.
  const commit = harness.batches.find((items) =>
    items.some((item) => item.threadId === childThreadId && item.event.type === 'thread.started')
  );
  expect(commit?.map((item) => [item.threadId, item.event.type])).toEqual([
    [harness.threadId, 'effect.started'],
    [childThreadId, 'thread.started'],
    [childThreadId, 'run.started'],
  ]);

  // Child threads are reachable through the parent, never as top-level threads.
  expect(
    harness
      .core()
      .listThreads()
      .map((thread) => thread.threadId)
  ).toEqual([harness.threadId]);
});

test('a child failure reaches the parent as an explicit failed result, never an empty success', async () => {
  const harness = await setup('FAIL_TASK: this child cannot answer.');
  const { runId } = await harness.core().startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Delegate a task that fails.',
    threadId: harness.threadId,
  });
  const rows = await rowsUntil(harness, harness.threadId, finished(runId));
  const output = rows.find(
    (row) => row.event.type === 'effect.finished' && row.event.toolCallId === 'parent-call-1'
  )?.event;
  expect(output).toMatchObject({ output: { status: 'failed' } });
  const parentSecond = harness.model.doStreamCalls.at(-1) as CallOptions;
  expect(JSON.stringify(toolResults(parentSecond))).toContain(
    'Subagent \\"Explorer\\" failed before completing the task'
  );
});

test('stopping the parent stops its foreground child', async () => {
  const harness = await setup('BLOCK_TASK: wait until stopped.');
  const { runId } = await harness.core().startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Delegate a long task.',
    threadId: harness.threadId,
  });
  const childThreadId = await childThreadOf(harness);
  const childStarted = await rowsUntil(
    harness,
    childThreadId,
    (row) => row.event.type === 'run.started'
  );
  const childRunId = childStarted.find((row) => row.event.type === 'run.started')?.event;
  await harness.core().stop({ commandId: randomUUID(), runId, threadId: harness.threadId });
  const childRows = await rowsUntil(
    harness,
    childThreadId,
    (row) => row.event.type === 'run.finished'
  );
  expect(childRows.find((row) => row.event.type === 'run.finished')?.event).toMatchObject({
    outcome: 'stopped',
    runId: childRunId?.type === 'run.started' ? childRunId.runId : '',
  });
});

test('a crash restart interrupts a running child and its parent without a model call', async () => {
  const harness = await setup('BLOCK_TASK: still running at restart.');
  const { runId } = await harness.core().startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Delegate work that outlives the host.',
    threadId: harness.threadId,
  });
  const childThreadId = await childThreadOf(harness);
  await rowsUntil(harness, childThreadId, (row) => row.event.type === 'run.started');
  const calls = harness.model.doStreamCalls.length;
  await harness.crash();
  expect(harness.model.doStreamCalls).toHaveLength(calls);
  const childRows = await harness.core().read(childThreadId, 0);
  expect(childRows.find((row) => row.event.type === 'run.finished')?.event).toMatchObject({
    outcome: 'interrupted',
  });
  const parentRows = await harness.core().read(harness.threadId, 0);
  expect(parentRows.find(finished(runId))?.event).toMatchObject({ outcome: 'interrupted' });
  expect(
    harness
      .core()
      .listThreads()
      .map((thread) => thread.threadId)
  ).toEqual([harness.threadId]);
});
