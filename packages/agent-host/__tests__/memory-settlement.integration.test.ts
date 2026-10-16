import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { attachAgentHost, type HostClient } from '../dist/client.js';
import {
  createProductionHostPlatform,
  type ProductionHostRunConfiguration,
} from '../dist/production-platform.js';
import type { HostEvent, HostLogRow } from '../dist/protocol.js';
import { type AgentHost, startAgentHost } from '../dist/runtime.js';
import { scriptedToolSequence } from '../dist/test-fixtures/scripted-model.js';
import { captureHostFailureDiagnostics } from './fixtures/host-failure-diagnostics.js';

/**
 * Mastra's step-time async buffering runs the observer in the background
 * (bufferTokens), and its documented contract joins that work only before
 * the storage owner closes (`Memory.settled()`). A run's answer is finished
 * at `run.finished`; its memory settles after, before the thread's next
 * admission reads or rewrites its history.
 */

type Finished = Extract<HostEvent, { type: 'run.finished' }>;

const modelId = 'gpt-6-sol';
const configuration: RuntimeData = { model: modelId, provider: 'openai' };
const resourceId = 'memory-settlement-fixture';
const PROMPT = 'Remember that the launch city is Lisbon and the venue is the riverside hall.';

const fetch = vi.fn(async () => {
  throw new Error('Memory settlement proofs make no provider requests');
});
beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => vi.unstubAllGlobals());

/** An observer whose first call waits for the test, then answers or fails; it honours abort. */
function heldObserver(fails = false) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls += 1;
      if (calls === 1) {
        entered.resolve();
        const aborted = Promise.withResolvers<never>();
        options.abortSignal?.addEventListener(
          'abort',
          () => aborted.reject(options.abortSignal?.reason),
          { once: true }
        );
        await Promise.race([release.promise, aborted.promise]);
        if (fails) {
          throw new Error('Recorded buffered observer failure');
        }
      }
      return scriptedToolSequence([]).doStream({ prompt: [] });
    },
  });
  return { entered: entered.promise, model, release: () => release.resolve() };
}

/** The production composition through the runtime, with step-time async buffering on. */
async function settlementHost(observer: MockLanguageModelV4) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-memory-settlement-')));
  const host: AgentHost = await startAgentHost({ lifetime: 'persistent', root }, (startup) =>
    createProductionHostPlatform({
      close: async () => undefined,
      memoryResourceIds: [resourceId],
      readConfiguration: async (): Promise<ProductionHostRunConfiguration> => ({
        configuration,
        durableConfiguration: { model: modelId, provider: 'openai' },
        maxSteps: 2,
        memory: {
          native: {
            options: {
              lastMessages: 4,
              observationalMemory: {
                model: observer,
                // The committed prompt alone crosses one buffer interval,
                // far below the synchronous observation threshold.
                observation: { bufferTokens: 10, messageTokens: 50_000 },
                reflection: { observationTokens: 40_000 },
                scope: 'thread',
              },
              semanticRecall: false,
              workingMemory: { enabled: false },
            },
          },
          observerModelId: 'openai::gpt-4.1-mini',
          recordPrompt: async () => undefined,
          resourceId,
        },
        providerRequestContext: {
          inputTokenLimit: 50_000,
          provider: 'openai',
          runtimeData: configuration,
        },
        resolvedToolResultBudget: resolveScaledToolResultBudget(20_000),
        tools: {},
        toolTimeoutMs: 10_000,
      }),
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: async () => scriptedToolSequence([]),
      resolveProviderAuth: async () => undefined,
      startup,
    })
  );
  const client: HostClient = await attachAgentHost(host.record);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const rows = async (): Promise<HostLogRow[]> =>
    (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
  const committed = async (
    find: (row: HostLogRow) => boolean,
    timeout = 10_000
  ): Promise<HostLogRow> => {
    let found: HostLogRow | undefined;
    await expect
      .poll(
        async () => {
          found = (await rows()).find(find);
          return found !== undefined;
        },
        { timeout }
      )
      .toBe(true);
    if (!found) {
      throw new Error('The awaited row was not committed');
    }
    return found;
  };
  const start = async (prompt: string, commandId: string = randomUUID()) => {
    const { runId } = await client.request('run/start', {
      commandId,
      modelId: `openai::${modelId}`,
      prompt,
      threadId,
    });
    return { commandId, runId };
  };
  const finished = async (runId: string): Promise<HostLogRow & { event: Finished }> =>
    (await committed(
      ({ event }) => event.type === 'run.finished' && event.runId === runId
    )) as HostLogRow & { event: Finished };
  let closed = false;
  return {
    client,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await client.close();
      await host.close();
      await rm(root, { force: true, recursive: true });
    },
    committed,
    finished,
    rows,
    start,
    threadId,
  };
}

