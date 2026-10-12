import { createHash } from 'node:crypto';
import { prepareProviderRequest } from '@brainstrike/agent/provider-request';
import { RootLock } from '@brainstrike/state-store';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { StateStoreHostMemoryOptions } from '../src/adapters/state-store-host-memory.js';
import type { HostLogRow } from '../src/protocol.js';
import {
  ACCOUNTING_OBSERVER_CATALOG_ID,
  AccountingFixtureDiagnostics,
  finalPromptAccountingHost,
  HISTORY_FACT,
  OBSERVATION_FACT,
  preserveAccountingFixturePrimary,
  WORKING_FACT,
} from './fixtures/final-prompt-accounting-host.js';

const fetch = vi.fn(async () => {
  throw new Error('Final-prompt qualification makes no provider requests');
});
beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const Accounting = z.object({
  measurement: z.record(z.string(), z.json()),
  promptTokens: z.number().nonnegative(),
  removedMessages: z.number().nonnegative(),
  toolTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  usedBackstop: z.boolean(),
});
type Request = Parameters<StateStoreHostMemoryOptions['recordPrompt']>[1];

function accounting(rows: readonly HostLogRow[], runId: string) {
  const event = rows.findLast(
    (row) => row.event.type === 'provider.request.prepared' && row.event.runId === runId
  )?.event;
  if (event?.type !== 'provider.request.prepared') {
    throw new Error('The canonical writer did not publish final-prompt accounting');
  }
  return Accounting.parse(event.accounting);
}

async function recount(
  request: Request,
  model: Awaited<ReturnType<typeof finalPromptAccountingHost>>['model']
) {
  // The existing dual provider declaration pins use the same public V4 DTO.
  // Recount the actual final SDK call through the shipped canonical primitive;
  // this asserts request/receipt correspondence, not provider-exact token truth.
  return (
    await prepareProviderRequest(
      request as unknown as Parameters<typeof prepareProviderRequest>[0],
      model as unknown as Parameters<typeof prepareProviderRequest>[1],
      { provider: 'openai', runtimeData: { model: model.modelId } }
    )
  ).accounting;
}

function withoutSystemFact(request: Request, fact: string): Request {
  return {
    ...request,
    prompt: request.prompt.map((message) =>
      message.role === 'system'
        ? { ...message, content: message.content.replace(fact, '') }
        : message
    ),
  };
}

test('actual production final-prompt accounting includes public observations and working memory without counting observer usage as chat', async () => {
  const f = await finalPromptAccountingHost('observations');
  await f.within(async () => {
    const { threadId } = await f.startThread();
    await f.run(threadId, 'Paris coding source facts. '.repeat(100));
    f.enableObservations();
    const result = await f.run(threadId, 'Use the preserved Paris coding decision.');
    const request = f.model.doStreamCalls.at(-1);
    if (!request) {
      throw new Error('The real SDK root model received no final request');
    }
    const system = request.prompt
      .flatMap((message) => (message.role === 'system' ? [message.content] : []))
      .join('\n');
    expect(system).toContain(WORKING_FACT);
    expect(system).toContain(OBSERVATION_FACT);
    expect(f.receipts.at(-1)?.request).toEqual(request);
    expect(f.receipts.at(-1)?.runId).toBe(result.runId);
    const committed = accounting(result.rows, result.runId);
    expect(committed).toEqual(await recount(request, f.model));
    expect(committed.promptTokens).toBeGreaterThan(
      (await recount(withoutSystemFact(request, WORKING_FACT), f.model)).promptTokens
    );
    expect(committed.promptTokens).toBeGreaterThan(
      (await recount(withoutSystemFact(request, OBSERVATION_FACT), f.model)).promptTokens
    );
    expect(f.observer.doStreamCalls.length).toBeGreaterThan(0);
    expect(f.observer.doStreamCalls[0]?.prompt.some((message) => message.role === 'system')).toBe(
      true
    );
    const usage = result.rows.filter(
      (row) => row.event.type === 'memory.usage' && row.event.runId === result.runId
    );
    expect(usage.length).toBeGreaterThan(0);
    expect(
      usage.every(
        (row) =>
          row.event.type === 'memory.usage' && row.event.modelId === ACCOUNTING_OBSERVER_CATALOG_ID
      )
    ).toBe(true);
    expect(usage.map((row) => row.event)).toContainEqual(
      expect.objectContaining({
        kind: 'observation',
        usage: expect.objectContaining({ inputTokens: 42, outputTokens: 9 }),
      })
    );
    const step = result.rows.findLast(
      (row) => row.event.type === 'model.step' && row.event.runId === result.runId
    )?.event;
    expect(step).toMatchObject({ usage: { inputTokens: 73, outputTokens: 11 } });
    expect(
      JSON.stringify(result.rows.filter((row) => row.event.type === 'model.step'))
    ).not.toContain(OBSERVATION_FACT);
    const snapshot = await f.store().memory({ operation: 'read', resourceId: f.resourceId });
    expect(JSON.stringify(snapshot)).toContain(OBSERVATION_FACT);
    const thread = snapshot.entities.find(
      (entity) => entity.kind === 'thread' && entity.threadId === threadId
    );
    expect(
      z.object({ metadata: z.object({ workingMemory: z.string() }) }).parse(thread?.payload)
        .metadata.workingMemory
    ).toBe(WORKING_FACT);
    expect(await f.store().check()).toEqual({ gaps: 0, integrity: 'ok' });
    console.error(
      'Production final-prompt accounting receipt:',
      JSON.stringify({
        accounting: committed,
        mode: 'observations',
        observerCalls: f.observer.doStreamCalls.length,
        observerUsage: usage.map((row) => row.event),
        promptSha256: createHash('sha256').update(JSON.stringify(request.prompt)).digest('hex'),
        root: f.root,
        rootReportedUsage: step?.type === 'model.step' ? step.usage : null,
        runId: result.runId,
        threadId,
      })
    );
  });
});

