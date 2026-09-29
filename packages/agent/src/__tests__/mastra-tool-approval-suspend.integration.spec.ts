/**
 * LIVE-loop proof for the per-call mutation approval flow (the core of the
 * "'ask' suspends for approval" PR).
 *
 * These drive the REAL Mastra agent loop (no agent mock — only the language
 * model is a scripted fake) with REAL PGlite-backed workflow storage. A tool the
 * permission gate resolves to `'ask'` must:
 *   - SUSPEND the run (emit `tool-approval-required`, execute NOT called), then
 *     via `streamMastraToolApprovalAction`:
 *       - approve → the tool EXECUTES and the run continues to a final answer,
 *       - decline → the tool is SKIPPED (never executes) and the run continues.
 *
 * This lives in its OWN file (not bundled with mastra-tool-execution.spec.ts) so
 * the heavy real-PGlite suspend/resume runs are isolated from the stall/timeout
 * tests in that file, which mutate `BRAINSTRIKE_*` env vars and add log
 * listeners — interleaving them in one module made the Mastra resume stall.
 */
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import { createTool } from '@mastra/core/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PgliteDatabase, PgliteMastraMemoryOptions } from '../pglite-mastra-memory';
import { AssistantDataStreamSession } from '../stream/data-stream';
import type { StreamChunk } from '../types';

// vi.mock factories are hoisted above imports, so the model the fake provider
// returns must live in a hoisted holder the factory can close over.
const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as LanguageModelV2 | undefined },
}));

// Replace ONLY model construction. Everything else (runtime resolution, the real
// Agent, the real tool loop, the real approval suspend/resume) runs unmocked.
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
const { listSuspendedMastraRuns } = await import('../mastra/suspended-run-discovery');
const { createPgliteMastraMemory } = await import('../pglite-mastra-memory');
const { LlmHostChatModel } = await import('../providers/local/llm-host-chat-model');
const { GEMMA4_E2B_MODEL_ID } = await import('../providers/local/local-model-specs');
// The DESKTOP initial-turn path: maps runtime.mastraTools -> options.tools. The
// regression test below uses it so the wiring matches production exactly.
const { toAiSdkStyleStream } = await import('../message-utils');

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

/**
 * A scripted model that emits a tool call for `toolName` on turn 1, then the
 * final text on every later turn. Turn-counting (not prompt inspection) makes
 * the resumed run terminate whether the tool was approved (executed) or declined
 * (skipped) — the model just answers on its next turn.
 */
