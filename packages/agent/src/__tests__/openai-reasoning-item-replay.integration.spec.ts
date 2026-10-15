/**
 * OpenAI Responses item-reference uniqueness proofs (BST-1095, real
 * @mastra/core/agent + real PGlite).
 *
 * The OpenAI Responses API rejects a request whose `input` contains two items
 * with the same id ("Duplicate item found with id rs_..."). The AI SDK's
 * `convertToOpenAIResponsesMessages` merges reasoning parts that share an
 * `openai.itemId` ONLY within a single assistant message — the same itemId
 * appearing across TWO messages of one prompt is emitted twice and the whole
 * run 400s.
 *
 * Two suites drive the REAL Mastra agent loop (scripted fake model, real
 * PGlite memory) and assert the invariant directly on every prompt the model
 * receives — no OpenAI item reference spans more than one prompt message:
 * - a seeded thread mirroring the captured production corruption (the same
 *   assistant response persisted twice after Mastra's sealed-boundary re-key;
 *   debug bundle 2026-08-02, run-d1d5) — the case `OpenAIDuplicateItemCompat`
 *   exists to canonicalize;
 * - reasoning-item replay through the Mastra-native approval suspend/resume
 *   path (including a failed-then-reapproved execution and Observational
 *   Memory active mid-run), guarding the healthy paths against regressions.
 */
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import type { PGlite } from '@electric-sql/pglite';
import type { MastraDBMessage } from '@mastra/core/memory';
import { createTool } from '@mastra/core/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PgliteDatabase, PgliteMastraMemoryOptions } from '../pglite-mastra-memory';
import type { StreamChunk } from '../types';
import { createPristineBareTestDb } from './helpers/migrated-agent-test-db';

const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as LanguageModelV2 | undefined },
}));

vi.mock('../providers/provider-factory', async (importActual) => {
  const actual = await importActual<typeof import('../providers/provider-factory')>();
  return {
    ...actual,
    createProvider: () => {
      if (!modelHolder.current) {
        throw new Error('test fake model was not configured');
      }
      return modelHolder.current;
    },
    getDefaultModel: (provider: string) =>
      ({
        anthropic: 'claude-sonnet-5',
        google: 'gemini-3.5-flash',
        local: 'onnx-community/gemma-4-E2B-it-ONNX',
        openrouter: 'openai/gpt-5.6-terra',
      })[provider] ?? 'gpt-5.6-terra',
  };
});

const { streamMastraAgent, streamMastraToolApprovalAction } = await import(
  '../mastra/agent-streaming'
);
const { createPgliteMastraMemory } = await import('../pglite-mastra-memory');

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

const ASK_POLICY = {
  policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
  riskByTool: { grep_tool: 'read', shell_tool: 'execute' },
  yolo: false,
} as const;

function makeAskTool(args?: { failFirstExecution?: boolean }) {
  let executions = 0;
  return createTool({
    description: 'An execute-risk tool gated to ask.',
    execute: (inputData: { command: string }) => {
      executions += 1;
      if (args?.failFirstExecution && executions === 1) {
        return Promise.reject(new Error('Tool execution failed'));
      }
      return Promise.resolve({ ran: inputData.command });
    },
    id: 'shell_tool',
    inputSchema: z.object({ command: z.string() }),
    outputSchema: z.object({ ran: z.string() }),
  });
}

function makeGrepTool() {
  return createTool({
    description: 'A read-risk tool that runs without approval.',
    execute: () => Promise.resolve({ files: ['a.ts'] }),
    id: 'grep_tool',
    inputSchema: z.object({ pattern: z.string() }),
    outputSchema: z.object({ files: z.array(z.string()) }),
  });
}

async function makeMemory(database: PGlite) {
  const options: PgliteMastraMemoryOptions = {
    database: database as unknown as PgliteDatabase,
  };
  return await createPgliteMastraMemory(options);
}

