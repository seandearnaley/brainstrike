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
    getDefaultModel: (provider: string) =>
      ({
        anthropic: 'claude-sonnet-5',
        google: 'gemini-3.5-flash',
        local: 'onnx-community/gemma-4-E2B-it-ONNX',
        openrouter: 'openai/gpt-5.6-terra',
      })[provider] ?? 'gpt-5.6-terra',
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
  await import('../mastra/agent-streaming');
const { listSuspendedMastraRuns } = await import('../mastra/suspended-run-discovery');
const { createPgliteMastraMemory } = await import('../pglite-mastra-memory');
const { createSubmitPlanTool } = await import('../tools/submit-plan-tool');
const { createAskUserTool } = await import('../tools/ask-user-tool');
const { createRunPythonTool } = await import('../tools/run-python-tool');
const { resolveSelfApprovalDecision } = await import('../mastra/permission-tool-gate');
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
  stallAfterToolResultText?: string;
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
 * Discovery-then-tool scripted model (the approval spec's idiom): turn 1 loads
 * the deferred tool via `search_tools`, turn 2 calls it, turn 3 emits final
 * text. Needed for any tool in a DEFERRED discovery namespace (run_python's
 * `execution`): calling one without loading it first is ToolNotFoundError by
 * design.
 */
function createDiscoveryThenSuspendModel(args: {
  deferredInput: string;
  deferredToolCallId: string;
  deferredToolName: string;
  finalText: string;
  searchQuery: string;
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
              input: JSON.stringify({ query: args.searchQuery }),
              toolCallId: 'call-search-before-suspend',
              toolName: 'search_tools',
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
              input: args.deferredInput,
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

function runEventKinds(chunks: StreamChunk[]): string[] {
  return chunks
    .filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
    )
    .map((chunk) => chunk.event.kind);
}

/**
 * A suspending tool that is deliberately NOT in
 * `REGISTERED_SUSPEND_RESUME_TOOL_IDS` — the exact shape BST-558 is about. It
 * suspends through the same `context.agent.suspend` contract askUser uses, so
 * the Mastra-level pause is identical to a registered one; only the
 * client-side registry lookup differs.
 */
function makeUnregisteredSuspendingTool() {
  return createTool({
    description: 'Pauses the run with a question this build has no typed UI for.',
    execute: async (
      _input: { topic: string },
      context?: { agent?: { suspend?: (payload: unknown) => Promise<unknown> } }
    ) => {
      await context?.agent?.suspend?.({ question: 'why?' });
      return;
    },
    id: 'brainstrike.someFutureSuspendingTool',
    inputSchema: z.object({ topic: z.string() }),
    outputSchema: z.object({ answered: z.boolean() }),
    resumeSchema: z.object({ answer: z.string() }),
    suspendSchema: z.object({ question: z.string() }),
  } as never);
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

  it('persists completed tool work when a user cancels a suspended-tool resume stream', async () => {
    const abortController = new AbortController();
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const thread = {
      resourceId: 'resource-tool-resume-cancel',
      threadId: 'thread-tool-resume-cancel',
    };

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'unused',
      input: SUBMIT_PLAN_INPUT,
      stallAfterToolResultText: 'This incomplete suspended-resume answer must not be remembered.',
      toolCallId: 'call-tool-resume-cancel',
      toolName: 'brainstrike_submitPlan',
    });

    const suspend = findSuspendChunk(
      await drainYielding(
        await streamMastraAgent(
          [
            {
              id: 'user-tool-resume-cancel',
              parts: [{ text: 'make a plan', type: 'text' }],
              role: 'user',
            },
          ],
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
        )
      )
    );
    expect(suspend).toBeDefined();

    await drainYielding(
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
            provider: 'openai',
            signal: abortController.signal,
          },
          storage,
          tools: { 'brainstrike.submitPlan': createSubmitPlanTool() },
        }
      ),
      (chunk) => {
        if (chunk.type === 'tool-event' && chunk.status === 'success') {
          abortController.abort(new Error('user stopped suspended-tool resume'));
        }
      }
    );

    const persisted = await database.query<{ content: unknown }>(
      'SELECT content FROM mastra_messages WHERE thread_id = $1 ORDER BY "createdAt" ASC',
      [thread.threadId]
    );
    const persistedRecord = JSON.stringify(persisted.rows);
    expect(persistedRecord).toContain('approved');
    expect(persistedRecord.toLowerCase()).toContain('aborted before completion');
    expect(persistedRecord).not.toContain(
      'This incomplete suspended-resume answer must not be remembered.'
    );

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

  it('askUser SUSPENDS then resumes with a free-text {answer} envelope, and again with a LEGACY multi-select array', async () => {
    // Free-text, via the canonical {answer} envelope (what the notice sends):
    // proves REAL Mastra resumeSchema validation admits the envelope arm.
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
          resumeData: { answer: 'San Francisco' },
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

    // Multi-select array → comma-joined — resumed with the LEGACY bare
    // string[] shape on purpose: proves real Mastra validation still admits
    // the pre-envelope arm, so runs suspended before the migration resume.
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

  it("ASK-GATED askUser: the user's answer reaches execute() through the {answer} envelope — the scenario the envelope migration exists for", async () => {
    // THE proof for the envelope migration. Under read:'ask' the permission
    // gate clones askUser with requireApproval, so @mastra/core 1.56+ re-checks
    // approval on the RESUME leg too and the transport attaches the
    // `approved: true` rider. Every other askUser test here runs UN-gated (no
    // permissionPolicy ⇒ no rider), so none of them exercise this path, and
    // the mock rider test in mastra-tool-approval-chunks.spec.ts can only see
    // what we hand to resumeStream, not Mastra's verdict on it.
    //
    // The assertion is deliberately at the EXECUTOR (toolSuccessOutputs), never
    // final text: the scripted model emits its text whether the tool saw the
    // answer, a denial, or a re-raised suspension, which is exactly how a
    // vacuous green ships.
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const thread = { resourceId: 'resource-ask-gated', threadId: 'thread-ask-gated' } as const;
    const policy = {
      policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'ask' },
      riskByTool: buildNativeToolRiskMap(),
      yolo: false,
    } as const;

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Thanks.',
      input: JSON.stringify({ question: 'Which city?' }),
      toolCallId: 'call-ask-gated',
      toolName: 'brainstrike_askUser',
    });

    const runOptions = {
      memory,
      runtime: {
        apiKey: 'test-key',
        memory: { resourceId: thread.resourceId, threadId: thread.threadId },
        permissionPolicy: policy,
        provider: 'openai',
      },
      storage,
      tools: { 'brainstrike.askUser': createAskUserTool() },
    } as const;

    // ── Phase 1: the pre-execution approval gate fires (askUser is risk
    //    'read', which this policy gates to 'ask') — execute() has not run. ──
    const approvalChunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-ask-gated', parts: [{ text: 'ask me', type: 'text' }], role: 'user' }],
        runOptions
      )
    );
    const approval = findApprovalChunk(approvalChunks);
    expect(approval?.toolName).toBe('brainstrike.askUser');
    expect(findSuspendChunk(approvalChunks)).toBeUndefined();

    // ── Phase 2: approve → execute() runs → askUser raises its own pause. ──
    const suspendChunks = await drainYielding(
      await streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: approval?.runId ?? '',
          toolCallId: approval?.toolCallId ?? '',
          toolName: 'brainstrike.askUser',
        },
        { ...runOptions, requireToolApproval: true }
      )
    );
    const suspend = findSuspendChunk(suspendChunks);
    expect(suspend?.toolName).toBe('brainstrike.askUser');
    expect(suspend?.suspendPayload).toMatchObject({ question: 'Which city?' });

    // ── Phase 3: answer it with the envelope. The tool must RETURN the answer,
    //    not be denied and not be re-invoked as a fresh call (which would
    //    re-ask the same question forever). ──
    const answerChunks = await drainYielding(
      await streamMastraToolResumeAction(
        {
          resumeData: { answer: 'San Francisco' },
          runId: suspend?.runId ?? '',
          toolCallId: suspend?.toolCallId ?? '',
          toolName: 'brainstrike.askUser',
        },
        runOptions
      )
    );
    expect(toolSuccessOutputs(answerChunks)).toContain('San Francisco');
    // Not denied, and not re-asked: a fresh invocation would raise the pause again.
    expect(findSuspendChunk(answerChunks)).toBeUndefined();

    await database.close();
  });

  it('RESTART (BST-1084): listSuspendedMastraRuns rediscovers a suspend() pause WITH its payload, and a FRESH runtime resumes it', async () => {
    // The suspend-side twin of the approval RESTART proof. Phase 1 suspends an
    // askUser over `database`. Phase 2 simulates a process restart — a
    // brand-new memory/storage/Agent over the SAME PGlite DB rediscovers the
    // pause via the KEYLESS listing route (the exact desktop /suspended-runs
    // shape), including the tool-defined suspendPayload recovered from the
    // durable snapshot — the fact that makes the rediscovered notice able to
    // render the real question instead of a placeholder. Phase 3 feeds the
    // discovered runId+toolCallId into a fresh streamMastraToolResumeAction
    // and the answer reaches the tool.
    const database = new PGlite();
    const thread = { resourceId: 'resource-susp-rst-1', threadId: 'thread-susp-rst-1' } as const;
    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'Thanks after restart.',
      input: JSON.stringify({ question: 'Which region?' }),
      toolCallId: 'call-ask-restart-susp-1',
      toolName: 'brainstrike_askUser',
    });

    // ── Phase 1: SUSPEND (first "process") ──
    const firstBoot = await makeMemory(database);
    const liveSuspend = findSuspendChunk(
      await drainYielding(
        await streamMastraAgent(
          [{ id: 'u-susp-rst-1', parts: [{ text: 'ask me', type: 'text' }], role: 'user' }],
          {
            memory: firstBoot.memory,
            runtime: {
              apiKey: 'test-key',
              memory: { resourceId: thread.resourceId, threadId: thread.threadId },
              provider: 'openai',
            },
            storage: firstBoot.storage,
            tools: { 'brainstrike.askUser': createAskUserTool() },
          }
        )
      )
    );
    expect(liveSuspend?.toolName).toBe('brainstrike.askUser');

    // ── Phase 2: RESTART SIMULATION — keyless discovery over the same DB ──
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
    // The pause lands in `suspends`, NEVER in `approvals` — misclassifying it
    // as an approval would offer Approve/Decline for a question.
    expect(discovery.approvals).toHaveLength(0);
    expect(discovery.suspends).toHaveLength(1);
    const rediscovered = discovery.suspends[0];
    expect(rediscovered?.runId).toBe(liveSuspend?.runId);
    expect(rediscovered?.toolCallId).toBe(liveSuspend?.toolCallId);
    // The ORIGINAL dotted name, mapped through the KEYLESS route's static
    // native reverse map (no tools are registered on the listing runtime).
    expect(rediscovered?.toolName).toBe('brainstrike.askUser');
    // The durable snapshot carries the tool-defined payload.
    expect(rediscovered?.suspendPayload).toMatchObject({ question: 'Which region?' });
    expect(Number.isNaN(Date.parse(rediscovered?.suspendedAt ?? 'x'))).toBe(false);

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
    expect(emptyDiscovery.suspends).toHaveLength(0);

    // ── Phase 3: RESUME from a THIRD fresh runtime with the discovered ids ──
    const thirdBoot = await makeMemory(database);
    const resumeChunks = await drainYielding(
      await streamMastraToolResumeAction(
        {
          resumeData: { answer: 'EU West' },
          runId: rediscovered?.runId ?? '',
          toolCallId: rediscovered?.toolCallId ?? '',
          toolName: rediscovered?.toolName ?? '',
        },
        {
          memory: thirdBoot.memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            provider: 'openai',
          },
          storage: thirdBoot.storage,
          tools: { 'brainstrike.askUser': createAskUserTool() },
        }
      )
    );
    expect(toolSuccessOutputs(resumeChunks)).toContain('EU West');
    expect(resumeChunks.find((chunk) => chunk.type === 'message-finish')).toBeDefined();

    await database.close();
  });

  it('GATE B (BST-1070): run_python SUSPENDS with the domain payload; DENY yields network_denied; ALLOW executes with exactly the granted domains', async () => {
    // The full Mastra transport proof for the network escalation, with the
    // EXECUTOR stubbed through the tool's own resolveHost seam so the policy
    // that reaches the sandbox is captured verbatim. run_python lives in the
    // DEFERRED `execution` discovery namespace, so the scripted model mirrors
    // production: it loads the tool through `search_tools` first (the same
    // idiom as the approval spec's deferred-rehydration proof — a model that
    // skips discovery gets ToolNotFoundError, which is the discovery surface
    // working, not a suspension bug). The security property under test: no
    // executor call ever happens before an explicit allow, and the allow
    // leg's policy carries exactly the requested domains.
    const capturedPolicies: unknown[] = [];
    const stubHost = {
      fence: () => ({
        capabilities: () => ({
          languages: ['python'] as const,
          maxIsolationTier: 'os-fence' as const,
          platform: 'darwin' as const,
          supportsNetwork: true,
        }),
        dispose: async () => undefined,
        execute: (input: { policy: unknown }) => {
          capturedPolicies.push(input.policy);
          return Promise.resolve({
            exitCode: 0,
            signal: null,
            stderr: '',
            stderrOmittedBytes: 0,
            stdout: 'fetched\n',
            stdoutOmittedBytes: 0,
            timedOut: false,
          });
        },
      }),
    };
    const makeTool = () =>
      createRunPythonTool({
        // No permission policy is enforced in this test, so Gate A resolves
        // 'allow' — exactly what resolveSelfApprovalDecision(undefined, …)
        // returns in production.
        resolveApprovalDecision: () => 'allow',
        resolveHost: async () => stubHost as never,
      }) as never;

    // ── DENY leg ──
    const dbDeny = new PGlite();
    const memDeny = await makeMemory(dbDeny);
    const threadDeny = { resourceId: 'resource-gateb-1', threadId: 'thread-gateb-1' } as const;
    modelHolder.current = createDiscoveryThenSuspendModel({
      deferredInput: JSON.stringify({ allowedDomains: ['pypi.org'], code: 'print(1)' }),
      deferredToolCallId: 'call-gateb-deny-1',
      deferredToolName: 'brainstrike_runPython',
      finalText: 'Understood, staying offline.',
      searchQuery: 'run python code',
    });
    const denySuspend = findSuspendChunk(
      await drainYielding(
        await streamMastraAgent(
          [{ id: 'u-gateb-1', parts: [{ text: 'fetch it', type: 'text' }], role: 'user' }],
          {
            memory: memDeny.memory,
            runtime: {
              apiKey: 'test-key',
              memory: { resourceId: threadDeny.resourceId, threadId: threadDeny.threadId },
              provider: 'openai',
            },
            storage: memDeny.storage,
            tools: { 'brainstrike.runPython': makeTool() },
          }
        )
      )
    );
    expect(denySuspend?.toolName).toBe('brainstrike.runPython');
    expect(denySuspend?.suspendPayload).toEqual({
      allowedDomains: ['pypi.org'],
      kind: 'network',
    });
    // Suspension happened BEFORE any executor work.
    expect(capturedPolicies).toHaveLength(0);

    const denyChunks = await drainYielding(
      await streamMastraToolResumeAction(
        {
          resumeData: { action: 'deny' },
          runId: denySuspend?.runId ?? '',
          toolCallId: denySuspend?.toolCallId ?? '',
        },
        {
          memory: memDeny.memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: threadDeny.resourceId, threadId: threadDeny.threadId },
            provider: 'openai',
          },
          storage: memDeny.storage,
          tools: { 'brainstrike.runPython': makeTool() },
        }
      )
    );
    expect(toolSuccessOutputs(denyChunks)).toContain('network_denied');
    expect(capturedPolicies).toHaveLength(0);
    await dbDeny.close();

    // ── ALLOW leg ──
    const dbAllow = new PGlite();
    const memAllow = await makeMemory(dbAllow);
    const threadAllow = { resourceId: 'resource-gateb-2', threadId: 'thread-gateb-2' } as const;
    modelHolder.current = createDiscoveryThenSuspendModel({
      deferredInput: JSON.stringify({
        allowedDomains: ['pypi.org', '*.example.com'],
        code: 'print(1)',
      }),
      deferredToolCallId: 'call-gateb-allow-1',
      deferredToolName: 'brainstrike_runPython',
      finalText: 'Fetched.',
      searchQuery: 'run python code',
    });
    const allowSuspend = findSuspendChunk(
      await drainYielding(
        await streamMastraAgent(
          [{ id: 'u-gateb-2', parts: [{ text: 'fetch it', type: 'text' }], role: 'user' }],
          {
            memory: memAllow.memory,
            runtime: {
              apiKey: 'test-key',
              memory: { resourceId: threadAllow.resourceId, threadId: threadAllow.threadId },
              provider: 'openai',
            },
            storage: memAllow.storage,
            tools: { 'brainstrike.runPython': makeTool() },
          }
        )
      )
    );
    expect(allowSuspend?.suspendPayload).toEqual({
      allowedDomains: ['pypi.org', '*.example.com'],
      kind: 'network',
    });
    const allowChunks = await drainYielding(
      await streamMastraToolResumeAction(
        {
          resumeData: { action: 'allow' },
          runId: allowSuspend?.runId ?? '',
          toolCallId: allowSuspend?.toolCallId ?? '',
        },
        {
          memory: memAllow.memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: threadAllow.resourceId, threadId: threadAllow.threadId },
            provider: 'openai',
          },
          storage: memAllow.storage,
          tools: { 'brainstrike.runPython': makeTool() },
        }
      )
    );
    expect(toolSuccessOutputs(allowChunks)).toContain('completed');
    expect(capturedPolicies).toHaveLength(1);
    expect(capturedPolicies[0]).toMatchObject({
      allowedDomains: ['pypi.org', '*.example.com'],
    });
    await dbAllow.close();
  });

  // The BST-1097 live repro, asserted at the EXECUTOR level. The earlier
  // BOTH-FLAGS proof asserted only the scripted model's final text, which the
  // fake model emits regardless of what the resumed tool returned — so the
  // Gate B resume being re-denied by the approval gate ("Tool call was not
  // approved by the user") passed that test while failing every real user.
  // The only non-vacuous proof is that the sandbox actually ran.
  it('GATE A + GATE B (BST-1097): under execute:ask, approve → allow-domains actually EXECUTES the script — the Gate B resume is never re-denied by the approval gate', async () => {
    const capturedPolicies: unknown[] = [];
    const stubHost = {
      fence: () => ({
        capabilities: () => ({
          languages: ['python'] as const,
          maxIsolationTier: 'os-fence' as const,
          platform: 'darwin' as const,
          supportsNetwork: true,
        }),
        dispose: async () => undefined,
        execute: (input: { policy: unknown }) => {
          capturedPolicies.push(input.policy);
          return Promise.resolve({
            exitCode: 0,
            signal: null,
            stderr: '',
            stderrOmittedBytes: 0,
            stdout: 'fetched\n',
            stdoutOmittedBytes: 0,
            timedOut: false,
          });
        },
      }),
    };
    // read stays 'allow' so the deferred-discovery search_tools turn runs free;
    // execute:'ask' is what arms Gate A for run_python (the live posture).
    const policy = {
      policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
      riskByTool: buildNativeToolRiskMap(),
      yolo: false,
    } as const;
    const makeTool = () =>
      createRunPythonTool({
        // The REAL derivation the desktop injects: the same snapshot the
        // permission gate consumes resolves execute:'ask' → Gate A arms.
        resolveApprovalDecision: () => resolveSelfApprovalDecision(policy, 'brainstrike.runPython'),
        resolveHost: async () => stubHost as never,
      }) as never;

    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const thread = { resourceId: 'resource-bst1097', threadId: 'thread-bst1097' } as const;
    const runtime = {
      apiKey: 'test-key',
      memory: { resourceId: thread.resourceId, threadId: thread.threadId },
      permissionPolicy: policy,
      provider: 'openai',
    } as const;
    modelHolder.current = createDiscoveryThenSuspendModel({
      deferredInput: JSON.stringify({ allowedDomains: ['example.com'], code: 'print(1)' }),
      deferredToolCallId: 'call-bst1097-1',
      deferredToolName: 'brainstrike_runPython',
      finalText: 'Fetched.',
      searchQuery: 'run python code',
    });

    // ── Phase 1: Gate A — the approval pause fires, no suspension yet, and
    //    nothing has touched the executor. ──
    const phase1 = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-bst1097', parts: [{ text: 'fetch it', type: 'text' }], role: 'user' }],
        {
          memory,
          runtime,
          storage,
          tools: { 'brainstrike.runPython': makeTool() },
        }
      )
    );
    const approval = findApprovalChunk(phase1);
    expect(approval?.toolName).toBe('brainstrike.runPython');
    expect(approval?.policyDecision).toBe('ask');
    expect(approval?.riskCategory).toBe('execute');
    expect(findSuspendChunk(phase1)).toBeUndefined();
    expect(capturedPolicies).toHaveLength(0);

    // ── Phase 2: APPROVE Gate A → execute() runs → Gate B suspends with the
    //    domain payload. Still nothing has reached the executor. ──
    const phase2 = await drainYielding(
      await streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: approval?.runId ?? '',
          toolCallId: approval?.toolCallId ?? '',
          toolName: 'brainstrike.runPython',
        },
        {
          memory,
          requireToolApproval: true,
          runtime,
          storage,
          tools: { 'brainstrike.runPython': makeTool() },
        }
      )
    );
    const gateB = findSuspendChunk(phase2);
    expect(gateB?.toolName).toBe('brainstrike.runPython');
    expect(gateB?.suspendPayload).toEqual({ allowedDomains: ['example.com'], kind: 'network' });
    expect(capturedPolicies).toHaveLength(0);

    // ── Phase 3: ALLOW the domains → the script MUST run, with exactly the
    //    granted domains. Under BST-1097 this leg instead resolved as "Tool
    //    call was not approved by the user" and the executor was never
    //    reached. ──
    const phase3 = await drainYielding(
      await streamMastraToolResumeAction(
        {
          resumeData: { action: 'allow' },
          runId: gateB?.runId ?? '',
          toolCallId: gateB?.toolCallId ?? '',
        },
        {
          memory,
          runtime,
          storage,
          tools: { 'brainstrike.runPython': makeTool() },
        }
      )
    );
    expect(capturedPolicies).toHaveLength(1);
    expect(capturedPolicies[0]).toMatchObject({ allowedDomains: ['example.com'] });
    expect(toolSuccessOutputs(phase3)).toContain('completed');
    await database.close();
  }, 120_000);

  it('GATE A DECLINE (BST-1097, 1.59 idiom): declining the framework pre-execution approval settles the call with a decline terminal, never touches the executor, and the run continues', async () => {
    const capturedPolicies: unknown[] = [];
    const stubHost = {
      fence: () => ({
        capabilities: () => ({
          languages: ['python'] as const,
          maxIsolationTier: 'os-fence' as const,
          platform: 'darwin' as const,
          supportsNetwork: true,
        }),
        dispose: async () => undefined,
        execute: (input: { policy: unknown }) => {
          capturedPolicies.push(input.policy);
          return Promise.resolve({
            exitCode: 0,
            signal: null,
            stderr: '',
            stderrOmittedBytes: 0,
            stdout: '',
            stdoutOmittedBytes: 0,
            timedOut: false,
          });
        },
      }),
    };
    const policy = {
      policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
      riskByTool: buildNativeToolRiskMap(),
      yolo: false,
    } as const;
    const makeTool = () =>
      createRunPythonTool({
        resolveApprovalDecision: () => resolveSelfApprovalDecision(policy, 'brainstrike.runPython'),
        resolveHost: async () => stubHost as never,
      }) as never;

    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const thread = { resourceId: 'resource-bst1097-d', threadId: 'thread-bst1097-d' } as const;
    const runtime = {
      apiKey: 'test-key',
      memory: { resourceId: thread.resourceId, threadId: thread.threadId },
      permissionPolicy: policy,
      provider: 'openai',
    } as const;
    modelHolder.current = createDiscoveryThenSuspendModel({
      deferredInput: JSON.stringify({ code: 'print(1)' }),
      deferredToolCallId: 'call-bst1097-d1',
      deferredToolName: 'brainstrike_runPython',
      finalText: 'Understood.',
      searchQuery: 'run python code',
    });

    const phase1 = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-bst1097-d', parts: [{ text: 'run it', type: 'text' }], role: 'user' }],
        { memory, runtime, storage, tools: { 'brainstrike.runPython': makeTool() } }
      )
    );
    const approval = findApprovalChunk(phase1);
    expect(approval?.toolName).toBe('brainstrike.runPython');

    const phase2 = await drainYielding(
      await streamMastraToolApprovalAction(
        {
          action: 'decline',
          runId: approval?.runId ?? '',
          toolCallId: approval?.toolCallId ?? '',
          toolName: 'brainstrike.runPython',
        },
        {
          memory,
          requireToolApproval: true,
          runtime,
          storage,
          tools: { 'brainstrike.runPython': makeTool() },
        }
      )
    );
    // A declined pre-execution approval is FRAMEWORK-owned and never reaches
    // the tool: the executor is never touched and the run continues to its
    // final answer. @mastra/core 1.59 (BST-1282) SUPERSEDES the 1.56/1.57
    // "streams NO tool result" half of that contract — the decline leg now
    // emits `tool-output-denied` so the client can RESOLVE the pending call
    // instead of hanging forever. The one streamed tool event must therefore be
    // the DECLINE terminal: never a success, and never the ERROR terminal,
    // which would report the user's own choice as a tool failure (see
    // docs/agents/mastra-boundary.md, 1.57 → 1.59).
    expect(toolSuccessOutputs(phase2)).toBe('');
    const declineEvents = phase2.filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'tool-event' }> => chunk.type === 'tool-event'
    );
    expect(declineEvents.map((chunk) => chunk.status)).toEqual(['declined']);
    expect(declineEvents[0]?.payload).toMatchObject({ result: { kind: 'declined' } });
    expect(capturedPolicies).toHaveLength(0);
    expect(finalText(phase2)).toContain('Understood.');
    expect(phase2.find((chunk) => chunk.type === 'message-finish')).toBeDefined();
    await database.close();
  }, 120_000);

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
          resumeData: { answer: 'San Francisco' },
          runId: askSuspend?.runId ?? '',
          toolCallId: askSuspend?.toolCallId ?? '',
        },
        runOptions
      )
    );
    expect(delegationConfigSpy).toHaveBeenCalled();

    await database.close();
  });
  /**
   * BST-558 / review of PR #1977. The earlier rounds of this work were argued
   * against a SYNTHESIZED `tool-call-suspended` part, and a review round then
   * asserted (from a stale in-repo comment written against @mastra/core 1.50)
   * that the real loop reports `suspend()` through the `tool-error` path FIRST,
   * so an unregistered pause would still be recorded as a durable `tool.failed`
   * — polluting the Task Ledger and closing the tool's duration/timeline.
   *
   * This test drives the REAL loop instead of asserting either way, and pins
   * the answer: on @mastra/core 1.51 a `suspend()` emits NO `tool-error` and
   * therefore no durable `tool.failed`. If a future Mastra bump reintroduces
   * that ordering, this test fails here rather than silently re-polluting the
   * ledger — which is exactly the gap that let four green suites coexist with
   * an unproven claim.
   */
  it('an UNREGISTERED suspending tool records tool.resume.unsupported and NEVER tool.failed', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'unused',
      input: JSON.stringify({ topic: 'x' }),
      toolCallId: 'call-unregistered-1',
      toolName: 'brainstrike_someFutureSuspendingTool',
    });

    const chunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-unreg-1', parts: [{ text: 'ask me something', type: 'text' }], role: 'user' }],
        {
          memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: 'resource-unreg-1', threadId: 'thread-unreg-1' },
            provider: 'openai',
          },
          storage,
          tools: { 'brainstrike.someFutureSuspendingTool': makeUnregisteredSuspendingTool() },
        }
      )
    );

    const kinds = runEventKinds(chunks);
    // The rejection is recorded exactly once, on its own kind.
    expect(kinds.filter((kind) => kind === 'tool.resume.unsupported')).toHaveLength(1);
    // The claim the whole design rests on: nothing the ledger counts as a tool
    // call or a tool failure is recorded for this pause.
    expect(kinds).not.toContain('tool.failed');
    expect(kinds).not.toContain('tool.completed');
    // ...and no `tool-error` reached the mapper either, which is the upstream
    // fact the `tool.failed` claim depended on.
    expect(
      chunks.filter((chunk) => chunk.type === 'tool-event' && chunk.status === 'error')
    ).toHaveLength(0);
    // The pause still reaches the renderer, flagged so the mapper settles the
    // card instead of leaving a Running spinner nothing can resolve.
    const suspend = findSuspendChunk(chunks);
    expect(suspend?.toolName).toBe('brainstrike.someFutureSuspendingTool');
    expect(suspend?.resumeSupported).toBe(false);

    await database.close();
  }, 120_000);

  it('CONTROL: a REGISTERED suspending tool records no rejection and no tool.failed', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);

    modelHolder.current = createTurnCountedToolCallModel({
      finalText: 'unused',
      input: SUBMIT_PLAN_INPUT,
      toolCallId: 'call-registered-1',
      toolName: 'brainstrike_submitPlan',
    });

    const chunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-reg-1', parts: [{ text: 'make a plan', type: 'text' }], role: 'user' }],
        {
          memory,
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: 'resource-reg-1', threadId: 'thread-reg-1' },
            provider: 'openai',
          },
          storage,
          tools: { 'brainstrike.submitPlan': createSubmitPlanTool() },
        }
      )
    );

    const kinds = runEventKinds(chunks);
    expect(kinds).not.toContain('tool.resume.unsupported');
    expect(kinds).not.toContain('tool.failed');
    // Its card legitimately stays open — it really is waiting on the user.
    expect(findSuspendChunk(chunks)?.resumeSupported).toBeUndefined();

    await database.close();
  }, 120_000);
});
