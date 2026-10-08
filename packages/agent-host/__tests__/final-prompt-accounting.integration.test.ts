import { createHash } from 'node:crypto';
import { prepareProviderRequest } from '@brainstrike/agent/provider-request';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { StateStoreHostMemoryOptions } from '../src/adapters/state-store-host-memory.js';
import type { HostLogRow } from '../src/protocol.js';
import {
  finalPromptAccountingHost,
  HISTORY_FACT,
  OBSERVATION_FACT,
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
  try {
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
        (row) => row.event.type === 'memory.usage' && row.event.modelId === f.observer.modelId
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
  } finally {
    await f.close();
  }
});

test('actual production final-prompt accounting includes a real SQLite cross-thread recall beyond the native history window', async () => {
  const f = await finalPromptAccountingHost('recall');
  try {
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
  } finally {
    await f.close();
  }
});

test('actual production accounting measures the final native token-limited input while preserving committed history', async () => {
  const f = await finalPromptAccountingHost('observations');
  try {
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
  } finally {
    await f.close();
  }
});