function createTurnCountedToolCallModel(args: {
  toolName: string;
  toolCallId: string;
  input: string;
  finalText: string;
  stallAfterToolResultText?: string;
  openRouterStepCosts?: readonly [number, number];
  onTurn?: (turn: number, options: LanguageModelV2CallOptions) => void;
}): LanguageModelV2 {
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
      turn += 1;
      args.onTurn?.(turn, options);
      if (turn === 1) {
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            {
              input: args.input,
              toolCallId: args.toolCallId,
              toolName: args.toolName,
              type: 'tool-call',
            },
            {
              finishReason: 'tool-calls',
              ...(args.openRouterStepCosts
                ? {
                    providerMetadata: {
                      openrouter: { usage: { cost: args.openRouterStepCosts[0] } },
                    },
                  }
                : {}),
              type: 'finish',
              usage: USAGE,
            },
          ]),
        });
      }
      const stallAfterToolResultText = args.stallAfterToolResultText;
      if (stallAfterToolResultText) {
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV2StreamPart>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ id: 'text-incomplete', type: 'text-start' });
              controller.enqueue({
                delta: stallAfterToolResultText,
                id: 'text-incomplete',
                type: 'text-delta',
              });
            },
          }),
        });
      }
      const id = 'text-final';
      return Promise.resolve({
        stream: enqueue([
          { type: 'stream-start', warnings: [] },
          { id, type: 'text-start' },
          { delta: args.finalText, id, type: 'text-delta' },
          { id, type: 'text-end' },
          {
            finishReason: 'stop',
            ...(args.openRouterStepCosts
              ? {
                  providerMetadata: {
                    openrouter: { usage: { cost: args.openRouterStepCosts[1] } },
                  },
                }
              : {}),
            type: 'finish',
            usage: USAGE,
          },
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
 * Discovery-then-tool scripted model: turn 1 loads the deferred tool by exact
 * name via Mastra's `load_tool` meta-tool, turn 2 calls it, turn 3 emits final
 * text.
 */
function createDiscoveryThenToolApprovalModel(args: {
  deferredInput?: string;
  deferredToolCallId: string;
  deferredToolName: string;
  finalText: string;
}): LanguageModelV2 {
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
    doStream: () => {
      turn += 1;
      if (turn === 1) {
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            {
              input: JSON.stringify({ toolName: args.deferredToolName }),
              toolCallId: 'call-load-before-approval',
              toolName: 'load_tool',
              type: 'tool-call',
            },
            { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
          ]),
        });
      }
      if (turn === 2) {
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            {
              input: args.deferredInput ?? '{}',
              toolCallId: args.deferredToolCallId,
              toolName: args.deferredToolName,
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
          { delta: args.finalText, id, type: 'text-delta' },
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
 * A three-turn scripted model for resume-gate proofs:
 *   turn 1 (initial)          → call the ask tool (suspends for approval)
 *   turn 2 (resume continues) → call the configured follow-up tool
 *   turn 3                    → final text
 * The follow-up proves the run-wide resume flag still honors the rebuilt
 * runtime's per-tool permission decision.
 */
function createAskThenToolCallModel(args: {
  askToolName: string;
  askToolCallId: string;
  askInput: string;
  finalText: string;
  secondInput: string;
  secondToolCallId: string;
  secondToolName: string;
  thirdInput?: string;
  thirdToolCallId?: string;
  thirdToolName?: string;
}): LanguageModelV2 {
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
  const toolCall = (toolName: string, toolCallId: string, input: string) =>
    enqueue([
      { type: 'stream-start', warnings: [] },
      { input, toolCallId, toolName, type: 'tool-call' },
      { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
    ]);

  return {
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: () => {
      turn += 1;
      if (turn === 1) {
        return Promise.resolve({
          stream: toolCall(args.askToolName, args.askToolCallId, args.askInput),
        });
      }
      if (turn === 2) {
        return Promise.resolve({
          stream: toolCall(args.secondToolName, args.secondToolCallId, args.secondInput),
        });
      }
      if (turn === 3 && args.thirdInput && args.thirdToolCallId && args.thirdToolName) {
        return Promise.resolve({
          stream: toolCall(args.thirdToolName, args.thirdToolCallId, args.thirdInput),
        });
      }
      const id = 'text-final';
      return Promise.resolve({
        stream: enqueue([
          { type: 'stream-start', warnings: [] },
          { id, type: 'text-start' },
          { delta: args.finalText, id, type: 'text-delta' },
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
 * A scripted model that emits TWO tool calls in ONE step (turn 1), then final
 * text on every later turn. Two approval-gated calls in a single step is the
 * shape that decides whether approving one can silently answer the other.
 */
function createTwoToolCallModel(args: {
  calls: readonly { input: string; toolCallId: string }[];
  finalText: string;
  toolName: string;
}): LanguageModelV2 {
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
    doStream: () => {
      turn += 1;
      if (turn === 1) {
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            ...args.calls.map(
              (call): LanguageModelV2StreamPart => ({
                input: call.input,
                toolCallId: call.toolCallId,
                toolName: args.toolName,
                type: 'tool-call',
              })
            ),
            { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
          ]),
        });
      }
      const id = `text-final-${turn}`;
      return Promise.resolve({
        stream: enqueue([
          { type: 'stream-start', warnings: [] },
          { id, type: 'text-start' },
          { delta: args.finalText, id, type: 'text-delta' },
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

const ASK_POLICY = {
  policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
  riskByTool: { shell_tool: 'execute' },
  yolo: false,
} as const;

function makeAskTool(execute: (inputData: { command: string }) => Promise<{ ran: string }>) {
  return createTool({
    description: 'An execute-risk tool gated to ask.',
    execute,
    id: 'shell_tool',
    inputSchema: z.object({ command: z.string() }),
    outputSchema: z.object({ ran: z.string() }),
  });
}

function makeFailingAskTool(execute: (inputData: { command: string }) => Promise<never>) {
  return createTool({
    description: 'An execute-risk tool gated to ask that fails after approval.',
    execute,
    id: 'shell_tool',
    inputSchema: z.object({ command: z.string() }),
    outputSchema: z.object({ ran: z.string() }),
  });
}

function makeMemory(database: PGlite) {
  const options: PgliteMastraMemoryOptions = {
    database: database as unknown as PgliteDatabase,
  };
  return createPgliteMastraMemory(options);
}

function findApprovalChunk(chunks: StreamChunk[]) {
  return chunks.find(
    (chunk): chunk is Extract<StreamChunk, { type: 'tool-approval-required' }> =>
      chunk.type === 'tool-approval-required'
  );
}

/**
 * Drain an async chunk iterator into an array, yielding a macrotask after each
 * chunk. The scripted model delivers its stream synchronously, so without an
 * explicit yield the consumer loop can starve the event loop and the
 * PGlite-backed approval RESUME (whose snapshot restore is async) never gets a
 * turn — wedging the run in this synthetic harness. A real streaming provider
 * yields naturally over network I/O, so production never hits this. The
 * `setImmediate` yield mirrors that.
 */
async function drainYielding(
  iterator: AsyncIterable<StreamChunk>,
  onChunk?: (chunk: StreamChunk) => void
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterator) {
    chunks.push(chunk);
    onChunk?.(chunk);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
  return chunks;
}

async function encodeChunks(chunks: StreamChunk[]): Promise<string> {
  const session = new AssistantDataStreamSession(
    {
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
    },
    () => {},
    { messageId: 'resume-message', sessionId: 'resume-session' }
  );
  return await session.createResponse().text();
}

function readPersistedToolInvocationArgs(content: unknown, toolCallId: string): unknown {
  const parsed = typeof content === 'string' ? (JSON.parse(content) as unknown) : content;
  if (!(parsed && typeof parsed === 'object')) {
    return;
  }
  const parts = (parsed as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) {
    return;
  }
  for (const part of parts) {
    if (!(part && typeof part === 'object')) {
      continue;
    }
    const invocation = (part as { toolInvocation?: unknown }).toolInvocation;
    if (
      invocation &&
      typeof invocation === 'object' &&
      (invocation as { toolCallId?: unknown }).toolCallId === toolCallId
    ) {
      return (invocation as { args?: unknown }).args;
    }
  }
  return;
}

describe("'ask' suspends for approval and resumes (real @mastra/core/agent + real PGlite)", () => {
  beforeEach(() => {
    modelHolder.current = undefined;
  });

  /**
   * PAUSES ONE CALL AT A TIME — the producer shape that decides how the "needs
   * you" projection must express ordering (BST-1440 review).
   *
   * Mastra's `foreach(toolCallStep)` is SEQUENTIAL. With two approval-gated
   * calls in a single step it pauses on the FIRST alone; the second call's
   * `tool-call` part has already streamed, so the pausing leg emits
   * `tool.started` for BOTH, but only the first gets a
   * `tool.approval.requested`. Approving the first resumes, it executes, and
   * only THEN does the second reach its own gate and pause — on the resume leg.
   *
   * Two consequences, both load-bearing and neither guessable from the docs:
   *
   * 1. The resumed step's pending set holds ONE call, so `makeResumedStartChunks`
   *    synthesises a start for that call alone. Approving A can NOT emit a start
   *    for B, because B is not pending yet.
   * 2. B's pre-pause `tool.started` (leg 1) and B's pause row (leg 2) are on
   *    DIFFERENT runs. A same-run exclusion therefore cannot suppress it, which
   *    is why `use-threads-awaiting-approval.ts` orders on `occurred_at` — see
   *    that hook's integration lane for the projection outcome.
   */
  it('PAUSES ONE CALL AT A TIME: two gated calls, approving one pauses the other', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const askTool = makeAskTool(askExecute);
    const thread = { resourceId: 'resource-two-gated', threadId: 'thread-two-gated' } as const;

    modelHolder.current = createTwoToolCallModel({
      calls: [
        { input: JSON.stringify({ command: 'echo A' }), toolCallId: 'call-two-gated-a' },
        { input: JSON.stringify({ command: 'echo B' }), toolCallId: 'call-two-gated-b' },
      ],
      finalText: 'Both done.',
      toolName: 'shell_tool',
    });

    const runtime = {
      apiKey: 'test-key',
      memory: { resourceId: thread.resourceId, threadId: thread.threadId },
      permissionPolicy: ASK_POLICY,
      provider: 'openai' as const,
    };

    const describeToolRunEvents = (chunks: readonly StreamChunk[]) =>
      chunks
        .filter(
          (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
            chunk.type === 'run-event'
        )
        .filter((chunk) => typeof chunk.event.metadata?.toolCallId === 'string')
        .map((chunk) => `${String(chunk.event.metadata?.toolCallId)}:${chunk.event.kind}`);
    const approvalsIn = (chunks: readonly StreamChunk[]) =>
      chunks
        .filter(
          (chunk): chunk is Extract<StreamChunk, { type: 'tool-approval-required' }> =>
            chunk.type === 'tool-approval-required'
        )
        .map((chunk) => chunk.toolCallId);

    const suspendChunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-two-gated', parts: [{ text: 'run both', type: 'text' }], role: 'user' }],
        { memory, runtime, storage, tools: { shell_tool: askTool } }
      )
    );

    // BOTH calls start; only the FIRST pauses.
    expect(describeToolRunEvents(suspendChunks)).toEqual([
      'call-two-gated-a:tool.started',
      'call-two-gated-b:tool.started',
      'call-two-gated-a:tool.approval.requested',
    ]);
    expect(approvalsIn(suspendChunks)).toEqual(['call-two-gated-a']);
    expect(askExecute).not.toHaveBeenCalled();

    const approval = findApprovalChunk(suspendChunks);
    const resumeChunks = await drainYielding(
      await streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: approval?.runId ?? '',
          toolCallId: approval?.toolCallId ?? '',
          toolName: 'shell_tool',
        },
        { memory, requireToolApproval: true, runtime, storage, tools: { shell_tool: askTool } }
      )
    );

    // The resume leg re-yields the start for the APPROVED call only — B is not
    // in the resumed step's pending set — and then B pauses here, on THIS leg.
    expect(describeToolRunEvents(resumeChunks)).toEqual([
      'call-two-gated-a:tool.started',
      'call-two-gated-b:tool.approval.requested',
    ]);
    expect(approvalsIn(resumeChunks)).toEqual(['call-two-gated-b']);

    // Only the approved call ran. B is still waiting on the user.
    expect(askExecute).toHaveBeenCalledTimes(1);
    expect(askExecute.mock.calls[0]?.[0]).toMatchObject({ command: 'echo A' });

    await database.close();
  });

  it('rejects malformed local arguments before Mastra creates an approval snapshot', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const askTool = makeAskTool(askExecute);
    const thread = {
      resourceId: 'resource-malformed-local-tool-call',
      threadId: 'thread-malformed-local-tool-call',
    } as const;

    modelHolder.current = new LlmHostChatModel(GEMMA4_E2B_MODEL_ID, {
      generate: vi.fn().mockResolvedValue({
        finishReason: 'tool_calls',
        text: '',
        toolCalls: [
          {
            function: {
              arguments: '{"command":"printf "BST-708 manual approval preview\\n""}',
              name: 'shell_tool',
            },
            id: 'call-malformed-local-command',
            type: 'function',
          },
        ],
        usage: { completionTokens: 24, promptTokens: 48, totalTokens: 72 },
      }),
      warmup: vi.fn().mockResolvedValue(undefined),
    });

    const iterator = await streamMastraAgent(
      [
        {
          id: 'u-malformed-local-1',
          parts: [{ text: 'run exact command', type: 'text' }],
          role: 'user',
        },
      ],
      {
        memory,
        runtime: {
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          model: GEMMA4_E2B_MODEL_ID,
          permissionPolicy: ASK_POLICY,
          provider: 'local',
        },
        storage,
        tools: { shell_tool: askTool },
      }
    );
    const chunks = await drainYielding(iterator);

    expect(findApprovalChunk(chunks)).toBeUndefined();
    expect(askExecute).not.toHaveBeenCalled();
    expect(
      chunks.some(
        (chunk) =>
          chunk.type === 'text-delta' && chunk.value.includes('local_tool_call_arguments_invalid')
      )
    ).toBe(true);
    expect(
      chunks.some(
        (chunk) =>
          chunk.type === 'run-event' &&
          chunk.event.kind === 'run.failed' &&
          (chunk.event.metadata?.['runError'] as { code?: unknown } | null | undefined)?.code ===
            'local_tool_call_arguments_invalid'
      )
    ).toBe(true);

    const discovered = await listSuspendedMastraRuns(thread, {
      runtime: { provider: 'ollama' },
      storage,
      tools: { shell_tool: askTool },
    });
    expect(discovered.approvals).toEqual([]);

    await database.close();
  });

  it('preserves a valid local pwd call through approval and execution', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const askTool = makeAskTool(askExecute);
    const thread = {
      resourceId: 'resource-valid-local-tool-call',
      threadId: 'thread-valid-local-tool-call',
    } as const;
    let turn = 0;

    modelHolder.current = new LlmHostChatModel(GEMMA4_E2B_MODEL_ID, {
      generate: vi.fn().mockImplementation(() => {
        turn += 1;
        if (turn === 1) {
          return Promise.resolve({
            finishReason: 'tool_calls',
            text: '',
            toolCalls: [
              {
                function: {
                  arguments: '{"command":"pwd"}',
                  name: 'shell_tool',
                },
                id: 'call-valid-local-pwd',
                type: 'function',
              },
            ],
            usage: { completionTokens: 8, promptTokens: 16, totalTokens: 24 },
          });
        }
        return Promise.resolve({
          finishReason: 'stop',
          text: 'Command finished.',
          usage: { completionTokens: 4, promptTokens: 20, totalTokens: 24 },
        });
      }),
      warmup: vi.fn().mockResolvedValue(undefined),
    });

    const runtime = {
      memory: { resourceId: thread.resourceId, threadId: thread.threadId },
      model: GEMMA4_E2B_MODEL_ID,
      permissionPolicy: ASK_POLICY,
      provider: 'local',
    } as const;
    const iterator = await streamMastraAgent(
      [{ id: 'u-valid-local-1', parts: [{ text: 'run pwd', type: 'text' }], role: 'user' }],
      {
        memory,
        runtime,
        storage,
        tools: { shell_tool: askTool },
      }
    );
    const approval = findApprovalChunk(await drainYielding(iterator));

    expect(approval).toMatchObject({
      args: { command: 'pwd' },
      toolCallId: 'call-valid-local-pwd',
      toolName: 'shell_tool',
    });
    expect(askExecute).not.toHaveBeenCalled();

    const resumeIterator = await streamMastraToolApprovalAction(
      {
        action: 'approve',
        runId: approval?.runId ?? '',
        toolCallId: approval?.toolCallId ?? '',
        toolName: 'shell_tool',
      },
      {
        memory,
        requireToolApproval: true,
        runtime,
        storage,
        tools: { shell_tool: askTool },
      }
    );
    const resumeChunks = await drainYielding(resumeIterator);

    expect(askExecute).toHaveBeenCalledOnce();
    expect(askExecute).toHaveBeenCalledWith(
      { command: 'pwd' },
      expect.objectContaining({
        agent: expect.objectContaining({ toolCallId: 'call-valid-local-pwd' }),
      })
    );
    expect(resumeChunks.some((chunk) => chunk.type === 'message-finish')).toBe(true);

    await database.close();
  });

  it('suspends (execute NOT called), then APPROVE executes the tool and the run continues', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const askTool = makeAskTool(askExecute);
    const thread = { resourceId: 'resource-approve-1', threadId: 'thread-approve-1' } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Command finished.',
      input: JSON.stringify({ command: 'echo approved' }),
      toolCallId: 'call-ask-approve-1',
      toolName: 'shell_tool',
    });

    // ── Phase 1: the run SUSPENDS for approval ──
    const suspendIterator = await streamMastraAgent(
      [{ id: 'u-ap-1', parts: [{ text: 'run echo', type: 'text' }], role: 'user' }],
      {
        memory,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          permissionPolicy: ASK_POLICY,
          provider: 'openai',
        },
        storage,
        tools: { shell_tool: askTool },
      }
    );
    const suspendChunks = await drainYielding(suspendIterator);

    const approval = findApprovalChunk(suspendChunks);
    // The run SUSPENDED: an approval-required chunk was emitted with the risk
    // reason, and the tool's execute was NEVER called.
    expect(approval).toBeDefined();
    expect(approval?.toolName).toBe('shell_tool');
    expect(approval?.riskCategory).toBe('execute');
    expect(approval?.policyDecision).toBe('ask');
    expect(approval?.runId).toBeTruthy();
    expect(approval?.toolCallId).toBeTruthy();
    expect(askExecute).not.toHaveBeenCalled();

    // ── The producer→projection ORDERING contract (BST-1404) ──
    // Mastra's approval gate runs INSIDE `toolCallStep`, i.e. AFTER the model's
    // `tool-call` part has already streamed. That part maps to a `status:'start'`
    // tool event and therefore to a `tool.started` run event carrying the SAME
    // `toolCallId` — so on the pausing leg `tool.started` PRECEDES
    // `tool.approval.requested`. Anything that resolves a pause by looking for a
    // later `tool.*` with a matching `toolCallId` must exclude this same-run
    // `tool.started`, or every pause is answered by its own pre-pause event and
    // the Threads panel's "needs you" glyph never lights
    // (`packages/app-shell/src/hooks/use-threads-awaiting-approval.ts`).
    // This is the only place the live Mastra emission order can be observed.
    const suspendRunEventKinds = suspendChunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
      )
      .filter((chunk) => chunk.event.metadata?.toolCallId === 'call-ask-approve-1')
      .map((chunk) => chunk.event.kind);
    expect(suspendRunEventKinds).toEqual(['tool.started', 'tool.approval.requested']);

    // ── Phase 2: APPROVE → the tool EXECUTES and the run continues ──
    // The resume passes requireToolApproval: true, exactly as the desktop
    // assistant-server does — Mastra's approve/decline resume relies on it.
    const resumeIterator = await streamMastraToolApprovalAction(
      {
        action: 'approve',
        runId: approval?.runId ?? '',
        toolCallId: approval?.toolCallId ?? '',
        toolName: 'shell_tool',
      },
      {
        memory,
        requireToolApproval: true,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          permissionPolicy: ASK_POLICY,
          provider: 'openai',
        },
        storage,
        tools: { shell_tool: askTool },
      }
    );
    const resumeChunks = await drainYielding(resumeIterator);

    // The approved tool actually executed with the model's input.
    expect(askExecute).toHaveBeenCalledTimes(1);
    expect(askExecute.mock.calls[0]?.[0]).toMatchObject({ command: 'echo approved' });
    expect(resumeChunks).toContainEqual({
      name: 'shell_tool',
      payload: {
        args: { command: 'echo approved' },
        callId: 'call-ask-approve-1',
        input: { command: 'echo approved' },
        toolCallId: 'call-ask-approve-1',
      },
      status: 'start',
      type: 'tool-event',
    });
    const resumeToolCallLines = (await encodeChunks(resumeChunks))
      .split('\n')
      .filter((line) => line.startsWith('9:'))
      .map((line) => JSON.parse(line.slice(2)) as unknown);
    expect(resumeToolCallLines).toContainEqual({
      args: { command: 'echo approved' },
      toolCallId: 'call-ask-approve-1',
      toolName: 'shell_tool',
    });
    const resumeRunEventKinds = resumeChunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
      )
      .map((chunk) => chunk.event.kind);
    expect(resumeRunEventKinds).toContain('tool.completed');

    // ── The OTHER half of the producer->projection contract (BST-1440) ──
    // The resume leg must re-yield `tool.started` for the SAME `toolCallId`,
    // and it must arrive BEFORE the terminal. That start is what answers the
    // pause the moment the user approves, rather than when the approved tool
    // finishes: `use-threads-awaiting-approval.ts` counts `tool.started` as a
    // resolution and excludes only the SAME-run (pre-pause) one, so this event
    // is the only thing that can clear the "needs you" glyph during a
    // long-running approved call.
    //
    // Mastra never replays the step's `tool-call` part on a resume leg
    // (@mastra/core 1.59: `approveToolCall` -> `resumeStream` re-executes
    // `toolCallStep` with `messages: []`, and the only `tool-call` replay in
    // that step is gated on a background-task manager Brainstrike does not
    // register), so `makeResumedStartChunks` synthesises the start — and routes
    // it through the SAME lifecycle seam the mainline `tool-call` part uses.
    // This is the only place that emission can be observed against the real
    // approval loop.
    //
    // The DIFFERENT-run half of the contract is structural rather than visible
    // here: `run_id` is the Brainstrike `thread_runs` id minted per request by
    // `createThreadRunId` (app-shell), and approve dispatches a NEW request, so
    // the resume leg always writes these events under a new run row. That half
    // is graded in
    // `packages/app-shell/src/__tests__/use-threads-awaiting-approval.integration.test.ts`.
    const resumeApprovedCallEventKinds = resumeChunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
      )
      .filter((chunk) => chunk.event.metadata?.toolCallId === 'call-ask-approve-1')
      .map((chunk) => chunk.event.kind);
    expect(resumeApprovedCallEventKinds).toEqual(['tool.started', 'tool.completed']);

    const resumeFinish = resumeChunks.find((chunk) => chunk.type === 'message-finish');
    expect(resumeFinish).toBeDefined();

    const persisted = await database.query<{ content: unknown }>(
      'SELECT content FROM mastra_messages WHERE thread_id = $1 ORDER BY "createdAt" ASC',
      [thread.threadId]
    );
    const persistedArgs = persisted.rows
      .map((row) => readPersistedToolInvocationArgs(row.content, 'call-ask-approve-1'))
      .filter((args) => args !== undefined);
    expect(persistedArgs.length).toBeGreaterThan(0);
    expect(persistedArgs).toEqual(persistedArgs.map(() => ({ command: 'echo approved' })));

    await database.close();
  });

  it('persists completed tool work when a user cancels an approval-resume stream', async () => {
    const abortController = new AbortController();
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const askTool = makeAskTool(askExecute);
    const thread = {
      resourceId: 'resource-approval-resume-cancel',
      threadId: 'thread-approval-resume-cancel',
    };

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'unused',
      input: JSON.stringify({ command: 'echo approved then stopped' }),
      stallAfterToolResultText: 'This resumed answer was cut short by the user.',
      toolCallId: 'call-approval-resume-cancel',
      toolName: 'shell_tool',
    });

    const suspendChunks = await drainYielding(
      await streamMastraAgent(
        [
          {
            id: 'user-approval-resume-cancel',
            parts: [{ text: 'run echo', type: 'text' }],
            role: 'user',
          },
        ],
        {
          memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: ASK_POLICY,
            provider: 'openai',
          },
          storage,
          tools: { shell_tool: askTool },
        }
      )
    );
    const approval = findApprovalChunk(suspendChunks);
    expect(approval).toBeDefined();

    await drainYielding(
      await streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: approval?.runId ?? '',
          toolCallId: approval?.toolCallId ?? '',
          toolName: 'shell_tool',
        },
        {
          memory,
          requireToolApproval: true,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: ASK_POLICY,
            provider: 'openai',
            signal: abortController.signal,
          },
          storage,
          tools: { shell_tool: askTool },
        }
      ),
      (chunk) => {
        if (chunk.type === 'tool-event' && chunk.status === 'success') {
          abortController.abort(new Error('user stopped approval resume'));
        }
      }
    );

    const persisted = await database.query<{ content: unknown }>(
      'SELECT content FROM mastra_messages WHERE thread_id = $1 ORDER BY "createdAt" ASC',
      [thread.threadId]
    );
    const persistedRecord = JSON.stringify(persisted.rows);
    expect(persistedRecord).toContain('echo approved then stopped');
    expect(persistedRecord.toLowerCase()).toContain('aborted before completion');
    // Mastra >= 1.62 persists the cancelled resume's partial text itself;
    // Brainstrike's abort seam keeps completed tool work plus the marker and
    // no longer excludes the tail (BST-1667).
    expect(persistedRecord).toContain('This resumed answer was cut short by the user.');
    expect(askExecute).toHaveBeenCalledTimes(1);

    await database.close();
  });

  it('preserves approved arguments in the wire and transcript when execution fails', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askExecute = vi.fn(async (_inputData: { command: string }): Promise<never> => {
      throw new Error('expected test failure');
    });
    const askTool = makeFailingAskTool(askExecute);
    const thread = { resourceId: 'resource-approve-error', threadId: 'thread-approve-error' };

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Command failed.',
      input: JSON.stringify({ command: 'echo approved error' }),
      toolCallId: 'call-ask-approve-error',
      toolName: 'shell_tool',
    });

    const suspendChunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-ap-error', parts: [{ text: 'run echo', type: 'text' }], role: 'user' }],
        {
          memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: ASK_POLICY,
            provider: 'openai',
          },
          storage,
          tools: { shell_tool: askTool },
        }
      )
    );
    const approval = findApprovalChunk(suspendChunks);
    expect(approval).toBeDefined();

    const resumeChunks = await drainYielding(
      await streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: approval?.runId ?? '',
          toolCallId: approval?.toolCallId ?? '',
          toolName: 'shell_tool',
        },
        {
          memory,
          requireToolApproval: true,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: ASK_POLICY,
            provider: 'openai',
          },
          storage,
          tools: { shell_tool: askTool },
        }
      )
    );

    expect(askExecute).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'echo approved error' }),
      expect.anything()
    );
    const resumeToolCallLines = (await encodeChunks(resumeChunks))
      .split('\n')
      .filter((line) => line.startsWith('9:'))
      .map((line) => JSON.parse(line.slice(2)) as unknown);
    expect(resumeToolCallLines).toContainEqual({
      args: { command: 'echo approved error' },
      toolCallId: 'call-ask-approve-error',
      toolName: 'shell_tool',
    });

    const persisted = await database.query<{ content: unknown }>(
      'SELECT content FROM mastra_messages WHERE thread_id = $1 ORDER BY "createdAt" ASC',
      [thread.threadId]
    );
    const persistedArgs = persisted.rows
      .map((row) => readPersistedToolInvocationArgs(row.content, 'call-ask-approve-error'))
      .filter((args) => args !== undefined);
    expect(persistedArgs.length).toBeGreaterThan(0);
    expect(persistedArgs).toEqual(persistedArgs.map(() => ({ command: 'echo approved error' })));

    await database.close();
  });

  it('rehydrates a discovered deferred tool before approval resume executes it', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const execute = vi.fn(() => Promise.resolve({ roots: ['brainstrike'] }));
    const deferredTool = createTool({
      description: 'List active workspace roots and context metadata.',
      execute,
      id: 'brainstrike.listWorkspaceContext',
      inputSchema: z.object({}),
      outputSchema: z.object({ roots: z.array(z.string()) }),
    });
    const permissionPolicy = {
      policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'ask' },
      riskByTool: { 'brainstrike.listWorkspaceContext': 'read' },
      yolo: false,
    } as const;
    const thread = {
      resourceId: 'resource-deferred-approval',
      threadId: 'thread-deferred-approval',
    } as const;

    modelHolder.current = createDiscoveryThenToolApprovalModel({
      deferredToolCallId: 'call-deferred-approval',
      deferredToolName: 'brainstrike_listWorkspaceContext',
      finalText: 'Workspace context listed.',
    });

    const suspendChunks = await drainYielding(
      await streamMastraAgent(
        [
          {
            id: 'u-deferred-approval',
            parts: [{ text: 'list roots', type: 'text' }],
            role: 'user',
          },
        ],
        {
          memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy,
            provider: 'openai',
          },
          storage,
          tools: { 'brainstrike.listWorkspaceContext': deferredTool },
        }
      )
    );
    const approval = findApprovalChunk(suspendChunks);
    expect(approval).toMatchObject({
      policyDecision: 'ask',
      riskCategory: 'read',
      toolName: 'brainstrike.listWorkspaceContext',
    });
    expect(execute).not.toHaveBeenCalled();

    const resumeChunks = await drainYielding(
      await streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: approval?.runId ?? '',
          toolCallId: approval?.toolCallId ?? '',
          toolName: approval?.toolName ?? '',
        },
        {
          memory,
          requireToolApproval: true,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy,
            provider: 'openai',
          },
          storage,
          tools: { 'brainstrike.listWorkspaceContext': deferredTool },
        }
      )
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(resumeChunks).toContainEqual(
      expect.objectContaining({
        name: 'brainstrike.listWorkspaceContext',
        status: 'success',
        type: 'tool-event',
      })
    );
    expect(resumeChunks.find((chunk) => chunk.type === 'message-finish')).toBeDefined();

    await database.close();
  });

  it('keeps the suspended Tavily webSearch implementation when a session grant allows the resumed leg', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const execute = vi.fn((inputData: { query: string }) =>
      Promise.resolve({ query: inputData.query, results: [] })
    );
    const webSearchTool = createTool({
      description: 'Search the public web through the execute-backed Tavily integration.',
      execute,
      id: 'brainstrike.webSearch',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ query: z.string(), results: z.array(z.unknown()) }),
    });
    const askPolicy = {
      policies: { edit: 'deny', execute: 'deny', mcp: 'allow', read: 'ask' },
      riskByTool: { 'brainstrike.webSearch': 'read' },
      yolo: false,
    } as const;
    const allowedPolicy = {
      ...askPolicy,
      policies: { ...askPolicy.policies, read: 'allow' },
    } as const;
    const thread = {
      resourceId: 'resource-web-search-approval',
      threadId: 'thread-web-search-approval',
    } as const;

    modelHolder.current = createDiscoveryThenToolApprovalModel({
      deferredInput: JSON.stringify({ query: 'Brainstrike' }),
      deferredToolCallId: 'call-web-search-approval',
      deferredToolName: 'brainstrike_webSearch',
      finalText: 'Web search completed.',
    });

    const suspendChunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-web-search-approval', parts: [{ text: 'search', type: 'text' }], role: 'user' }],
        {
          memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: askPolicy,
            provider: 'openai',
          },
          storage,
          tools: { 'brainstrike.webSearch': webSearchTool },
        }
      )
    );
    const approval = findApprovalChunk(suspendChunks);
    expect(approval).toMatchObject({
      policyDecision: 'ask',
      riskCategory: 'read',
      toolName: 'brainstrike.webSearch',
    });
    expect(execute).not.toHaveBeenCalled();

    const resumeChunks = await drainYielding(
      await streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: approval?.runId ?? '',
          toolCallId: approval?.toolCallId ?? '',
          toolName: approval?.toolName ?? '',
        },
        {
          memory,
          requireToolApproval: true,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: allowedPolicy,
            provider: 'openai',
          },
          storage,
          tools: { 'brainstrike.webSearch': webSearchTool },
        }
      )
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(resumeChunks).toContainEqual(
      expect.objectContaining({
        name: 'brainstrike.webSearch',
        status: 'success',
        type: 'tool-event',
      })
    );
    expect(resumeChunks.find((chunk) => chunk.type === 'message-finish')).toBeDefined();

    await database.close();
  });

  it('keeps provider-native web search when resuming a different approved tool', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const shellExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const webSearchExecute = vi.fn((inputData: { query: string }) =>
      Promise.resolve({ query: inputData.query, results: [] })
    );
    const shellTool = makeAskTool(shellExecute);
    const webSearchTool = createTool({
      description: 'Search the public web through the execute-backed Tavily integration.',
      execute: webSearchExecute,
      id: 'brainstrike.webSearch',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ query: z.string(), results: z.array(z.unknown()) }),
    });
    const policy = {
      policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
      riskByTool: {
        'brainstrike.webSearch': 'read',
        shell_tool: 'execute',
      },
      yolo: false,
    } as const;
    const thread = {
      resourceId: 'resource-non-search-approval',
      threadId: 'thread-non-search-approval',
    } as const;
    const offeredToolsByTurn: LanguageModelV2CallOptions['tools'][] = [];

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Command finished.',
      input: JSON.stringify({ command: 'echo approved' }),
      onTurn: (_turn, options) => offeredToolsByTurn.push(options.tools),
      toolCallId: 'call-non-search-approval',
      toolName: 'shell_tool',
    });

    const suspendChunks = await drainYielding(
      await streamMastraAgent(
        [
          {
            id: 'u-non-search-approval',
            parts: [{ text: 'run echo', type: 'text' }],
            role: 'user',
          },
        ],
        {
          memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: policy,
            provider: 'openai',
          },
          storage,
          tools: { 'brainstrike.webSearch': webSearchTool, shell_tool: shellTool },
        }
      )
    );
    const approval = findApprovalChunk(suspendChunks);
    expect(approval).toMatchObject({
      toolCallId: 'call-non-search-approval',
      toolName: 'shell_tool',
    });

    const resumeChunks = await drainYielding(
      await streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: approval?.runId ?? '',
          toolCallId: approval?.toolCallId ?? '',
          toolName: approval?.toolName ?? '',
        },
        {
          memory,
          requireToolApproval: true,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: policy,
            provider: 'openai',
          },
          storage,
          tools: { 'brainstrike.webSearch': webSearchTool, shell_tool: shellTool },
        }
      )
    );

    expect(shellExecute).toHaveBeenCalledTimes(1);
    expect(webSearchExecute).not.toHaveBeenCalled();
    expect(offeredToolsByTurn).toHaveLength(2);
    expect(offeredToolsByTurn[1]).toContainEqual(
      expect.objectContaining({ id: 'openai.web_search', type: 'provider-defined' })
    );
    expect(resumeChunks.find((chunk) => chunk.type === 'message-finish')).toBeDefined();

    await database.close();
  });

  it('surfaces the ORIGINAL dotted tool name + risk metadata on a live approval pause, and the approve resume executes', async () => {
    // Pins the name-form contract for the LIVE stream: a tool registered under a
    // DOTTED id is sanitized for Mastra (`shell_tool`), but the approval chunk
    // the client sees must carry the ORIGINAL dotted name PLUS the policy risk
    // metadata (askTools is keyed by the sanitized id — the metadata lookup must
    // bridge the two forms).
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const dottedTool = createTool({
      description: 'An execute-risk tool registered under a DOTTED id.',
      execute: askExecute,
      id: 'shell.tool',
      inputSchema: z.object({ command: z.string() }),
      outputSchema: z.object({ ran: z.string() }),
    });
    const policy = {
      policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
      riskByTool: { 'shell.tool': 'execute' },
      yolo: false,
    } as const;
    const thread = { resourceId: 'resource-dotted-1', threadId: 'thread-dotted-1' } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Dotted command finished.',
      input: JSON.stringify({ command: 'echo dotted' }),
      toolCallId: 'call-dotted-approve-1',
      // The model calls the REGISTERED (sanitized) id — what a real provider sees.
      toolName: 'shell_tool',
    });

    const suspendChunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-dot-1', parts: [{ text: 'run echo', type: 'text' }], role: 'user' }],
        {
          memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: policy,
            provider: 'openai',
          },
          storage,
          tools: { 'shell.tool': dottedTool },
        }
      )
    );

    const approval = findApprovalChunk(suspendChunks);
    expect(approval).toBeDefined();
    // Client-facing surfaces always carry the ORIGINAL dotted name…
    expect(approval?.toolName).toBe('shell.tool');
    // …and the policy metadata resolves even though askTools is keyed sanitized.
    expect(approval?.riskCategory).toBe('execute');
    expect(approval?.policyDecision).toBe('ask');
    expect(askExecute).not.toHaveBeenCalled();

    const resumeChunks = await drainYielding(
      await streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: approval?.runId ?? '',
          toolCallId: approval?.toolCallId ?? '',
          toolName: approval?.toolName ?? '',
        },
        {
          memory,
          requireToolApproval: true,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: policy,
            provider: 'openai',
          },
          storage,
          tools: { 'shell.tool': dottedTool },
        }
      )
    );

    expect(askExecute).toHaveBeenCalledTimes(1);
    expect(askExecute.mock.calls[0]?.[0]).toMatchObject({ command: 'echo dotted' });
    expect(resumeChunks.find((chunk) => chunk.type === 'message-finish')).toBeDefined();

    await database.close();
  });

  it('keeps an OpenRouter approval resumable and reports both model-step costs after resume', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const askTool = makeAskTool(askExecute);
    const thread = {
      resourceId: 'resource-openrouter-approval-cost',
      threadId: 'thread-openrouter-approval-cost',
    } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Command finished with exact cost.',
      input: JSON.stringify({ command: 'echo approved' }),
      openRouterStepCosts: [0.001_25, 0.003_75],
      toolCallId: 'call-openrouter-approval-cost',
      toolName: 'shell_tool',
    });

    const suspendIterator = await streamMastraAgent(
      [{ id: 'u-openrouter-cost', parts: [{ text: 'run echo', type: 'text' }], role: 'user' }],
      {
        memory,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          permissionPolicy: ASK_POLICY,
          provider: 'openrouter',
        },
        storage,
        tools: { shell_tool: askTool },
      }
    );
    const suspendChunks = await drainYielding(suspendIterator);
    const approval = findApprovalChunk(suspendChunks);
    expect(approval).toBeDefined();
    const pauseFinish = suspendChunks.find(
      (chunk) => chunk.type === 'message-finish' && chunk.finishReason === 'tool-calls'
    );
    expect(pauseFinish).toMatchObject({ finishReason: 'tool-calls', type: 'message-finish' });
    expect(pauseFinish).not.toHaveProperty('billedCostUsd');

    const resumeIterator = await streamMastraToolApprovalAction(
      {
        action: 'approve',
        runId: approval?.runId ?? '',
        toolCallId: approval?.toolCallId ?? '',
        toolName: 'shell_tool',
      },
      {
        memory,
        requireToolApproval: true,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          permissionPolicy: ASK_POLICY,
          provider: 'openrouter',
        },
        storage,
        tools: { shell_tool: askTool },
      }
    );
    const resumeChunks = await drainYielding(resumeIterator);
    expect(resumeChunks.find((chunk) => chunk.type === 'message-finish')).toMatchObject({
      billedCostUsd: 0.005,
      finishReason: 'stop',
      type: 'message-finish',
    });

    await database.close();
  });

  it('suspends, then DECLINE skips the tool (execute NOT called) and the run continues', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const askTool = makeAskTool(askExecute);
    const thread = { resourceId: 'resource-decline-1', threadId: 'thread-decline-1' } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Okay, I will not run that.',
      input: JSON.stringify({ command: 'echo declined' }),
      toolCallId: 'call-ask-decline-1',
      toolName: 'shell_tool',
    });

    // ── Phase 1: the run SUSPENDS for approval ──
    const suspendIterator = await streamMastraAgent(
      [{ id: 'u-dc-1', parts: [{ text: 'run echo', type: 'text' }], role: 'user' }],
      {
        memory,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          permissionPolicy: ASK_POLICY,
          provider: 'openai',
        },
        storage,
        tools: { shell_tool: askTool },
      }
    );
    const suspendChunks = await drainYielding(suspendIterator);

    const approval = findApprovalChunk(suspendChunks);
    expect(approval).toBeDefined();
    expect(askExecute).not.toHaveBeenCalled();

    // ── Phase 2: DECLINE → the tool is SKIPPED (never executes) ──
    const resumeIterator = await streamMastraToolApprovalAction(
      {
        action: 'decline',
        runId: approval?.runId ?? '',
        toolCallId: approval?.toolCallId ?? '',
        toolName: 'shell_tool',
      },
      {
        memory,
        requireToolApproval: true,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          permissionPolicy: ASK_POLICY,
          provider: 'openai',
        },
        storage,
        tools: { shell_tool: askTool },
      }
    );
    const resumeChunks = await drainYielding(resumeIterator);

    // DECLINE: the tool execute is NEVER called, yet the run continues to a
    // terminal finish (the model gets re-invoked and answers).
    expect(askExecute).not.toHaveBeenCalled();
    const resumeFinish = resumeChunks.find((chunk) => chunk.type === 'message-finish');
    expect(resumeFinish).toBeDefined();
    const declineText = resumeChunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> =>
          chunk.type === 'text-delta'
      )
      .map((chunk) => chunk.value)
      .join('');
    expect(declineText).toContain('will not run that');
    // @mastra/core 1.59 (BST-1282) SUPERSEDES the older "a decline puts no tool
    // frames on the wire at all" shape. The tool still never runs, but the
    // decline leg now emits `tool-output-denied`, and that MUST reach the wire
    // as a card which is both started and SETTLED — a declined call left
    // unsettled is the renderer hang mastra #20886 shipped the chunk to fix.
    // The settle carries the declined envelope and no `isError`: a decline is
    // terminal, but it is not a failure.
    const declineLines = (await encodeChunks(resumeChunks)).split('\n');
    expect(declineLines.filter((line) => line.startsWith('b:'))).toHaveLength(1);
    const declineResults = declineLines
      .filter((line) => line.startsWith('a:'))
      .map((line) => JSON.parse(line.slice(2)) as Record<string, unknown>);
    expect(declineResults).toHaveLength(1);
    expect(declineResults[0]).toMatchObject({
      result: { kind: 'declined' },
      toolCallId: approval?.toolCallId ?? '',
    });
    expect(declineResults[0]).not.toHaveProperty('isError');

    await database.close();
  });

  it('lets an ALLOWED read tool run FREE even while an ask tool is in the map (no global suspend)', async () => {
    // The P1 regression this guards: forcing the run-wide requireToolApproval
    // would suspend EVERY tool call. With the PER-TOOL requireApproval gate, a
    // run that only calls an allowed read tool must NOT suspend — even though an
    // ask-gated execute tool is also present in the map.
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const readExecute = vi.fn((inputData: { path: string }) =>
      Promise.resolve({ contents: `body of ${inputData.path}` })
    );
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const readTool = createTool({
      description: 'A read-only tool (allow).',
      execute: readExecute,
      id: 'read_tool',
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.object({ contents: z.string() }),
    });
    const askTool = makeAskTool(askExecute);
    const thread = { resourceId: 'resource-free-1', threadId: 'thread-free-1' } as const;
    // read=allow, execute=ask; both tools registered. The model calls ONLY read.
    const policy = {
      policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
      riskByTool: { read_tool: 'read', shell_tool: 'execute' },
      yolo: false,
    } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Here is the file.',
      input: JSON.stringify({ path: '/README.md' }),
      toolCallId: 'call-read-1',
      toolName: 'read_tool',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u-free-1', parts: [{ text: 'read the readme', type: 'text' }], role: 'user' }],
      {
        memory,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          permissionPolicy: policy,
          provider: 'openai',
        },
        storage,
        tools: { read_tool: readTool, shell_tool: askTool },
      }
    );
    const chunks = await drainYielding(iterator);

    // The allowed read tool ran free: it executed, never suspended, and the ask
    // tool was untouched.
    expect(readExecute).toHaveBeenCalledTimes(1);
    expect(askExecute).not.toHaveBeenCalled();
    expect(findApprovalChunk(chunks)).toBeUndefined();
    const runEventKinds = chunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
      )
      .map((chunk) => chunk.event.kind);
    expect(runEventKinds).toContain('tool.completed');
    const finalText = chunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> =>
          chunk.type === 'text-delta'
      )
      .map((chunk) => chunk.value)
      .join('');
    expect(finalText).toContain('Here is the file.');

    await database.close();
  });

  it('RESTART: listSuspendedMastraRuns rediscovers a suspended approval a FRESH runtime can resume', async () => {
    // The headline restart-safety proof. Phase 1 suspends over `database`. Phase 2
    // simulates a process restart — a brand-new memory/storage/Agent over the SAME
    // PGlite DB rediscovers the pending approval via `agent.listSuspendedRuns`
    // (no in-memory stream handle survives a restart). Phase 3 feeds the discovered
    // runId+toolCallId into a fresh `streamMastraToolApprovalAction` and the tool
    // finally executes.
    const database = new PGlite();
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const askTool = makeAskTool(askExecute);
    const thread = { resourceId: 'resource-restart-1', threadId: 'thread-restart-1' } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Command finished after restart.',
      input: JSON.stringify({ command: 'echo restart' }),
      toolCallId: 'call-ask-restart-1',
      toolName: 'shell_tool',
    });

    // ── Phase 1: SUSPEND (first "process") ──
    const firstBoot = await makeMemory(database);
    const suspendIterator = await streamMastraAgent(
      [{ id: 'u-rst-1', parts: [{ text: 'run echo', type: 'text' }], role: 'user' }],
      {
        memory: firstBoot.memory,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          permissionPolicy: ASK_POLICY,
          provider: 'openai',
        },
        storage: firstBoot.storage,
        tools: { shell_tool: askTool },
      }
    );
    const suspendChunks = await drainYielding(suspendIterator);
    const approval = findApprovalChunk(suspendChunks);
    expect(approval).toBeDefined();
    expect(askExecute).not.toHaveBeenCalled();

    // ── Phase 2: RESTART SIMULATION — fresh runtime, same DB, rediscover ──
    // KEYLESS discovery: the stable agent id ('brainstrike-assistant') is
    // provider-independent, so listing constructs a keyless `ollama` agent (no
    // apiKey) — the exact path the desktop /suspended-runs route uses — and still
    // rediscovers a run that suspended under a DIFFERENT provider ('openai').
    const secondBoot = await makeMemory(database);
    const discovery = await listSuspendedMastraRuns(
      { resourceId: thread.resourceId, threadId: thread.threadId },
      {
        memory: secondBoot.memory,
        runtime: {
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          provider: 'ollama',
        },
        storage: secondBoot.storage,
      }
    );

    expect(discovery.approvals).toHaveLength(1);
    const rediscovered = discovery.approvals[0];
    expect(rediscovered?.runId).toBe(approval?.runId);
    expect(rediscovered?.toolCallId).toBe(approval?.toolCallId);
    expect(rediscovered?.toolName).toBe('shell_tool');
    expect(typeof rediscovered?.suspendedAt).toBe('string');
    expect(Number.isNaN(Date.parse(rediscovered?.suspendedAt ?? 'x'))).toBe(false);
    // Discovery is inert — it must never execute the pending tool.
    expect(askExecute).not.toHaveBeenCalled();

    // A different thread sees nothing (scope filter).
    const emptyDiscovery = await listSuspendedMastraRuns(
      { resourceId: thread.resourceId, threadId: 'thread-other' },
      {
        memory: secondBoot.memory,
        runtime: {
          memory: { resourceId: thread.resourceId, threadId: 'thread-other' },
          provider: 'ollama',
        },
        storage: secondBoot.storage,
      }
    );
    expect(emptyDiscovery.approvals).toHaveLength(0);

    // ── Phase 3: RESUME the rediscovered run from a THIRD fresh runtime ──
    const thirdBoot = await makeMemory(database);
    const resumeIterator = await streamMastraToolApprovalAction(
      {
        action: 'approve',
        runId: rediscovered?.runId ?? '',
        toolCallId: rediscovered?.toolCallId ?? '',
        toolName: rediscovered?.toolName ?? '',
      },
      {
        memory: thirdBoot.memory,
        requireToolApproval: true,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          permissionPolicy: ASK_POLICY,
          provider: 'openai',
        },
        storage: thirdBoot.storage,
        tools: { shell_tool: askTool },
      }
    );
    const resumeChunks = await drainYielding(resumeIterator);

    expect(askExecute).toHaveBeenCalledTimes(1);
    expect(askExecute.mock.calls[0]?.[0]).toMatchObject({ command: 'echo restart' });
    expect(resumeChunks.find((chunk) => chunk.type === 'message-finish')).toBeDefined();

    await database.close();
  });

  it('DESKTOP wiring: native tools carried on runtime.mastraTools survive the approval RESUME', async () => {
    // The regression this guards (the desktop "I hit Approve and it did not take"
    // bug): the desktop carries native tools on `runtime.mastraTools` (NOT
    // `options.tools`). The initial turn goes through `toAiSdkStyleStream`, which
    // threads `runtime.mastraTools -> options.tools`; the approval RESUME called
    // `streamMastraToolApprovalAction` DIRECTLY and never threaded them, so the
    // rebuilt Agent had an EMPTY native tool map — the model saw only Mastra's
    // memory tool (`updateWorkingMemory`) and the approved write tool could not
    // execute. The other tests in this file pass tools via `options.tools` on the
    // resume, which masked the gap. This one mirrors production exactly.
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const writeExecute = vi.fn((inputData: { path: string; content: string }) =>
      Promise.resolve({ ok: true, path: inputData.path })
    );
    const writeTool = createTool({
      description: 'An edit-risk write tool gated to ask.',
      execute: writeExecute,
      id: 'write_tool',
      inputSchema: z.object({ content: z.string(), path: z.string() }),
      outputSchema: z.object({ ok: z.boolean(), path: z.string() }),
    });
    const thread = { resourceId: 'resource-desktop-1', threadId: 'thread-desktop-1' } as const;
    // edit gated to ask, exactly like writeWorkspaceFile on the desktop.
    const policy = {
      policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
      riskByTool: { write_tool: 'edit' },
      yolo: false,
    } as const;
    // Tools ride on runtime.mastraTools (desktop wiring); options.tools is UNSET
    // on the resume below — the precise condition that triggered the bug.
    const runtime = {
      apiKey: 'test-key',
      mastraTools: { write_tool: writeTool },
      memory: { resourceId: thread.resourceId, threadId: thread.threadId },
      permissionPolicy: policy,
      provider: 'openai',
    } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Created brainblog/hello.txt.',
      input: JSON.stringify({ content: 'hello Sean', path: 'brainblog/hello.txt' }),
      toolCallId: 'call-desktop-write-1',
      toolName: 'write_tool',
    });

    // ── Phase 1: initial turn via the DESKTOP path → SUSPENDS for approval ──
    const suspendIterator = await toAiSdkStyleStream(
      [{ id: 'u-desk-1', parts: [{ text: 'write hello.txt', type: 'text' }], role: 'user' }],
      runtime,
      { memory, storage }
    );
    const suspendChunks = await drainYielding(suspendIterator);
    const approval = findApprovalChunk(suspendChunks);
    expect(approval).toBeDefined();
    expect(approval?.toolName).toBe('write_tool');
    expect(approval?.riskCategory).toBe('edit');
    expect(writeExecute).not.toHaveBeenCalled();

    // ── Phase 2: APPROVE via the DESKTOP resume path. Tools come ONLY from
    //    runtime.mastraTools — options.tools is intentionally absent. ──
    const resumeIterator = await streamMastraToolApprovalAction(
      {
        action: 'approve',
        runId: approval?.runId ?? '',
        toolCallId: approval?.toolCallId ?? '',
        toolName: 'write_tool',
      },
      {
        memory,
        requireToolApproval: true,
        runtime,
        storage,
      }
    );
    const resumeChunks = await drainYielding(resumeIterator);

    // The approved tool actually EXECUTED on resume (it was present in the rebuilt
    // Agent's tool map) and the run reached a terminal finish.
    expect(writeExecute).toHaveBeenCalledTimes(1);
    expect(writeExecute.mock.calls[0]?.[0]).toMatchObject({
      content: 'hello Sean',
      path: 'brainblog/hello.txt',
    });
    const resumeRunEventKinds = resumeChunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
      )
      .map((chunk) => chunk.event.kind);
    expect(resumeRunEventKinds).toContain('tool.completed');
    expect(resumeChunks.find((chunk) => chunk.type === 'message-finish')).toBeDefined();

    await database.close();
  });

  it('lets an allowed read tool run free after an ask tool is approved', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const readExecute = vi.fn((inputData: { path: string }) =>
      Promise.resolve({ contents: `body of ${inputData.path}` })
    );
    const askTool = makeAskTool(askExecute);
    const readTool = createTool({
      description: 'A read-only tool (allow).',
      execute: readExecute,
      id: 'read_tool',
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.object({ contents: z.string() }),
    });
    const policy = {
      policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
      riskByTool: { read_tool: 'read', shell_tool: 'execute' },
      yolo: false,
    } as const;
    const thread = { resourceId: 'resource-resume-read', threadId: 'thread-resume-read' } as const;

    modelHolder.current = createAskThenToolCallModel({
      askInput: JSON.stringify({ command: 'echo hi' }),
      askToolCallId: 'call-ask-resume-read',
      askToolName: 'shell_tool',
      finalText: 'Read after approval.',
      secondInput: JSON.stringify({ path: '/README.md' }),
      secondToolCallId: 'call-read-after-approval',
      secondToolName: 'read_tool',
    });

    const suspendChunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-resume-read', parts: [{ text: 'run then read', type: 'text' }], role: 'user' }],
        {
          memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: policy,
            provider: 'openai',
          },
          storage,
          tools: { read_tool: readTool, shell_tool: askTool },
        }
      )
    );
    const approval = findApprovalChunk(suspendChunks);

    const resumeChunks = await drainYielding(
      await streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: approval?.runId ?? '',
          toolCallId: approval?.toolCallId ?? '',
          toolName: 'shell_tool',
        },
        {
          memory,
          requireToolApproval: true,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: policy,
            provider: 'openai',
          },
          storage,
          tools: { read_tool: readTool, shell_tool: askTool },
        }
      )
    );

    expect(askExecute).toHaveBeenCalledTimes(1);
    expect(readExecute).toHaveBeenCalledTimes(1);
    expect(
      resumeChunks.find(
        (chunk) => chunk.type === 'tool-approval-required' && chunk.toolName === 'read_tool'
      )
    ).toBeUndefined();
    expect(resumeChunks.find((chunk) => chunk.type === 'message-finish')).toBeDefined();

    await database.close();
  });

  it('keeps an allowed read free after two consecutive ask approvals', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const readExecute = vi.fn((inputData: { path: string }) =>
      Promise.resolve({ contents: inputData.path })
    );
    const readTool = createTool({
      description: 'A read-only tool.',
      execute: readExecute,
      id: 'read_tool',
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.object({ contents: z.string() }),
    });
    const policy = {
      policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
      riskByTool: { read_tool: 'read', shell_tool: 'execute' },
      yolo: false,
    } as const;
    const runtime = {
      apiKey: 'test-key',
      memory: { resourceId: 'resource-two-asks', threadId: 'thread-two-asks' },
      permissionPolicy: policy,
      provider: 'openai',
    } as const;
    const tools = { read_tool: readTool, shell_tool: makeAskTool(askExecute) };

    modelHolder.current = createAskThenToolCallModel({
      askInput: JSON.stringify({ command: 'echo one' }),
      askToolCallId: 'call-ask-one',
      askToolName: 'shell_tool',
      finalText: 'Finished after reading.',
      secondInput: JSON.stringify({ command: 'echo two' }),
      secondToolCallId: 'call-ask-two',
      secondToolName: 'shell_tool',
      thirdInput: JSON.stringify({ path: '/README.md' }),
      thirdToolCallId: 'call-read-after-two-asks',
      thirdToolName: 'read_tool',
    });

    const initialChunks = await drainYielding(
      await streamMastraAgent(
        [
          {
            id: 'u-two-asks',
            parts: [{ text: 'run twice then read', type: 'text' }],
            role: 'user',
          },
        ],
        { memory, runtime, storage, tools }
      )
    );
    const firstApproval = findApprovalChunk(initialChunks);
    const firstResumeChunks = await drainYielding(
      await streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: firstApproval?.runId ?? '',
          toolCallId: firstApproval?.toolCallId ?? '',
          toolName: 'shell_tool',
        },
        { memory, requireToolApproval: true, runtime, storage, tools }
      )
    );
    const secondApproval = findApprovalChunk(firstResumeChunks);
    expect(secondApproval?.toolCallId).toBe('call-ask-two');

    const finalChunks = await drainYielding(
      await streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: secondApproval?.runId ?? '',
          toolCallId: secondApproval?.toolCallId ?? '',
          toolName: 'shell_tool',
        },
        { memory, requireToolApproval: true, runtime, storage, tools }
      )
    );

    expect(askExecute).toHaveBeenCalledTimes(2);
    expect(readExecute).toHaveBeenCalledTimes(1);
    expect(finalChunks.some((chunk) => chunk.type === 'tool-approval-required')).toBe(false);
    expect(finalChunks.some((chunk) => chunk.type === 'message-finish')).toBe(true);

    await database.close();
  });

  it('never persists an approval action echo as a Mastra user row (transport bookkeeping only)', async () => {
    // Pins the persistence claim behind the transport-level echo exclusion:
    // neither the suspend leg nor the approve resume passes the client's
    // "Approved <tool>." bookkeeping message to Mastra, so `mastra_messages`
    // must contain NO user row with approval action text. If this ever finds
    // one, the exclusion needs a persistence-side seam at that writer (and
    // docs/agents/assistant-persistence.md must be updated).
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const askTool = makeAskTool(askExecute);
    const thread = { resourceId: 'resource-echo-1', threadId: 'thread-echo-1' } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Echo check finished.',
      input: JSON.stringify({ command: 'echo persisted?' }),
      toolCallId: 'call-echo-persist-1',
      toolName: 'shell_tool',
    });

    const suspendChunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-echo-1', parts: [{ text: 'run echo', type: 'text' }], role: 'user' }],
        {
          memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: ASK_POLICY,
            provider: 'openai',
          },
          storage,
          tools: { shell_tool: askTool },
        }
      )
    );
    const approval = findApprovalChunk(suspendChunks);
    expect(approval).toBeDefined();

    const resumeChunks = await drainYielding(
      await streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: approval?.runId ?? '',
          toolCallId: approval?.toolCallId ?? '',
          toolName: 'shell_tool',
        },
        {
          memory,
          requireToolApproval: true,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: ASK_POLICY,
            provider: 'openai',
          },
          storage,
          tools: { shell_tool: askTool },
        }
      )
    );
    expect(resumeChunks.find((chunk) => chunk.type === 'message-finish')).toBeDefined();
    expect(askExecute).toHaveBeenCalledTimes(1);

    const { rows } = await database.query<{ content: string; role: string }>(
      'SELECT role, content FROM mastra_messages WHERE thread_id = $1',
      [thread.threadId]
    );
    expect(rows.length).toBeGreaterThan(0);
    const userRows = rows.filter((row) => row.role === 'user');
    // The real user prompt IS persisted…
    expect(userRows.some((row) => JSON.stringify(row.content).includes('run echo'))).toBe(true);
    // …but no approval bookkeeping text ever becomes a durable user row.
    expect(userRows.some((row) => JSON.stringify(row.content).includes('Approved'))).toBe(false);

    await database.close();
  });

  it('D4: the resume leg does NOT prompt approval for Mastra-internal updateWorkingMemory', async () => {
    // The resume passes run-wide requireToolApproval: true (required by the resume
    // API). Without the D4 exemption that blanket gate suspends EVERY tool call on
    // the resumed run — including Mastra's internal `updateWorkingMemory` — so
    // memory bookkeeping surfaces a spurious approval prompt. The fix substitutes
    // the function form of the gate, exempting internal tools.
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const askTool = makeAskTool(askExecute);
    const thread = { resourceId: 'resource-d4-wm', threadId: 'thread-d4-wm' } as const;

    modelHolder.current = createAskThenToolCallModel({
      askInput: JSON.stringify({ command: 'echo hi' }),
      askToolCallId: 'call-ask-d4-1',
      askToolName: 'shell_tool',
      finalText: 'Noted and finished.',
      secondInput: JSON.stringify({ memory: '# Notes\n- user likes tests' }),
      secondToolCallId: 'call-wm-d4-1',
      secondToolName: 'updateWorkingMemory',
    });

    // ── Phase 1: initial turn suspends on the ask tool ──
    const suspendIterator = await streamMastraAgent(
      [{ id: 'u-d4-1', parts: [{ text: 'run echo', type: 'text' }], role: 'user' }],
      {
        memory,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          permissionPolicy: ASK_POLICY,
          provider: 'openai',
        },
        storage,
        tools: { shell_tool: askTool },
      }
    );
    const suspendChunks = await drainYielding(suspendIterator);
    const approval = findApprovalChunk(suspendChunks);
    expect(approval?.toolName).toBe('shell_tool');
    expect(askExecute).not.toHaveBeenCalled();

    // ── Phase 2: APPROVE → shell_tool runs, then the model calls
    //    updateWorkingMemory. It must NOT emit a second approval chunk. ──
    const resumeIterator = await streamMastraToolApprovalAction(
      {
        action: 'approve',
        runId: approval?.runId ?? '',
        toolCallId: approval?.toolCallId ?? '',
        toolName: 'shell_tool',
      },
      {
        memory,
        requireToolApproval: true,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          permissionPolicy: ASK_POLICY,
          provider: 'openai',
        },
        storage,
        tools: { shell_tool: askTool },
      }
    );
    const resumeChunks = await drainYielding(resumeIterator);

    // The approved ask tool executed on resume.
    expect(askExecute).toHaveBeenCalledTimes(1);
    // No approval prompt was surfaced for the internal working-memory tool.
    const workingMemoryApproval = resumeChunks.find(
      (chunk): chunk is Extract<StreamChunk, { type: 'tool-approval-required' }> =>
        chunk.type === 'tool-approval-required' && chunk.toolName === 'updateWorkingMemory'
    );
    expect(workingMemoryApproval).toBeUndefined();
    // The resumed run reached a terminal finish (memory update executed inline).
    expect(resumeChunks.find((chunk) => chunk.type === 'message-finish')).toBeDefined();

    await database.close();
  });

  it('GRANT-ALL: "Allow all tools this session" resume runs a later ask-category tool WITHOUT re-prompting', async () => {
    // The security-sensitive re-prompt bug: clicking "Allow all tools this
    // session" records session grants for ALL categories, then approves the
    // pending call. The resume still carries run-wide requireToolApproval: true,
    // and — because every category is now granted — the rebuilt runtime's gate
    // resolves NOTHING to 'ask' (askTools is empty). The OLD resolveResumeApprovalGate
    // read an empty askTools as an EXPLICIT GLOBAL approval and re-gated every
    // non-internal tool, so a SECOND mutation tool in the same resumed run would
    // prompt again — the opposite of "allow all this session". The fix
    // DISAMBIGUATES empty-because-all-allowed (a policy WAS enforced → allow-all)
    // from empty-because-genuine-global (no policy → gate-all).
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const secondExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const askTool = makeAskTool(askExecute);
    const secondTool = createTool({
      description: 'A second execute-risk tool (also ask under the base policy).',
      execute: secondExecute,
      id: 'shell_tool_two',
      inputSchema: z.object({ command: z.string() }),
      outputSchema: z.object({ ran: z.string() }),
    });
    // Base policy: execute is ASK, so the initial run SUSPENDS on the first tool.
    const basePolicy = {
      policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
      riskByTool: { shell_tool: 'execute', shell_tool_two: 'execute' },
      yolo: false,
    } as const;
    // Resume policy after "Allow all tools this session": every category granted.
    // The gate now resolves BOTH execute tools to 'allow', so askTools is empty.
    const grantAllPolicy = {
      ...basePolicy,
      sessionGrants: ['read', 'edit', 'execute', 'mcp'],
    } as const;
    const thread = { resourceId: 'resource-grant-all', threadId: 'thread-grant-all' } as const;

    modelHolder.current = createAskThenToolCallModel({
      askInput: JSON.stringify({ command: 'echo first' }),
      askToolCallId: 'call-ask-grant-all',
      askToolName: 'shell_tool',
      finalText: 'Both commands finished.',
      secondInput: JSON.stringify({ command: 'echo second' }),
      secondToolCallId: 'call-second-grant-all',
      secondToolName: 'shell_tool_two',
    });

    // ── Phase 1: initial turn suspends on the first ask tool ──
    const suspendChunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-grant-all', parts: [{ text: 'run two commands', type: 'text' }], role: 'user' }],
        {
          memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: basePolicy,
            provider: 'openai',
          },
          storage,
          tools: { shell_tool: askTool, shell_tool_two: secondTool },
        }
      )
    );
    const approval = findApprovalChunk(suspendChunks);
    expect(approval?.toolName).toBe('shell_tool');
    expect(askExecute).not.toHaveBeenCalled();

    // ── Phase 2: APPROVE with the grant-all policy → the pending tool executes,
    //    then the model calls a SECOND execute-risk tool. Under the all-granted
    //    posture it must NOT re-prompt (no approval chunk, execute runs). ──
    const resumeChunks = await drainYielding(
      await streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: approval?.runId ?? '',
          toolCallId: approval?.toolCallId ?? '',
          toolName: 'shell_tool',
        },
        {
          memory,
          requireToolApproval: true,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: grantAllPolicy,
            provider: 'openai',
          },
          storage,
          tools: { shell_tool: askTool, shell_tool_two: secondTool },
        }
      )
    );

    // Both tools executed; the SECOND tool never surfaced an approval prompt.
    expect(askExecute).toHaveBeenCalledTimes(1);
    expect(secondExecute).toHaveBeenCalledTimes(1);
    expect(
      resumeChunks.find(
        (chunk) => chunk.type === 'tool-approval-required' && chunk.toolName === 'shell_tool_two'
      )
    ).toBeUndefined();
    expect(resumeChunks.find((chunk) => chunk.type === 'message-finish')).toBeDefined();

    await database.close();
  });
});
