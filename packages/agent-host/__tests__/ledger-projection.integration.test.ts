/**
 * Core folds every committed row into the cost views' ledger and each thread's
 * latest run, once, as it commits and again as a restart hydrates it. Both
 * must equal a fold of the full committed log: the renderer folded that log
 * per thread at list time before Core owned the projection.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import recording from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json' with {
  type: 'json',
};
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost } from '../src/client.js';
import { HostCore } from '../src/core.js';
import { storedHostEvent } from '../src/event-storage.js';
import { foldLatestRun, ThreadLedgerFold } from '../src/ledger-projection.js';
import type { HostPlatform } from '../src/ports.js';
import { type HostLogRow, HostLogRowSchema } from '../src/protocol.js';
import { startAgentHost } from '../src/runtime.js';
import {
  childThreads,
  finished,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCall,
} from './fixtures/child-run-host.js';
import { scriptedToolSequence } from './fixtures/scripted-model.js';

// The machine runs many suites at once; a run's terminal commit can take seconds.
const TERMINAL_POLL = { interval: 50, timeout: 30_000 };
const MODEL = 'openrouter::anthropic/claude-sonnet-4.6';
const roots: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-ledger-projection-'));
  roots.push(root);
  return root;
}

/** What the renderer folded per thread at list time: the full committed log. */
function foldedLog(rows: readonly HostLogRow[]) {
  const ledger = new ThreadLedgerFold();
  for (const row of rows) {
    ledger.apply(row);
  }
  return { latest: rows.reduce(foldLatestRun, undefined)?.run, ledger: ledger.read() };
}

test('a recorded log reads back through ledger/read as the renderer folded it', async () => {
  const root = await stateRoot();
  // The recorded runs with a catalog model, as desktop admits one.
  const captured = z
    .array(HostLogRowSchema)
    .parse(recording)
    .map((row) =>
      row.event.type === 'run.started' ? { ...row, event: { ...row.event, modelId: MODEL } } : row
    );
  const store = await StateStore.open(root);
  await store.append(captured.map((row) => storedHostEvent(row.threadId, row.event)));
  await store.close();
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: () => Promise.reject(new Error('A recorded log starts no run')),
      tools: {},
    }
  );
  const client = await attachAgentHost(host.record);
  try {
    const threadId = captured[0]?.threadId ?? '';
    const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
    const { threads } = await client.request('ledger/read', {});
    expect(threads).toEqual([{ threadId, ...foldedLog(rows).ledger }]);
    const [first, second] = rows.filter((row) => row.event.type === 'run.started');
    const firstRunId = first?.event.type === 'run.started' ? first.event.runId : undefined;
    const finished = rows.find(
      (row) => row.event.type === 'run.finished' && row.event.runId === firstRunId
    );
    if (!(firstRunId && second && finished?.ts && first?.ts)) {
      throw new Error('The recording has two runs with commit times');
    }
    // The renderer ledger's recorded values for this log.
    expect(threads[0]?.runs.find((run) => run.runId === firstRunId)).toEqual({
      completedAt: finished.ts,
      durationMs: finished.ts - first.ts,
      editCount: 0,
      estimatedCacheCreationTokens: 0,
      estimatedCacheReadTokens: 0,
      estimatedInputTokens: 2,
      estimatedOutputTokens: 50,
      failedToolCallCount: 0,
      inputTokens: 2,
      model: 'anthropic/claude-sonnet-4.6',
      outcomeDetail: null,
      outcomeSource: null,
      outcomeVerdict: null,
      outputTokens: 50,
      provider: 'openrouter',
      revertedEditCount: 0,
      runId: firstRunId,
      startedAt: first.ts,
      status: 'completed',
      threadId,
      toolCallCount: 1,
    });
    expect(threads[0]?.usage).toHaveLength(4);
    expect(threads[0]?.usage[0]).toEqual({
      at: rows.find((row) => row.event.type === 'model.step')?.ts,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 1,
      model: 'anthropic/claude-sonnet-4.6',
      outputTokens: 25,
      provider: 'openrouter',
    });
  } finally {
    await client.close();
    await host.close();
  }
});

/** One read tool that answers and one whose executor throws, as a model calls them. */
function toolPlatform(): HostPlatform {
  const tool = (execute: () => Promise<unknown>) => ({
    description: 'Synthetic read-only tool',
    execute,
    identity: 'ledger-projection-fixture',
    inputSchema: z.object({ text: z.string() }),
    risk: 'read' as const,
  });
  const model = scriptedToolSequence([
    { input: { text: 'answered' }, toolId: 'answer' },
    { input: { text: 'refused' }, toolId: 'refuse' },
  ]);
  return {
    close: async () => undefined,
    maxSteps: 5,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => model,
    tools: {
      answer: tool(async () => ({ answered: true })),
      refuse: tool(() => Promise.reject(new Error('The tool refused this input'))),
    },
  };
}

