/**
 * LIVE-loop proof for the SUSPENDING tools (submitPlan / askUser) + plan mode.
 *
 * These drive the REAL Mastra agent loop (no agent mock — only the language
 * model is a scripted fake) with REAL PGlite-backed workflow storage. A
 * suspending tool must:
 *   - PAUSE the run (emit `tool-suspend-required` with the tool's suspendPayload;
 *     the post-suspend body is NOT reached), then via `streamMastraToolResumeAction`:
 *       - resume with a decision/answer → the tool re-runs and reports it back,
 *         and the run continues to a final answer.
 *   - Be FAIL-SAFE omitted when there is no workflow storage to resume it.
 * Plan mode must OMIT edit/execute tools from the live Agent while keeping the
 * suspending tools.
 *
 * Lives in its OWN file (not bundled with mastra-tool-execution.spec.ts) so the
 * heavy real-PGlite suspend/resume runs are isolated from the env-mutating stall
 * tests there — see the header of mastra-tool-approval-suspend.spec.ts.
 */
import { ReadableStream } from 'node:stream/web';
import type { LanguageModelV2, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import { createTool } from '@mastra/core/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PgliteDatabase, PgliteMastraMemoryOptions } from '../pglite-mastra-memory';
import type { StreamChunk } from '../types';

const { modelHolder, delegationConfigSpy } = vi.hoisted(() => ({
  delegationConfigSpy: vi.fn(),
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
    getDefaultModel: () => 'fake-model',
  };
});

// Spy on the delegation-config factory WITHOUT changing its behavior, so we can
// prove the safety rails (caps + unknown-persona rejection) are wired into the
// suspend/resume leg — a delegation on a resumed run must never run uncapped.
vi.mock('../mastra/subagent-delegation', async (importActual) => {
  const actual = await importActual<typeof import('../mastra/subagent-delegation')>();
  return {
    ...actual,
    createDelegationConfig: (params: Parameters<typeof actual.createDelegationConfig>[0]) => {
      delegationConfigSpy();
      return actual.createDelegationConfig(params);
    },
  };
});

const { streamMastraAgent, streamMastraToolApprovalAction, streamMastraToolResumeAction } =
  await import('../mastra/agent-runtime');
const { createPgliteMastraMemory } = await import('../pglite-mastra-memory');
const { createSubmitPlanTool } = await import('../tools/submit-plan-tool');
const { createAskUserTool } = await import('../tools/ask-user-tool');
const { buildNativeToolRiskMap } = await import('@brainstrike/assistant-contract/tool-metadata');
type AssistantPersonaDefinition =
  import('@brainstrike/assistant-contract/personas').AssistantPersonaDefinition;

function makeGrepTool() {
  return createTool({
    description: 'Search the workspace for a pattern.',
    execute: () => Promise.resolve({ files: [] }),
    id: 'brainstrike.grepSearch',
    inputSchema: z.object({ pattern: z.string() }),
    outputSchema: z.object({ files: z.array(z.string()) }),
  });
}

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

// A minimal read-only persona whose single tool (grepSearch) is registered in
// the run below, so the persona actually registers a delegation tool.
const testPersona: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.grepSearch'],
  description: 'Explore the workspace and report findings.',
  id: 'explore',
  instructions: 'You are the Explorer subagent.',
  label: 'Explorer',
  maxSteps: 8,
};

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

function makeMemory(database: PGlite) {
  const options: PgliteMastraMemoryOptions = {
    database: database as unknown as PgliteDatabase,
  };
  return createPgliteMastraMemory(options);
}

function findSuspendChunk(chunks: StreamChunk[]) {
  return chunks.find(
    (chunk): chunk is Extract<StreamChunk, { type: 'tool-suspend-required' }> =>
      chunk.type === 'tool-suspend-required'
  );
}

function findApprovalChunk(chunks: StreamChunk[]) {
  return chunks.find(
    (chunk): chunk is Extract<StreamChunk, { type: 'tool-approval-required' }> =>
      chunk.type === 'tool-approval-required'
  );
}

function toolSuccessOutputs(chunks: StreamChunk[]): string {
  return chunks
    .filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'tool-event' }> =>
        chunk.type === 'tool-event' && chunk.status === 'success'
    )
    .map((chunk) => JSON.stringify(chunk.payload))
    .join(' ');
}