test('actual production final-prompt accounting includes a real SQLite cross-thread recall beyond the native history window', async () => {
  const f = await finalPromptAccountingHost('recall');
  await f.within(async () => {
    const source = await f.startThread();
    const before = await f.run(source.threadId, HISTORY_FACT);
    const target = await f.startThread();
    const result = await f.run(target.threadId, 'Recall the Paris committed source.');
    const request = f.model.doStreamCalls.at(-1);
    if (!request) {
      throw new Error('The real SDK root model received no recall request');
    }
    expect(JSON.stringify(request.prompt)).toContain(HISTORY_FACT);
    expect(
      request.prompt.some(
        (message) => message.role === 'system' && message.content.includes(WORKING_FACT)
      )
    ).toBe(true);
    expect(f.queries.length).toBeGreaterThan(0);
    expect(f.embeddingCalls.length).toBeGreaterThan(0);
    expect(f.receipts.at(-1)?.request).toEqual(request);
    const committed = accounting(result.rows, result.runId);
    expect(committed).toEqual(await recount(request, f.model));
    const currentUserIndex = request.prompt.findLastIndex((message) => message.role === 'user');
    expect(JSON.stringify(request.prompt[currentUserIndex])).toContain(
      'Recall the Paris committed source.'
    );
    const withoutRecalledHistory = {
      ...request,
      // Retire the entire recalled turn group so an associated assistant reply
      // cannot become an orphan prefix in this counterfactual provider request.
      prompt: request.prompt.filter(
        (message, index) => message.role === 'system' || index >= currentUserIndex
      ),
    };
    expect(committed.promptTokens).toBeGreaterThan(
      (await recount(withoutRecalledHistory, f.model)).promptTokens
    );
    const stored = await f.store().read(source.threadId, 0);
    expect(stored.length).toBe(before.rows.length);
    expect(await f.store().check()).toEqual({ gaps: 0, integrity: 'ok' });
    console.error(
      'Production final-prompt accounting receipt:',
      JSON.stringify({
        accounting: committed,
        embeddingCalls: f.embeddingCalls,
        mode: 'recall',
        promptSha256: createHash('sha256').update(JSON.stringify(request.prompt)).digest('hex'),
        queries: f.queries,
        root: f.root,
        runId: result.runId,
        sourceThreadId: source.threadId,
        threadId: target.threadId,
      })
    );
  });
});

test('actual production accounting measures the final native token-limited input while preserving committed history', async () => {
  const f = await finalPromptAccountingHost('observations');
  await f.within(async () => {
    const { threadId } = await f.startThread();
    const oldContext = 'Paris old selected context. '.repeat(1000);
    const before = await f.run(threadId, oldContext);
    // The preceding Memory-inclusive request measured 548 reference tokens.
    // This fixture budget leaves the current turn and protected system intact
    // while requiring the shipped contiguous limiter to retire old history.
    f.setInputTokenLimit(1000);
    const result = await f.run(threadId, 'Keep the current Paris turn.');
    const request = f.model.doStreamCalls.at(-1);
    if (!request) {
      throw new Error('The real SDK root model received no token-limited request');
    }
    expect(
      request.prompt.some(
        (message) => message.role === 'system' && message.content.includes(WORKING_FACT)
      )
    ).toBe(true);
    expect(JSON.stringify(request.prompt)).not.toContain(oldContext);
    expect(JSON.stringify(request.prompt)).toContain('Keep the current Paris turn.');
    expect(f.receipts.at(-1)?.request).toEqual(request);
    const committed = accounting(result.rows, result.runId);
    const measured = await recount(request, f.model);
    expect(committed).toEqual({ ...measured, removedMessages: committed.removedMessages });
    expect(committed.removedMessages).toBeGreaterThan(0);
    expect(committed.totalTokens).toBeLessThanOrEqual(1000);
    expect(result.rows.slice(0, before.rows.length)).toEqual(before.rows);
    expect(await f.store().check()).toEqual({ gaps: 0, integrity: 'ok' });
    console.error(
      'Production final-prompt accounting receipt:',
      JSON.stringify({
        accounting: committed,
        committedPrefixRows: before.rows.length,
        mode: 'native-token-limiter',
        promptSha256: createHash('sha256').update(JSON.stringify(request.prompt)).digest('hex'),
        root: f.root,
        runId: result.runId,
        threadId,
      })
    );
  });
});

