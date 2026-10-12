/**
 * BST-1932 S1: a foreground persona delegation is a host run in a Core-created
 * child thread. Its origin commits with the parent's effect in one StateStore
 * transaction, its authority is the parent's admitted tools narrowed by the
 * persona, and only its final text reaches the parent's model context.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost } from '../src/client.js';
import { openHostStateIndex } from '../src/host-state-index.js';
import { startAgentHost } from '../src/runtime.js';
import {
  blocked,
  type CallOptions,
  type ChildRunHarness,
  childThreads,
  EXPLORER_INSTRUCTIONS,
  finished,
  fixturePlatform,
  NOTES,
  rowsUntil,
  setupChildRunHost,
  stream,
  systemText,
  text,
  toolCall,
  toolNames,
  toolResults,
  userTexts,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

/**
 * Parent and child are told apart by tool surface and task marker, like the
 * desktop shim. The parent asks for foreground execution explicitly; a root
 * delegation is otherwise a background child (S2).
 */
function delegationModel(task: string) {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const names = (options.tools ?? []).map((tool) => tool.name);
      const answered = options.prompt.some((message) => message.role === 'tool');
      if (names.includes('agent-explore')) {
        return stream(
          answered
            ? text('Parent consumed the child result.')
            : toolCall(
                'agent-explore',
                { _background: { enabled: false }, prompt: task },
                'parent-call-1'
              )
        );
      }
      const user = userTexts(options).join('\n');
      if (user.includes('BLOCK_TASK')) {
        return blocked(options);
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

function setup(task: string): Promise<ChildRunHarness> {
  return setupChildRunHost(delegationModel(task), cleanup);
}

async function childThreadOf(harness: ChildRunHarness): Promise<string> {
  let childThreadId: string | undefined;
  await expect
    .poll(async () => {
      childThreadId = (await childThreads(harness))[0];
      return childThreadId;
    })
    .toBeDefined();
  return childThreadId as string;
}

test('a foreground persona child runs in its own thread with narrowed tools and returns only its final text', async () => {
  const task = 'EXPLORE_TASK: find what notes.txt says.';
  const harness = await setup(task);
  const runId = await harness.start('Delegate the notes question to Explorer.');
  const parentRows = await rowsUntil(harness, harness.threadId, finished(runId));
  expect(parentRows.find(finished(runId))?.event).toMatchObject({ outcome: 'completed' });

  const [parentFirst, childFirst, childSecond, parentSecond] = harness.model.doStreamCalls;
  expect(harness.model.doStreamCalls).toHaveLength(4);
  // The parent advertises the persona's delegation tool beside its own catalog.
  expect(toolNames(parentFirst as CallOptions)).toEqual([
    'agent-explore',
    'ask_user',
    'read_file',
    'run_command',
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
      profile: { label: 'Explorer', mode: 'read-only' },
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

  // One StateStore transaction holds the parent's effect and the child's origin,
  // selection (ADR-0019) and start.
  const commit = harness.batches.find((items) =>
    items.some((item) => item.threadId === childThreadId && item.event.type === 'thread.started')
  );
  expect(commit?.map((item) => [item.threadId, item.event.type])).toEqual([
    [harness.threadId, 'effect.started'],
    [childThreadId, 'thread.started'],
    [childThreadId, 'thread.selection.updated'],
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
  const runId = await harness.start('Delegate a task that fails.');
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
  const runId = await harness.start('Delegate a long task.');
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
  const runId = await harness.start('Delegate work that outlives the host.');
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

test('a delegated child is listed only once its thread has committed', async () => {
  // AT-03's recorded defect: the tree's approvals listed a reserved child, its
  // log subscription found no thread ("Unknown thread"), and its approval was lost.
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = false;
  const harness = await setupChildRunHost(
    delegationModel('EXPLORE_TASK: find what notes.txt says.'),
    cleanup,
    {
      holdAppend: async (items) => {
        if (
          !held &&
          items.some(({ event }) => event.type === 'thread.started' && 'origin' in event)
        ) {
          held = true;
          entered.resolve();
          await release.promise;
        }
      },
    }
  );
  const runId = await harness.start('Delegate the notes.');
  await entered.promise;
  // The delegation is reserved and its commit is in flight: nothing to list yet.
  let reserved: unknown;
  try {
    reserved = harness.core().listChildren(harness.threadId);
  } finally {
    release.resolve();
  }
  expect(reserved).toEqual([]);
  await rowsUntil(harness, harness.threadId, finished(runId));
  expect(
    harness
      .core()
      .listChildren(harness.threadId)
      .map(({ origin }) => origin.persona)
  ).toEqual(['explore']);
});

test('deleting a parent thread deletes its child threads through the same host delete path', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m4-child-delete-')));
  const model = delegationModel('EXPLORE_TASK: find what notes.txt says.');
  const start = () =>
    startAgentHost({ lifetime: 'persistent', root }, async (context) => {
      const index = await openHostStateIndex(context.store.root);
      return {
        ...fixturePlatform(model),
        close: () => index.close(),
        stateIndexer: index.indexer,
      };
    });
  let host = await start();
  let client = await attachAgentHost(host.record);
  cleanup.push(async () => {
    await client.close();
    await host.close();
    await rm(root, { force: true, recursive: true });
  });
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { threadId: neighbor } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Delegate the notes question to Explorer.',
    threadId,
  });
  let childThreadId: string | undefined;
  await expect
    .poll(async () => {
      const rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
      const output = rows.find(
        (row) => row.event.type === 'effect.finished' && row.event.toolCallId === 'parent-call-1'
      )?.event;
      childThreadId =
        output?.type === 'effect.finished'
          ? (output.output as { childThreadId?: string }).childThreadId
          : undefined;
      return rows.some((row) => row.event.type === 'run.finished' && row.event.runId === runId);
    })
    .toBe(true);
  expect(childThreadId).toBeDefined();
  const child = childThreadId as string;
  expect(
    (await client.request('thread/read', { fromSeq: 0, threadId: child })).rows.length
  ).toBeGreaterThan(0);

  // The deletion names its whole subtree: the child, then the thread that delegated it.
  expect(await client.request('thread/delete', { threadId })).toEqual({
    deleted: true,
    threadIds: [child, threadId],
  });
  await expect(client.request('thread/read', { fromSeq: 0, threadId: child })).rejects.toThrow(
    'Unknown thread'
  );
  await client.close();
  await host.close();
  host = await start();
  client = await attachAgentHost(host.record);
  await expect(client.request('thread/read', { fromSeq: 0, threadId: child })).rejects.toThrow(
    'Unknown thread'
  );
  expect((await client.request('thread/list', {})).threads.map((row) => row.threadId)).toEqual([
    neighbor,
  ]);
});