const usageOf =
  (runId: string) =>
  ({ event }: HostLogRow): boolean =>
    event.type === 'memory.usage' && event.runId === runId && event.kind === 'observation';

test('run.finished commits while a step-time observation is still buffering', async () => {
  const observer = heldObserver();
  const host = await settlementHost(observer.model);
  try {
    const { runId } = await host.start(PROMPT);
    await observer.entered;
    // The answer is done; the observer it launched is still held.
    const finished = await host.finished(runId);
    expect(finished.event.outcome).toBe('completed');
    expect((await host.rows()).some(usageOf(runId))).toBe(false);
    observer.release();
    // The observer's spend is still this run's, committed after its end.
    const usage = await host.committed(usageOf(runId));
    expect(usage.seq).toBeGreaterThan(finished.seq);
    expect(usage.event).toMatchObject({ modelId: 'openai::gpt-4.1-mini', runId });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    observer.release();
    await host.close();
  }
});

test("the thread's next run is admitted only after the previous run's memory settles", async () => {
  const observer = heldObserver();
  const host = await settlementHost(observer.model);
  try {
    const first = await host.start(PROMPT);
    await observer.entered;
    await host.finished(first.runId);
    const second = host.start('Which city did I mention?');
    observer.release();
    const { runId } = await second;
    const all = await host.rows();
    const usage = all.find(usageOf(first.runId));
    const started = all.find(({ event }) => event.type === 'run.started' && event.runId === runId);
    expect(usage).toBeDefined();
    expect(started?.seq).toBeGreaterThan(usage?.seq ?? Number.POSITIVE_INFINITY);
    expect((await host.finished(runId)).event.outcome).toBe('completed');
  } finally {
    observer.release();
    await host.close();
  }
});

test('a retried run/start replays its committed result while the memory still settles', async () => {
  const observer = heldObserver();
  const host = await settlementHost(observer.model);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await host.start(PROMPT);
    await observer.entered;
    await host.finished(first.runId);
    // The ledger replays a committed command: it opens no run, so it never
    // waits for (or fails on) the settlement it would otherwise join.
    const replay = host.start(PROMPT, first.commandId);
    const blocked = new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error('The replay waited for the settlement')),
        10_000
      );
    });
    expect(await Promise.race([replay, blocked])).toEqual(first);
    expect((await host.rows()).some(usageOf(first.runId))).toBe(false);
  } finally {
    clearTimeout(deadline);
    observer.release();
    await host.close();
  }
});

test("a rewind is admitted only after the previous run's memory settles", async () => {
  const observer = heldObserver();
  const host = await settlementHost(observer.model);
  try {
    const first = await host.start(PROMPT);
    await observer.entered;
    await host.finished(first.runId);
    const rewind = host.client.request('thread/rewind', {
      commandId: randomUUID(),
      messageId: first.commandId,
      mode: 'conversation-only',
      threadId: host.threadId,
    });
    observer.release();
    await rewind;
    const all = await host.rows();
    const usage = all.find(usageOf(first.runId));
    const accepted = all.find(
      ({ event }) => event.type === 'command.accepted' && event.method === 'thread/rewind'
    );
    expect(usage).toBeDefined();
    expect(accepted?.seq).toBeGreaterThan(usage?.seq ?? Number.POSITIVE_INFINITY);
  } finally {
    observer.release();
    await host.close();
  }
});

test('a buffered observation that fails after run.finished is its own committed fact', async () => {
  const diagnostics = captureHostFailureDiagnostics();
  const observer = heldObserver(true);
  const host = await settlementHost(observer.model);
  try {
    const first = await host.start(PROMPT);
    await observer.entered;
    expect((await host.finished(first.runId)).event.outcome).toBe('completed');
    observer.release();
    const failed = await host.committed(
      ({ event }) => event.type === 'memory.settlement.failed' && event.runId === first.runId
    );
    expect(failed.event).toEqual({
      detail: INTERNAL_FAULT.message,
      runId: first.runId,
      type: 'memory.settlement.failed',
    });
    diagnostics.expectCause('Memory observe failed');
    diagnostics.expectCause('Recorded buffered observer failure');
    // The run's own outcome is unchanged, and the thread accepts its next run.
    const finished = (await host.rows()).filter(
      ({ event }) => event.type === 'run.finished' && event.runId === first.runId
    );
    expect(finished.map(({ event }) => event)).toEqual([
      expect.objectContaining({ outcome: 'completed' }),
    ]);
    const second = await host.start('Report completion.');
    expect((await host.finished(second.runId)).event.outcome).toBe('completed');
  } finally {
    observer.release();
    await host.close();
  }
});

test('host close cancels and joins a settlement that is still buffering', async () => {
  const observer = heldObserver();
  const host = await settlementHost(observer.model);
  const { runId } = await host.start(PROMPT);
  await observer.entered;
  await host.finished(runId);
  // The held observer is never released: close aborts it and joins its tail.
  await host.close();
});