/** Scripted observer model for Observational Memory cycles. */
function createObserverModel(): LanguageModelV2 {
  const observationText = '* 🔴 (12:00) User is editing the workspace file.';
  return {
    doGenerate: () =>
      Promise.resolve({
        content: [{ text: observationText, type: 'text' as const }],
        finishReason: 'stop' as const,
        usage: USAGE,
        warnings: [],
      }),
    doStream: () =>
      Promise.resolve({
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ id: 'obs-text', type: 'text-start' });
            controller.enqueue({ delta: observationText, id: 'obs-text', type: 'text-delta' });
            controller.enqueue({ id: 'obs-text', type: 'text-end' });
            controller.enqueue({ finishReason: 'stop', type: 'finish', usage: USAGE });
            controller.close();
          },
        }),
      }),
    modelId: 'fake-observer',
    provider: 'fake',
    specificationVersion: 'v2',
    supportedUrls: {},
  };
}

/** OM enabled at a tiny observation threshold so window management runs mid-run. */
async function makeObservationalMemory(database: PGlite) {
  const options: PgliteMastraMemoryOptions = {
    database: database as unknown as PgliteDatabase,
    memorySettings: {
      observationalMemory: {
        enabled: true,
        messageTokens: 50,
        modelTarget: 'fake/fake-observer',
        observationTokens: 40_000,
        retrievalMode: 'off',
        scope: 'thread',
      },
      semanticRecall: {
        embeddingModelTarget: null,
        enabled: false,
        messageRange: 2,
        scope: 'resource',
        topK: 5,
      },
    },
    observationalMemoryModel: createObserverModel(),
  };
  return await createPgliteMastraMemory(options);
}

async function drainYielding(iterator: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterator) {
    chunks.push(chunk);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
  return chunks;
}

function findApprovalChunk(chunks: StreamChunk[]) {
  return chunks.find(
    (chunk): chunk is Extract<StreamChunk, { type: 'tool-approval-required' }> =>
      chunk.type === 'tool-approval-required'
  );
}

/**
 * Emits an OpenAI-shaped reasoning item: `reasoning-start` carries
 * `openai.itemId` + `reasoningEncryptedContent` (matching
 * `@ai-sdk/openai`'s Responses stream mapping), the summary text arrives as a
 * delta, and `reasoning-end` repeats the itemId.
 */
function reasoningItem(itemId: string, summary: string): LanguageModelV2StreamPart[] {
  const id = `${itemId}:0`;
  const openai = { itemId, reasoningEncryptedContent: `enc-${itemId}` };
  return [
    { id, providerMetadata: { openai }, type: 'reasoning-start' },
    { delta: summary, id, providerMetadata: { openai: { itemId } }, type: 'reasoning-delta' },
    { id, providerMetadata: { openai: { itemId } }, type: 'reasoning-end' },
  ];
}