test('fixture preserves an injected original primary and all separate nested cleanup causes', async () => {
  const primary = new Error('Injected primary');
  const leaf = new Error('Injected cleanup leaf', { cause: primary });
  const sibling = new Error('Injected independent cleanup sibling');
  const cleanup = new AggregateError(
    [leaf, new AggregateError([sibling, leaf], 'nested cleanup')],
    'outer cleanup'
  );
  const oldFinally = async () => {
    try {
      await Promise.reject(primary);
    } finally {
      await Promise.reject(cleanup);
    }
  };
  await expect(oldFinally()).rejects.toBe(cleanup);
  const diagnostics = new AccountingFixtureDiagnostics();
  diagnostics.identities.push((cause) => ({
    isOriginalLeaf: cause === leaf,
    isOriginalPrimary: cause === primary,
    isOriginalSibling: cause === sibling,
  }));
  await expect(
    preserveAccountingFixturePrimary(
      () => Promise.reject(primary),
      () => Promise.reject(cleanup),
      diagnostics
    )
  ).rejects.toBe(primary);
  expect(diagnostics.originalFailures).toEqual([
    { cause: primary, owner: 'test', phase: 'primary' },
    { cause: cleanup, owner: 'test', phase: 'cleanup' },
  ]);
  expect(diagnostics.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        identities: [expect.objectContaining({ isOriginalPrimary: true })],
      }),
      expect.objectContaining({ identities: [expect.objectContaining({ isOriginalLeaf: true })] }),
      expect.objectContaining({
        identities: [expect.objectContaining({ isOriginalSibling: true })],
      }),
    ])
  );
  console.error('Accounting injected-primary receipt:', JSON.stringify(diagnostics.snapshot()));
});

test('captures original polling failure at the real production Memory checkpoint with actual indexer joins', async () => {
  const f = await finalPromptAccountingHost('recall', {
    interruptBeforeCommit: true,
    retainRoot: true,
  });
  const { threadId } = await f.startThread();
  let primary: unknown;
  try {
    await f.within(() => f.runWithOriginalPolling(threadId, HISTORY_FACT));
  } catch (cause) {
    primary = cause;
  }
  expect(primary).toBeInstanceOf(Error);
  const original = f.diagnostics.originalFailures.find((failure) => failure.phase === 'primary');
  expect(original?.cause).toBe(primary);
  expect(f.diagnostics.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: 'Matcher did not succeed in time.' }),
      expect.objectContaining({
        identities: [
          expect.objectContaining({ equalsRunAbort: true, ownedMemoryCancellation: false }),
        ],
        message: 'Host is closing',
      }),
    ])
  );
  const abort = f.diagnostics.originalFailures.find((failure) => failure.owner === 'run.signal');
  const checkpointFailure = f.diagnostics.originalFailures.find(
    (failure) => failure.owner === 'run.checkpoint'
  );
  expect(checkpointFailure?.cause).toBe(abort?.cause);
  expect(
    f.diagnostics.originalFailures.some(
      (failure) => failure.owner === 'test' && failure.phase === 'cleanup'
    )
  ).toBe(true);
  expect(f.diagnostics.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ owner: 'run.checkpoint', phase: 'started' }),
      expect.objectContaining({ owner: 'public-memory.close', phase: 'fulfilled' }),
      expect.objectContaining({ owner: 'run.owner.close', phase: 'fulfilled' }),
      expect.objectContaining({ owner: 'indexer.close', phase: 'fulfilled' }),
      expect.objectContaining({
        detail: expect.objectContaining({ code: 0, ipcDisconnected: true }),
        owner: 'indexer.process',
        phase: 'transport-joined',
      }),
    ])
  );
  expect(
    f.diagnostics.events.some(
      (event) => event.owner === 'state-store.close' && event.phase === 'started'
    )
  ).toBe(true);
  const indexerJoined = f.diagnostics.events.findIndex(
    (event) => event.owner === 'indexer.close' && event.phase === 'fulfilled'
  );
  const writerClosing = f.diagnostics.events.findIndex(
    (event) => event.owner === 'state-store.close' && event.phase === 'started'
  );
  const writerExited = f.diagnostics.events.findIndex(
    (event) => event.owner === 'state-store.writer' && event.phase === 'exit'
  );
  const writerJoined = f.diagnostics.events.findIndex(
    (event) => event.owner === 'state-store.close' && event.phase === 'fulfilled'
  );
  expect(indexerJoined).toBeGreaterThan(-1);
  expect(writerClosing).toBeGreaterThan(indexerJoined);
  expect(writerExited).toBeGreaterThan(writerClosing);
  expect(writerJoined).toBeGreaterThan(writerExited);
  expect(f.diagnostics.events).toContainEqual(
    expect.objectContaining({
      detail: expect.objectContaining({
        released: true,
        writer: expect.objectContaining({ currentThreadId: -1 }),
      }),
      owner: 'root',
      phase: 'close-state',
    })
  );
  expect(RootLock.inspect(f.root)?.owner.released).toBe(true);
});