function finalText(chunks: StreamChunk[]): string {
  return chunks
    .filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta'
    )
    .map((chunk) => chunk.value)
    .join('');
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

const SUBMIT_PLAN_INPUT = JSON.stringify({
  overview: 'Refactor the parser for clarity.',
  steps: [{ title: 'Read the parser' }, { detail: 'carefully', title: 'Rewrite the tokenizer' }],
  title: 'Parser refactor',
});

describe('suspending tools pause and resume (real @mastra/core/agent + real PGlite)', () => {
  beforeEach(() => {
    modelHolder.current = undefined;
  });

  // The heaviest case in this suite (fresh PGlite + memory + full
  // suspend/approve/resume roundtrip): observed 45s+ under CI parallel load
  // (PR #1682 run 29515911801), breaching the suite-wide 30s timeout.
  it('submitPlan SUSPENDS with the plan payload, then APPROVE re-runs it and the run continues', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const thread = { resourceId: 'resource-plan-1', threadId: 'thread-plan-1' } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Proceeding with the approved plan.',
      input: SUBMIT_PLAN_INPUT,
      toolCallId: 'call-plan-1',
      toolName: 'brainstrike_submitPlan',
    });

    const suspendIterator = await streamMastraAgent(
      [{ id: 'u-plan-1', parts: [{ text: 'make a plan', type: 'text' }], role: 'user' }],
      {
        memory,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          provider: 'openai',
        },
        storage,
        tools: { 'brainstrike.submitPlan': createSubmitPlanTool() },
      }
    );
    const suspendChunks = await drainYielding(suspendIterator);

    const suspend = findSuspendChunk(suspendChunks);
    expect(suspend).toBeDefined();
    expect(suspend?.toolName).toBe('brainstrike.submitPlan');
    expect(suspend?.runId).toBeTruthy();
    expect(suspend?.toolCallId).toBeTruthy();
    expect(suspend?.suspendPayload).toMatchObject({
      overview: 'Refactor the parser for clarity.',
      title: 'Parser refactor',
    });
    // The pause is a tool-calls finish, NOT an error finish.
    expect(
      suspendChunks.find(
        (chunk) => chunk.type === 'message-finish' && chunk.finishReason === 'tool-calls'
      )
    ).toBeDefined();

    const resumeIterator = await streamMastraToolResumeAction(
      {
        resumeData: { action: 'approved' },
        runId: suspend?.runId ?? '',
        toolCallId: suspend?.toolCallId ?? '',
        toolName: 'brainstrike.submitPlan',
      },
      {
        memory,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          provider: 'openai',
        },
        storage,
        tools: { 'brainstrike.submitPlan': createSubmitPlanTool() },
      }
    );
    const resumeChunks = await drainYielding(resumeIterator);

    // The tool re-ran and reported the approval; the run reached its final answer.
    expect(toolSuccessOutputs(resumeChunks)).toContain('approved');
    expect(finalText(resumeChunks)).toContain('Proceeding with the approved plan.');
    expect(resumeChunks.find((chunk) => chunk.type === 'message-finish')).toBeDefined();

    await database.close();
  }, 120_000);

  it('REJECT-with-feedback re-runs submitPlan and the feedback reaches the tool result', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const thread = { resourceId: 'resource-plan-2', threadId: 'thread-plan-2' } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Revising the plan.',
      input: SUBMIT_PLAN_INPUT,
      toolCallId: 'call-plan-2',
      toolName: 'brainstrike_submitPlan',
    });

    const suspendIterator = await streamMastraAgent(
      [{ id: 'u-plan-2', parts: [{ text: 'make a plan', type: 'text' }], role: 'user' }],
      {
        memory,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          provider: 'openai',
        },
        storage,
        tools: { 'brainstrike.submitPlan': createSubmitPlanTool() },
      }
    );
    const suspend = findSuspendChunk(await drainYielding(suspendIterator));
    expect(suspend).toBeDefined();

    const resumeIterator = await streamMastraToolResumeAction(
      {
        resumeData: { action: 'rejected', feedback: 'tighten step 2' },
        runId: suspend?.runId ?? '',
        toolCallId: suspend?.toolCallId ?? '',
      },
      {
        memory,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          provider: 'openai',
        },
        storage,
        tools: { 'brainstrike.submitPlan': createSubmitPlanTool() },
      }
    );
    const resumeChunks = await drainYielding(resumeIterator);

    const outputs = toolSuccessOutputs(resumeChunks);
    expect(outputs).toContain('rejected');
    expect(outputs).toContain('tighten step 2');

    await database.close();
  });

  it('askUser SUSPENDS then resumes with a free-text answer, and again with a multi-select array', async () => {
    // Free-text.
    const dbA = new PGlite();
    const memA = await makeMemory(dbA);
    const threadA = { resourceId: 'resource-ask-1', threadId: 'thread-ask-1' } as const;
    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Thanks.',
      input: JSON.stringify({ question: 'Which city?' }),
      toolCallId: 'call-ask-1',
      toolName: 'brainstrike_askUser',
    });
    const askSuspend = findSuspendChunk(
      await drainYielding(
        await streamMastraAgent(
          [{ id: 'u-ask-1', parts: [{ text: 'ask me', type: 'text' }], role: 'user' }],
          {
            memory: memA.memory,
            runtime: {
              apiKey: 'test-key',
              memory: { resourceId: threadA.resourceId, threadId: threadA.threadId },
              provider: 'openai',
            },
            storage: memA.storage,
            tools: { 'brainstrike.askUser': createAskUserTool() },
          }
        )
      )
    );
    expect(askSuspend?.toolName).toBe('brainstrike.askUser');
    expect(askSuspend?.suspendPayload).toMatchObject({ question: 'Which city?' });
    const freeResume = await drainYielding(
      await streamMastraToolResumeAction(
        {
          resumeData: 'San Francisco',
          runId: askSuspend?.runId ?? '',
          toolCallId: askSuspend?.toolCallId ?? '',
        },
        {
          memory: memA.memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: threadA.resourceId, threadId: threadA.threadId },
            provider: 'openai',
          },
          storage: memA.storage,
          tools: { 'brainstrike.askUser': createAskUserTool() },
        }
      )
    );
    expect(toolSuccessOutputs(freeResume)).toContain('San Francisco');
    await dbA.close();

    // Multi-select array → comma-joined.
    const dbB = new PGlite();
    const memB = await makeMemory(dbB);
    const threadB = { resourceId: 'resource-ask-2', threadId: 'thread-ask-2' } as const;
    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Thanks.',
      input: JSON.stringify({
        options: [{ label: 'a' }, { label: 'b' }],
        question: 'Pick',
        selectionMode: 'multi_select',
      }),
      toolCallId: 'call-ask-2',
      toolName: 'brainstrike_askUser',
    });
    const multiSuspend = findSuspendChunk(
      await drainYielding(
        await streamMastraAgent(
          [{ id: 'u-ask-2', parts: [{ text: 'ask me', type: 'text' }], role: 'user' }],
          {
            memory: memB.memory,
            runtime: {
              apiKey: 'test-key',
              memory: { resourceId: threadB.resourceId, threadId: threadB.threadId },
              provider: 'openai',
            },
            storage: memB.storage,
            tools: { 'brainstrike.askUser': createAskUserTool() },
          }
        )
      )
    );
    const multiResume = await drainYielding(
      await streamMastraToolResumeAction(
        {
          resumeData: ['a', 'b'],
          runId: multiSuspend?.runId ?? '',
          toolCallId: multiSuspend?.toolCallId ?? '',
        },
        {
          memory: memB.memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: threadB.resourceId, threadId: threadB.threadId },
            provider: 'openai',
          },
          storage: memB.storage,
          tools: { 'brainstrike.askUser': createAskUserTool() },
        }
      )
    );
    expect(toolSuccessOutputs(multiResume)).toContain('a, b');
    await dbB.close();
  });

  it('FAIL-SAFE: without storage submitPlan is omitted from the Agent and resume throws', async () => {
    const database = new PGlite();
    const submitExecute = vi.fn();
    // A suspend tool whose execute we can spy: prove it is NEVER invoked when the
    // model tries to call it without storage (the tool was omitted from the map).
    const spyPlanTool = createTool({
      description: 'plan',
      execute: submitExecute,
      id: 'brainstrike.submitPlan',
      inputSchema: z.object({ title: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      resumeSchema: z.object({ action: z.enum(['approved', 'rejected']) }),
      suspendSchema: z.object({ title: z.string() }),
    });

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Cannot plan without storage.',
      input: JSON.stringify({ title: 'x' }),
      toolCallId: 'call-nostore-1',
      toolName: 'brainstrike_submitPlan',
    });

    // No `storage` in options → the suspend tool is fail-safe omitted.
    const chunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-ns-1', parts: [{ text: 'make a plan', type: 'text' }], role: 'user' }],
        {
          runtime: { apiKey: 'test-key', provider: 'openai' },
          tools: { 'brainstrike.submitPlan': spyPlanTool },
        }
      )
    );
    expect(submitExecute).not.toHaveBeenCalled();
    expect(findSuspendChunk(chunks)).toBeUndefined();

    // A direct resume without storage throws the typed error.
    await expect(
      streamMastraToolResumeAction(
        { resumeData: { action: 'approved' }, runId: 'r', toolCallId: 't' },
        { runtime: { apiKey: 'test-key', provider: 'openai' } }
      )
    ).rejects.toThrow(/workflow storage is required/i);

    await database.close();
  });

  it('PLAN MODE keeps submitPlan callable but OMITS the edit tool from the live Agent', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const writeExecute = vi.fn(() => Promise.resolve({ ok: true }));
    const writeTool = createTool({
      description: 'An edit-risk write tool.',
      execute: writeExecute,
      id: 'brainstrike.writeWorkspaceFile',
      inputSchema: z.object({ content: z.string(), path: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
    });

    // ── Plan mode drops the edit tool: the model tries to call it, but it is not
    //    in the Agent's map, so its execute is NEVER reached. ──
    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'I can only plan right now.',
      input: JSON.stringify({ content: 'hi', path: 'a.txt' }),
      toolCallId: 'call-pm-write',
      toolName: 'brainstrike_writeWorkspaceFile',
    });
    const dropChunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-pm-1', parts: [{ text: 'write a file', type: 'text' }], role: 'user' }],
        {
          memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: 'resource-pm-1', threadId: 'thread-pm-1' },
            planMode: true,
            provider: 'openai',
          },
          storage,
          tools: {
            'brainstrike.submitPlan': createSubmitPlanTool(),
            'brainstrike.writeWorkspaceFile': writeTool,
          },
        }
      )
    );
    expect(writeExecute).not.toHaveBeenCalled();
    expect(dropChunks.find((chunk) => chunk.type === 'message-finish')).toBeDefined();

    // ── submitPlan survives plan-mode filtering and still suspends. ──
    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Plan submitted.',
      input: SUBMIT_PLAN_INPUT,
      toolCallId: 'call-pm-plan',
      toolName: 'brainstrike_submitPlan',
    });
    const planChunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-pm-2', parts: [{ text: 'make a plan', type: 'text' }], role: 'user' }],
        {
          memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: 'resource-pm-2', threadId: 'thread-pm-2' },
            planMode: true,
            provider: 'openai',
          },
          storage,
          tools: {
            'brainstrike.submitPlan': createSubmitPlanTool(),
            'brainstrike.writeWorkspaceFile': writeTool,
          },
        }
      )
    );
    expect(findSuspendChunk(planChunks)?.toolName).toBe('brainstrike.submitPlan');

    await database.close();
  });

  it('O4: an ENFORCED permission policy does NOT double-gate submitPlan (it suspends, never asks approval)', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const thread = { resourceId: 'resource-o4', threadId: 'thread-o4' } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Plan submitted.',
      input: SUBMIT_PLAN_INPUT,
      toolCallId: 'call-o4-plan',
      toolName: 'brainstrike_submitPlan',
    });

    // A real enforced snapshot with the SERVER-built risk map: submitPlan is
    // classified 'read', which resolves to 'allow', so the permission gate must
    // NOT clone it with requireApproval. Its own suspend() is the only gate.
    const chunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-o4', parts: [{ text: 'make a plan', type: 'text' }], role: 'user' }],
        {
          memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: {
              policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
              riskByTool: buildNativeToolRiskMap(),
              yolo: false,
            },
            provider: 'openai',
          },
          storage,
          tools: { 'brainstrike.submitPlan': createSubmitPlanTool() },
        }
      )
    );

    expect(findSuspendChunk(chunks)?.toolName).toBe('brainstrike.submitPlan');
    // NEVER double-gated: no approval-required chunk was emitted.
    expect(findApprovalChunk(chunks)).toBeUndefined();

    await database.close();
  });

  it('BOTH FLAGS: a read:ask policy clones submitPlan with requireApproval AND it keeps suspendSchema — the two transports compose serially (approval → suspend → resume) without deadlock or lost suspension', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const thread = { resourceId: 'resource-both', threadId: 'thread-both' } as const;

    // read:'ask' forces the permission gate to CLONE submitPlan (risk 'read')
    // with per-tool requireApproval. The clone preserves suspendSchema, so the
    // tool now carries BOTH transports.
    const policy = {
      policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'ask' },
      riskByTool: buildNativeToolRiskMap(),
      yolo: false,
    } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Proceeding with the approved plan.',
      input: SUBMIT_PLAN_INPUT,
      toolCallId: 'call-both-plan',
      toolName: 'brainstrike_submitPlan',
    });

    // ── Phase 1: the permission APPROVAL transport fires FIRST (before execute,
    //    so no suspend yet). ──
    const approvalChunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-both', parts: [{ text: 'make a plan', type: 'text' }], role: 'user' }],
        {
          memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: policy,
            provider: 'openai',
          },
          storage,
          tools: { 'brainstrike.submitPlan': createSubmitPlanTool() },
        }
      )
    );
    const approval = findApprovalChunk(approvalChunks);
    expect(approval?.toolName).toBe('brainstrike.submitPlan');
    expect(approval?.policyDecision).toBe('ask');
    // Approval gate fired before execute → no suspension payload yet.
    expect(findSuspendChunk(approvalChunks)).toBeUndefined();

    // ── Phase 2: APPROVE the tool call → execute() runs → the tool's own
    //    suspend() fires (the SUSPEND transport), no deadlock, no lost pause. ──
    const suspendChunks = await drainYielding(
      await streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: approval?.runId ?? '',
          toolCallId: approval?.toolCallId ?? '',
          toolName: 'brainstrike.submitPlan',
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
          tools: { 'brainstrike.submitPlan': createSubmitPlanTool() },
        }
      )
    );
    const suspend = findSuspendChunk(suspendChunks);
    expect(suspend?.toolName).toBe('brainstrike.submitPlan');
    expect(suspend?.suspendPayload).toMatchObject({ title: 'Parser refactor' });

    // ── Phase 3: resume the SUSPEND with the plan decision → the tool re-runs
    //    and the run reaches its final answer. ──
    const resumeChunks = await drainYielding(
      await streamMastraToolResumeAction(
        {
          resumeData: { action: 'approved' },
          runId: suspend?.runId ?? '',
          toolCallId: suspend?.toolCallId ?? '',
          toolName: 'brainstrike.submitPlan',
        },
        {
          memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: policy,
            provider: 'openai',
          },
          storage,
          tools: { 'brainstrike.submitPlan': createSubmitPlanTool() },
        }
      )
    );
    // No lost suspension: resuming reached the FINAL answer (the model saw the
    // approved plan result and proceeded), and the run finished cleanly — no
    // deadlock, no error finish. (On this double-gated path Mastra folds the
    // resumed tool result into the model turn rather than re-emitting a
    // standalone tool-event; the final text is the authoritative proof.)
    expect(finalText(resumeChunks)).toContain('Proceeding with the approved plan.');
    expect(
      resumeChunks.find((chunk) => chunk.type === 'message-finish' && chunk.finishReason === 'stop')
    ).toBeDefined();

    await database.close();
  });

  it('STALE resume: a nonexistent runId with real storage surfaces a typed error / visible error finish and never hangs', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    // The scripted model MUST be configured (mirrors the sibling tests above):
    // without it, `createProvider` throws the harness sentinel
    // (`mastra_agent_runtime_init_failed: test fake model was not configured`)
    // at Agent construction — BEFORE Mastra's own snapshot lookup ever runs —
    // and the assertions below would pass without ever exercising a stale
    // resume. It is unused by this test (the resume is rejected by Mastra's
    // snapshot lookup before any model call), but the runtime still
    // constructs the Agent eagerly and requires one.
    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'unused',
      input: JSON.stringify({ title: 'x' }),
      toolCallId: 'call-stale-1',
      toolName: 'brainstrike_submitPlan',
    });

    // A bounded attempt: either the resume PROMISE rejects with a typed error,
    // or it yields a visible error finish — but it must resolve one way or the
    // other (never hang). The race guards against a wedge.
    const attempt: Promise<{
      kind: 'error-finish' | 'rejected' | 'silent';
      message?: string;
    }> = (async () => {
      try {
        const iterator = await streamMastraToolResumeAction(
          {
            resumeData: { action: 'approved' },
            runId: 'nonexistent-run-id',
            toolCallId: 'nonexistent-call-id',
            toolName: 'brainstrike.submitPlan',
          },
          {
            memory,
            runtime: {
              apiKey: 'test-key',
              memory: { resourceId: 'resource-stale', threadId: 'thread-stale' },
              provider: 'openai',
            },
            storage,
            tools: { 'brainstrike.submitPlan': createSubmitPlanTool() },
          }
        );
        const chunks = await drainYielding(iterator);
        const hasErrorFinish = chunks.some(
          (chunk) => chunk.type === 'message-finish' && chunk.finishReason === 'error'
        );
        return { kind: hasErrorFinish ? 'error-finish' : 'silent' } as const;
      } catch (err) {
        return {
          kind: 'rejected' as const,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    })();

    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('stale resume hung')), 15_000);
    });
    const result = await Promise.race([attempt, timeout]);
    // Never a silent success: a stale/nonexistent run must be surfaced.
    expect(result.kind === 'rejected' || result.kind === 'error-finish').toBe(true);
    if (result.kind === 'rejected') {
      const message = result.message ?? '';
      // Guards against the vacuous-test regression: the harness sentinel for a
      // misconfigured scripted model must never masquerade as Mastra's real
      // stale-snapshot rejection (verified: with `modelHolder.current` unset,
      // this is exactly what surfaces — "mastra_agent_runtime_init_failed:
      // test fake model was not configured" — well before Mastra's snapshot
      // lookup runs).
      expect(message).not.toContain('test fake model');
      // The real Mastra rejection: `Agent.resumeStream`'s snapshot lookup
      // throws a MastraError naming the missing/invalid run (surfaced here as
      // `mastra_agent_stream_failure: Agent "..." resumeStream() could not
      // find a suspended run for runId "...". ... invalid ...`).
      expect(message).toMatch(/snapshot|not.?found|resume|suspend/i);
    }

    await database.close();
  });

  it('RESUME keeps the delegation safety rails: the resumed leg builds the per-run delegation config when personas are registered', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const thread = {
      resourceId: 'resource-resume-deleg',
      threadId: 'thread-resume-deleg',
    } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Thanks.',
      input: JSON.stringify({ question: 'Which city?' }),
      toolCallId: 'call-ask-deleg',
      toolName: 'brainstrike_askUser',
    });

    const runOptions = {
      memory,
      personas: [testPersona],
      runtime: {
        apiKey: 'test-key',
        memory: { resourceId: thread.resourceId, threadId: thread.threadId },
        provider: 'openai',
      },
      storage,
      tools: {
        'brainstrike.askUser': createAskUserTool(),
        'brainstrike.grepSearch': makeGrepTool(),
      },
    } as const;

    const askSuspend = findSuspendChunk(
      await drainYielding(
        await streamMastraAgent(
          [{ id: 'u-resume-deleg', parts: [{ text: 'ask me', type: 'text' }], role: 'user' }],
          runOptions
        )
      )
    );
    expect(askSuspend?.toolName).toBe('brainstrike.askUser');
    // The initial leg built the delegation config (personas were registered).
    expect(delegationConfigSpy).toHaveBeenCalled();

    // Isolate the resume leg: only a resumed run that re-applies the rails
    // re-invokes the factory. Without the fix the resume options omit the
    // `delegation` spread and this spy is never called on resume.
    delegationConfigSpy.mockClear();

    await drainYielding(
      await streamMastraToolResumeAction(
        {
          resumeData: 'San Francisco',
          runId: askSuspend?.runId ?? '',
          toolCallId: askSuspend?.toolCallId ?? '',
        },
        runOptions
      )
    );
    expect(delegationConfigSpy).toHaveBeenCalled();

    await database.close();
  });
});