function createReasoningRunModel(
  capturedPrompts: LanguageModelV2Prompt[],
  { retryAskAfterFailure = false }: { retryAskAfterFailure?: boolean } = {}
): LanguageModelV2 {
  let turn = 0;
  const enqueue = (parts: LanguageModelV2StreamPart[]) =>
    new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      },
    });

  return {
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: (options: LanguageModelV2CallOptions) => {
      capturedPrompts.push(structuredClone(options.prompt));
      turn += 1;
      // Two read steps BEFORE the approval suspend, mirroring the captured
      // production run (several readWorkspaceFile steps, then the gated edit).
      if (turn === 1 || turn === 2) {
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            ...reasoningItem(`rs-pre-read-${turn}`, `Reading the file, pass ${turn}.`),
            {
              input: JSON.stringify({ pattern: `pass-${turn}` }),
              toolCallId: `call-pre-grep-${turn}`,
              toolName: 'grep_tool',
              type: 'tool-call',
            },
            { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
          ]),
        });
      }
      if (turn === 3) {
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            ...reasoningItem('rs-approval-turn', 'Deciding to edit the file.'),
            {
              input: JSON.stringify({ command: 'apply edit' }),
              toolCallId: 'call-ask-1',
              toolName: 'shell_tool',
              type: 'tool-call',
            },
            { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
          ]),
        });
      }
      if (turn === 4 && retryAskAfterFailure) {
        // The approved edit failed — retry the same gated tool (mirrors the
        // captured production session: failed tool action, then re-approval).
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            ...reasoningItem('rs-retry-edit', 'Retrying the edit.'),
            {
              input: JSON.stringify({ command: 'apply edit again' }),
              toolCallId: 'call-ask-2',
              toolName: 'shell_tool',
              type: 'tool-call',
            },
            { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
          ]),
        });
      }
      if ((turn === 4 && !retryAskAfterFailure) || (turn === 5 && retryAskAfterFailure)) {
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            ...reasoningItem('rs-post-approval', 'Checking the result.'),
            {
              input: JSON.stringify({ pattern: 'hero' }),
              toolCallId: 'call-grep-1',
              toolName: 'grep_tool',
              type: 'tool-call',
            },
            { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
          ]),
        });
      }
      if ((turn === 5 && !retryAskAfterFailure) || (turn === 6 && retryAskAfterFailure)) {
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            ...reasoningItem('rs-second-read', 'One more read.'),
            {
              input: JSON.stringify({ pattern: 'impact' }),
              toolCallId: 'call-grep-2',
              toolName: 'grep_tool',
              type: 'tool-call',
            },
            { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
          ]),
        });
      }
      const id = 'text-final';
      return Promise.resolve({
        stream: enqueue([
          { type: 'stream-start', warnings: [] },
          ...reasoningItem('rs-final', 'Wrapping up.'),
          { id, type: 'text-start' },
          { delta: 'Done.', id, type: 'text-delta' },
          { id, type: 'text-end' },
          { finishReason: 'stop', type: 'finish', usage: USAGE },
        ]),
      });
    },
    modelId: 'fake-model',
    provider: 'fake',
    specificationVersion: 'v2',
    supportedUrls: {},
  };
}

/**
 * A model that reads once then answers, capturing every prompt. Used for the
 * seeded double-persistence scenario where the interesting content is already
 * in memory.
 */
function createReadThenAnswerModel(capturedPrompts: LanguageModelV2Prompt[]): LanguageModelV2 {
  let turn = 0;
  const enqueue = (parts: LanguageModelV2StreamPart[]) =>
    new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      },
    });
  return {
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: (options: LanguageModelV2CallOptions) => {
      capturedPrompts.push(structuredClone(options.prompt));
      turn += 1;
      if (turn === 1) {
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            ...reasoningItem('rs-live-read', 'Checking the file first.'),
            {
              input: JSON.stringify({ pattern: 'hero' }),
              toolCallId: 'call-live-grep',
              toolName: 'grep_tool',
              type: 'tool-call',
            },
            { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
          ]),
        });
      }
      const id = 'text-final';
      return Promise.resolve({
        stream: enqueue([
          { type: 'stream-start', warnings: [] },
          { id, type: 'text-start' },
          { delta: 'Done.', id, type: 'text-delta' },
          { id, type: 'text-end' },
          { finishReason: 'stop', type: 'finish', usage: USAGE },
        ]),
      });
    },
    modelId: 'fake-model',
    provider: 'fake',
    specificationVersion: 'v2',
    supportedUrls: {},
  };
}

// Mirrors the production reader in openai-duplicate-item-compat.ts: check
// `providerOptions` THEN `providerMetadata`, so a hydration change that moves
// the carrier cannot silently empty the spread and let the guard pass
// vacuously.
function readOpenAIItemId(part: object): string | undefined {
  for (const carrier of ['providerOptions', 'providerMetadata'] as const) {
    const options = (part as Record<string, unknown>)[carrier];
    if (!(options && typeof options === 'object')) {
      continue;
    }
    const openai = (options as Record<string, unknown>)['openai'];
    if (!(openai && typeof openai === 'object')) {
      continue;
    }
    const itemId = (openai as Record<string, unknown>)['itemId'];
    if (typeof itemId === 'string' && itemId.length > 0) {
      return itemId;
    }
  }
  return;
}

