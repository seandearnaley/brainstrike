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
import { ReadableStream } from 'node:stream/web';
import type { LanguageModelV2, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import { createTool } from '@mastra/core/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PgliteDatabase, PgliteMastraMemoryOptions } from '../pglite-mastra-memory';
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
    getDefaultModel: () => 'fake-model',
    createProvider: () => {
      if (!modelHolder.current) {
        throw new Error('test fake model was not configured');
      }
      return modelHolder.current;
    },
  };
});

const { streamMastraAgent, streamMastraToolApprovalAction } = await import(
  '../mastra/agent-runtime'
);
const { createPgliteMastraMemory } = await import('../pglite-mastra-memory');

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
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: () => {
      turn += 1;
      if (turn === 1) {
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: args.toolCallId,
              toolName: args.toolName,
              input: args.input,
            },
            { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
          ]),
        });
      }
      const id = 'text-final';
      return Promise.resolve({
        stream: enqueue([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id },
          { type: 'text-delta', id, delta: args.finalText },
          { type: 'text-end', id },
          { type: 'finish', finishReason: 'stop', usage: USAGE },
        ]),
      });
    },
  };
}

const ASK_POLICY = {
  policies: { read: 'allow', edit: 'deny', execute: 'ask', mcp: 'allow' },
  yolo: false,
  riskByTool: { shell_tool: 'execute' },
} as const;

function makeAskTool(execute: ReturnType<typeof vi.fn>) {
  return createTool({
    id: 'shell_tool',
    description: 'An execute-risk tool gated to ask.',
    inputSchema: z.object({ command: z.string() }),
    outputSchema: z.object({ ran: z.string() }),
    execute,
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

describe("'ask' suspends for approval and resumes (real @mastra/core/agent + real PGlite)", () => {
  beforeEach(() => {
    modelHolder.current = undefined;
  });

  it('suspends (execute NOT called), then APPROVE executes the tool and the run continues', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const askTool = makeAskTool(askExecute);
    const thread = { threadId: 'thread-approve-1', resourceId: 'resource-approve-1' } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      toolName: 'shell_tool',
      toolCallId: 'call-ask-approve-1',
      input: JSON.stringify({ command: 'echo approved' }),
      finalText: 'Command finished.',
    });

    // ── Phase 1: the run SUSPENDS for approval ──
    const suspendIterator = await streamMastraAgent(
      [{ id: 'u-ap-1', role: 'user', parts: [{ type: 'text', text: 'run echo' }] }],
      {
        memory,
        storage,
        runtime: {
          provider: 'openai',
          apiKey: 'test-key',
          permissionPolicy: ASK_POLICY,
          memory: { threadId: thread.threadId, resourceId: thread.resourceId },
        },
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
        storage,
        requireToolApproval: true,
        runtime: {
          provider: 'openai',
          apiKey: 'test-key',
          permissionPolicy: ASK_POLICY,
          memory: { threadId: thread.threadId, resourceId: thread.resourceId },
        },
        tools: { shell_tool: askTool },
      }
    );
    const resumeChunks = await drainYielding(resumeIterator);

    // The approved tool actually executed with the model's input.
    expect(askExecute).toHaveBeenCalledTimes(1);
    expect(askExecute.mock.calls[0]?.[0]).toMatchObject({ command: 'echo approved' });
    const resumeRunEventKinds = resumeChunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
      )
      .map((chunk) => chunk.event.kind);
    expect(resumeRunEventKinds).toContain('tool.completed');
    const resumeFinish = resumeChunks.find((chunk) => chunk.type === 'message-finish');
    expect(resumeFinish).toBeDefined();

    await database.close();
  });

  it('suspends, then DECLINE skips the tool (execute NOT called) and the run continues', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const askTool = makeAskTool(askExecute);
    const thread = { threadId: 'thread-decline-1', resourceId: 'resource-decline-1' } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      toolName: 'shell_tool',
      toolCallId: 'call-ask-decline-1',
      input: JSON.stringify({ command: 'echo declined' }),
      finalText: 'Okay, I will not run that.',
    });

    // ── Phase 1: the run SUSPENDS for approval ──
    const suspendIterator = await streamMastraAgent(
      [{ id: 'u-dc-1', role: 'user', parts: [{ type: 'text', text: 'run echo' }] }],
      {
        memory,
        storage,
        runtime: {
          provider: 'openai',
          apiKey: 'test-key',
          permissionPolicy: ASK_POLICY,
          memory: { threadId: thread.threadId, resourceId: thread.resourceId },
        },
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
        storage,
        requireToolApproval: true,
        runtime: {
          provider: 'openai',
          apiKey: 'test-key',
          permissionPolicy: ASK_POLICY,
          memory: { threadId: thread.threadId, resourceId: thread.resourceId },
        },
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

    await database.close();
  });
});