test('tool calls and tool errors count as they commit, and again after a restart', async () => {
  const root = await stateRoot();
  const platform = toolPlatform();
  let store = await StateStore.open(root);
  let core = await HostCore.open(store, platform, () => () => undefined);
  let threadId = '';
  let live: ReturnType<HostCore['readLedger']> | undefined;
  let liveLatest: ReturnType<HostCore['readLatestRun']>;
  try {
    ({ threadId } = await core.startThread({ commandId: randomUUID() }));
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: 'openai::gpt-ledger-fixture',
      prompt: 'Call both tools.',
      threadId,
    });
    await expect
      .poll(
        async () =>
          (await core.read(threadId, 0)).some(
            (row) => row.event.type === 'run.finished' && row.event.runId === runId
          ),
        TERMINAL_POLL
      )
      .toBe(true);
    const rows = await core.read(threadId, 0);
    const chunkTypes = rows.flatMap(({ event }) =>
      event.type === 'stream.chunk' ? [z.object({ type: z.string() }).parse(event.chunk).type] : []
    );
    // The recorded stream: both calls stream as tool calls; the refusal as a tool error.
    expect(chunkTypes.filter((type) => type === 'tool-call')).toHaveLength(2);
    expect(chunkTypes.filter((type) => type === 'tool-error')).toHaveLength(1);
    live = core.readLedger();
    liveLatest = core.readLatestRun(threadId);
    const folded = foldedLog(rows);
    expect(live).toEqual({ threads: [{ threadId, ...folded.ledger }] });
    expect(live.threads[0]?.runs).toMatchObject([
      { failedToolCallCount: 1, runId, status: 'completed', toolCallCount: 2 },
    ]);
    expect(liveLatest).toEqual(folded.latest);
    expect(liveLatest).toMatchObject({ needsInput: false, status: 'completed' });
  } finally {
    await core.close();
    await store.close();
  }
  // A restart hydrates the same projection from the committed log.
  store = await StateStore.open(root);
  core = await HostCore.open(store, platform, () => () => undefined);
  try {
    expect(core.readLedger()).toEqual(live);
    expect(core.readLatestRun(threadId)).toEqual(liveLatest);
  } finally {
    await core.close();
    await store.close();
  }
});

test("a delegated child's runs and provider calls count in the ledger beside its parent's", async () => {
  // The parent delegates in the foreground once; the child reads one file, then answers.
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const answered = options.prompt.some((message) => message.role === 'tool');
      if ((options.tools ?? []).some((tool) => tool.name === 'agent-explore')) {
        return stream(
          answered
            ? text('Parent consumed the child result.')
            : toolCall(
                'agent-explore',
                { _background: { enabled: false }, prompt: 'Find what notes.txt says.' },
                'parent-call-1'
              )
        );
      }
      return stream(
        answered
          ? text('Child found the notes.')
          : toolCall('read_file', { path: 'notes.txt' }, 'child-call-1')
      );
    },
  });
  const harness = await setupChildRunHost(model, cleanup);
  const { runId } = await harness.core().startRun({
    commandId: randomUUID(),
    modelId: 'openai::gpt-ledger-fixture',
    prompt: 'Delegate the notes question to Explorer.',
    threadId: harness.threadId,
  });
  await rowsUntil(harness, harness.threadId, finished(runId), TERMINAL_POLL.timeout);
  const [childThreadId] = await childThreads(harness);
  if (!childThreadId) {
    throw new Error('The parent delegated no child');
  }
  const { threads } = harness.core().readLedger();
  expect(threads.map((thread) => thread.threadId).sort()).toEqual(
    [harness.threadId, childThreadId].sort()
  );
  const child = threads.find((thread) => thread.threadId === childThreadId);
  expect(child).toEqual({
    threadId: childThreadId,
    ...foldedLog(await harness.core().read(childThreadId, 0)).ledger,
  });
  // Two child steps of the run's model, one tool call between them.
  expect(child?.runs).toMatchObject([
    { failedToolCallCount: 0, status: 'completed', threadId: childThreadId, toolCallCount: 1 },
  ]);
  expect(child?.usage).toHaveLength(2);
});