/**
 * Maps each OpenAI Responses item reference to the set of message indexes
 * carrying it. Two keys spaces are tracked, mirroring what the provider
 * serializes as `input` items:
 * - `item:<id>` — `providerOptions.openai.itemId` on reasoning/text/tool-call
 *   parts of ASSISTANT messages (rs_/msg_/fc_ items).
 * - `call:<role>:<id>` — `toolCallId` on assistant `tool-call` parts and tool
 *   `tool-result` parts (function_call / function_call_output items). The call
 *   and its output legitimately share an id ACROSS roles, so the role is part
 *   of the key.
 * The same key spanning two messages serializes as two provider items with one
 * id — exactly what OpenAI rejects with "Duplicate item found".
 */
function providerItemSpread(prompt: LanguageModelV2Prompt): Map<string, Set<number>> {
  const spread = new Map<string, Set<number>>();
  const record = (key: string, messageIndex: number) => {
    const indexes = spread.get(key) ?? new Set<number>();
    indexes.add(messageIndex);
    spread.set(key, indexes);
  };
  prompt.forEach((message, messageIndex) => {
    if (message.role !== 'assistant' && message.role !== 'tool') {
      return;
    }
    for (const part of message.content) {
      if (message.role === 'assistant') {
        const itemId = readOpenAIItemId(part);
        if (itemId) {
          record(`item:${itemId}`, messageIndex);
        }
        if (part.type === 'tool-call') {
          record(`call:assistant:${part.toolCallId}`, messageIndex);
        }
      } else if (part.type === 'tool-result') {
        record(`call:tool:${part.toolCallId}`, messageIndex);
      }
    }
  });
  return spread;
}

async function runApprovalScenario(args: {
  memory: Awaited<ReturnType<typeof makeMemory>>['memory'];
  storage: Awaited<ReturnType<typeof makeMemory>>['storage'];
  thread: { readonly resourceId: string; readonly threadId: string };
  failFirstApprovedExecution?: boolean;
}): Promise<LanguageModelV2Prompt[]> {
  const capturedPrompts: LanguageModelV2Prompt[] = [];
  const retryAskAfterFailure = args.failFirstApprovedExecution === true;
  modelHolder.current = createReasoningRunModel(capturedPrompts, { retryAskAfterFailure });

  const runtime = {
    apiKey: 'test-key',
    memory: { resourceId: args.thread.resourceId, threadId: args.thread.threadId },
    permissionPolicy: ASK_POLICY,
    provider: 'openai',
  } as const;
  const tools = {
    grep_tool: makeGrepTool(),
    shell_tool: makeAskTool({ failFirstExecution: retryAskAfterFailure }),
  };

  const suspendIterator = await streamMastraAgent(
    [{ id: 'u-reasoning-1', parts: [{ text: 'edit then verify', type: 'text' }], role: 'user' }],
    { memory: args.memory, runtime, storage: args.storage, tools }
  );
  const approval = findApprovalChunk(await drainYielding(suspendIterator));
  expect(approval).toBeDefined();

  const resumeIterator = await streamMastraToolApprovalAction(
    {
      action: 'approve',
      runId: approval?.runId ?? '',
      toolCallId: approval?.toolCallId ?? '',
      toolName: 'shell_tool',
    },
    { memory: args.memory, requireToolApproval: true, runtime, storage: args.storage, tools }
  );
  let resumeChunks = await drainYielding(resumeIterator);

  // When the approved execution failed, the model retries the gated tool and a
  // SECOND approval round-trip happens before the run can finish.
  const secondApproval = findApprovalChunk(resumeChunks);
  if (secondApproval) {
    const secondResume = await streamMastraToolApprovalAction(
      {
        action: 'approve',
        runId: secondApproval.runId,
        toolCallId: secondApproval.toolCallId,
        toolName: 'shell_tool',
      },
      { memory: args.memory, requireToolApproval: true, runtime, storage: args.storage, tools }
    );
    resumeChunks = await drainYielding(secondResume);
  } else {
    expect(retryAskAfterFailure).toBe(false);
  }

  expect(
    resumeChunks.some((chunk) => chunk.type === 'text-delta' && chunk.value.includes('Done.'))
  ).toBe(true);
  return capturedPrompts;
}

