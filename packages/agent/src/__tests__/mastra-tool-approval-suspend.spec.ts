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
    createProvider: () => {
      if (!modelHolder.current) {
        throw new Error('test fake model was not configured');
      }
      return modelHolder.current;
    },
    getDefaultModel: () => 'fake-model',
  };
});

const { streamMastraAgent, streamMastraToolApprovalAction } = await import(
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

const ASK_POLICY = {
  policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
  riskByTool: { shell_tool: 'execute' },
  yolo: false,
} as const;

function makeAskTool(execute: ReturnType<typeof vi.fn>) {
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
});
