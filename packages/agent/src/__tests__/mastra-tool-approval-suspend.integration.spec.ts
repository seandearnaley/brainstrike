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
    createProvider: () => {
      if (!modelHolder.current) {
        throw new Error('test fake model was not configured');
      }
      return modelHolder.current;
    },
    getDefaultModel: () => 'fake-model',
  };
});

const { listSuspendedMastraRuns, streamMastraAgent, streamMastraToolApprovalAction } = await import(
  '../mastra/agent-runtime'
);
const { createPgliteMastraMemory } = await import('../pglite-mastra-memory');
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
  openRouterStepCosts?: readonly [number, number];
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
});