function expectNoCrossMessageReasoningReplay(capturedPrompts: LanguageModelV2Prompt[]): void {
  for (const [promptIndex, prompt] of capturedPrompts.entries()) {
    for (const [key, messageIndexes] of providerItemSpread(prompt)) {
      expect
        .soft(
          messageIndexes.size,
          `provider item ${key} appears in ${messageIndexes.size} messages ` +
            `of prompt ${promptIndex} (message indexes: ${[...messageIndexes].join(', ')})`
        )
        .toBe(1);
    }
  }
}

describe('double-persisted assistant history (BST-1095, real agent loop + real PGlite)', () => {
  beforeEach(() => {
    modelHolder.current = undefined;
  });

  /**
   * Mirrors the captured production corruption (debug bundle 2026-08-02,
   * thread-5effa56d…): Mastra's sealed-boundary re-key left the SAME assistant
   * response persisted twice — a stale partial snapshot under the client short
   * id and a full copy under a UUID, `createdAt` exactly +1ms, sharing every
   * OpenAI item id (`rs_`/`fc_`/`call_`). Every later prompt that includes
   * both rows serializes duplicate provider items and OpenAI 400s with
   * "Duplicate item found with id rs_…".
   */
  it('sends each OpenAI item reference at most once even when history holds a re-keyed duplicate', async () => {
    const database = await createPristineBareTestDb();
    const { memory, storage } = await makeMemory(database);
    const threadId = 'thread-dup-history';
    const resourceId = 'resource-dup-history';
    const staleCreatedAt = new Date('2026-08-02T16:17:40.038Z');

    await memory.saveThread({
      thread: {
        createdAt: staleCreatedAt,
        id: threadId,
        resourceId,
        title: 'Double-persisted history',
        updatedAt: staleCreatedAt,
      },
    });

    const duplicatedParts = [
      {
        details: [{ text: '', type: 'text' as const }],
        providerMetadata: {
          openai: {
            itemId: 'rs-duplicated-empty',
            reasoningEncryptedContent: 'enc-rs-duplicated-empty',
          },
        },
        reasoning: '',
        type: 'reasoning' as const,
      },
      {
        details: [{ text: 'Deciding what to change.', type: 'text' as const }],
        providerMetadata: {
          openai: {
            itemId: 'rs-duplicated-summary',
            reasoningEncryptedContent: 'enc-rs-duplicated-summary',
          },
        },
        reasoning: 'Deciding what to change.',
        type: 'reasoning' as const,
      },
      {
        toolInvocation: {
          args: { pattern: 'hero' },
          result: { files: ['index.html'] },
          state: 'result' as const,
          toolCallId: 'call-duplicated-read',
          toolName: 'grep_tool',
        },
        type: 'tool-invocation' as const,
      },
    ];
    const staleSnapshot: MastraDBMessage = {
      content: { format: 2, parts: duplicatedParts },
      createdAt: staleCreatedAt,
      id: 'aXIyBw2-stale',
      resourceId,
      role: 'assistant',
      threadId,
      type: 'text',
    };
    const rekeyedFullCopy: MastraDBMessage = {
      content: {
        format: 2,
        parts: [...duplicatedParts, { text: 'Applied the change.', type: 'text' as const }],
      },
      createdAt: new Date(staleCreatedAt.getTime() + 1),
      id: 'b1b97418-95e5-4c49-bc8b-528616baa73b',
      resourceId,
      role: 'assistant',
      threadId,
      type: 'text',
    };
    await memory.saveMessages({
      messages: [
        {
          content: {
            format: 2,
            parts: [{ text: 'do some more exciting enhancements', type: 'text' as const }],
          },
          createdAt: new Date(staleCreatedAt.getTime() - 2000),
          id: 'u-dup-1',
          resourceId,
          role: 'user',
          threadId,
          type: 'text',
        },
        staleSnapshot,
        rekeyedFullCopy,
      ],
    });

    const capturedPrompts: LanguageModelV2Prompt[] = [];
    modelHolder.current = createReadThenAnswerModel(capturedPrompts);
    const iterator = await streamMastraAgent(
      [{ id: 'u-dup-2', parts: [{ text: 'now verify the result', type: 'text' }], role: 'user' }],
      {
        memory,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId, threadId },
          permissionPolicy: ASK_POLICY,
          provider: 'openai',
        },
        storage,
        tools: { grep_tool: makeGrepTool() },
      }
    );
    const chunks = await drainYielding(iterator);
    expect(
      chunks.some((chunk) => chunk.type === 'text-delta' && chunk.value.includes('Done.'))
    ).toBe(true);

    expect(capturedPrompts.length).toBeGreaterThanOrEqual(2);
    // Guard against a vacuous pass: the seeded references must actually reach
    // the model boundary before "each spans one message" means anything.
    const observedKeys = new Set(
      capturedPrompts.flatMap((prompt) => [...providerItemSpread(prompt).keys()])
    );
    expect(observedKeys).toContain('item:rs-duplicated-summary');
    expect(observedKeys).toContain('call:assistant:call-duplicated-read');
    // Both persisted copies are in the window; without canonicalization the
    // prompt carries rs-duplicated-empty / rs-duplicated-summary /
    // call-duplicated-read twice and OpenAI rejects the request.
    expectNoCrossMessageReasoningReplay(capturedPrompts);

    await database.close();
  }, 120_000);
});

describe('OpenAI reasoning-item replay across approval resume (real agent loop + real PGlite)', () => {
  beforeEach(() => {
    modelHolder.current = undefined;
  });

  it('never replays one reasoning itemId in more than one assistant message of a prompt', async () => {
    const database = await createPristineBareTestDb();
    const { memory, storage } = await makeMemory(database);
    const thread = {
      resourceId: 'resource-reasoning-replay-1',
      threadId: 'thread-reasoning-replay-1',
    } as const;
    const capturedPrompts = await runApprovalScenario({ memory, storage, thread });

    // The scripted model saw the pre-suspend steps plus every post-approval step.
    expect(capturedPrompts.length).toBeGreaterThanOrEqual(6);
    expectNoCrossMessageReasoningReplay(capturedPrompts);

    await database.close();
  }, 120_000);

  it('holds when the first approved execution fails and the tool is re-approved', async () => {
    const database = await createPristineBareTestDb();
    const { memory, storage } = await makeMemory(database);
    const thread = {
      resourceId: 'resource-reasoning-replay-retry',
      threadId: 'thread-reasoning-replay-retry',
    } as const;

    const capturedPrompts = await runApprovalScenario({
      failFirstApprovedExecution: true,
      memory,
      storage,
      thread,
    });

    expect(capturedPrompts.length).toBeGreaterThanOrEqual(7);
    expectNoCrossMessageReasoningReplay(capturedPrompts);

    await database.close();
  }, 120_000);

  it('holds with Observational Memory active mid-run (tiny observation threshold)', async () => {
    const database = await createPristineBareTestDb();
    const { memory, storage } = await makeObservationalMemory(database);
    const thread = {
      resourceId: 'brainstrike:workspace',
      threadId: 'thread-reasoning-replay-om',
    } as const;

    const capturedPrompts = await runApprovalScenario({ memory, storage, thread });

    expect(capturedPrompts.length).toBeGreaterThanOrEqual(6);
    expectNoCrossMessageReasoningReplay(capturedPrompts);

    await database.close();
  }, 120_000);
});
