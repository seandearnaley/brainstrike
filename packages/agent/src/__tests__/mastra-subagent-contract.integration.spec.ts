import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import { createLogger } from '@brainstrike/logging';
import type { PGlite } from '@electric-sql/pglite';
import {
  Agent,
  type DelegationCompleteContext,
  type DelegationConfig,
  type DelegationStartContext,
} from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { parseMemoryRequestContext } from '@mastra/core/memory';
import type { InputProcessor, OutputProcessor } from '@mastra/core/processors';
import { RequestContext } from '@mastra/core/request-context';
import { MastraCompositeStore } from '@mastra/core/storage';
import type { ChunkType } from '@mastra/core/stream';
import { createTool } from '@mastra/core/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { processMastraStreamPart } from '../mastra/agent-streaming';
import { createDelegatedConversationBinding } from '../mastra/delegated-conversation-binding';
import {
  createDelegatedRunPublicationGuard,
  type DelegatedRunIdentity,
} from '../mastra/delegated-run-publication';
import { createDelegatedStreamProjection } from '../mastra/delegated-stream-projection';
import { createDelegatedTurnPersistence } from '../mastra/delegated-turn-persistence';
import { makeDelegatedStreamTermination } from '../mastra/stream-termination';
import { createDelegationConfig } from '../mastra/subagent-delegation';
import { createTurnAttemptLifecycleState } from '../mastra/turn-attempts';
import { createPgliteMastraMemory, type PgliteDatabase } from '../pglite-mastra-memory';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
  toolThenAnswer,
} from '../test-fixtures/scripted-agent-model';
import {
  readMastraStreamPartString,
  readMastraStreamPartValue,
} from '../tool-projection/tool-event-mapper';
import { assertStaleDelegatedDecision } from './fixtures/delegated-decision-contract';
import { createPristineEngineTestDb } from './helpers/migrated-agent-test-db';

async function collect(stream: AsyncIterable<ChunkType>): Promise<ChunkType[]> {
  const chunks: ChunkType[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function initialChildMessageIdentities(chunks: readonly unknown[]): Map<string, string> {
  const observedRuns = new Map<string, string>();
  const visit = (part: unknown): void => {
    if (readMastraStreamPartString(part, 'type') !== 'tool-output') {
      return;
    }
    const nested = readMastraStreamPartValue(part, 'output');
    const runId = readMastraStreamPartString(nested, 'runId');
    if (!runId) {
      return;
    }
    if (!observedRuns.has(runId)) {
      const messageId = readMastraStreamPartString(nested, 'messageId');
      if (!messageId) {
        throw new Error('Initial native child has no message id');
      }
      observedRuns.set(runId, messageId);
    }
    visit(nested);
  };
  for (const chunk of chunks) {
    visit(chunk);
  }
  expect(observedRuns.size).toBe(2);
  return observedRuns;
}

describe('installed Mastra delegation contract (BST-1716)', () => {
  let database: PGlite;
  let backing: Awaited<ReturnType<typeof createPgliteMastraMemory>>;
  const hosts = new Set<Mastra>();

  // Adapt readonly seam parameters to PGlite's mutable parameter-array type.
  // Transactions still execute on the real driver and store, without a cast.
  function memoryDatabase(): PgliteDatabase {
    return {
      exec: (query) => database.exec(query),
      query: (query, values) => database.query(query, values ? [...values] : undefined),
      transaction: (operation) =>
        database.transaction((tx) =>
          operation({
            exec: (query) => tx.exec(query),
            query: (query, values) => tx.query(query, values ? [...values] : undefined),
          })
        ),
    };
  }

  async function shutdownHost(host: Mastra): Promise<void> {
    hosts.delete(host);
    await host.shutdown();
  }

  beforeEach(async () => {
    database = await createPristineEngineTestDb();
    backing = await createPgliteMastraMemory({
      database: memoryDatabase(),
      memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
    });
  });

  afterEach(async () => {
    const results = await Promise.allSettled([...hosts].map(shutdownHost));
    await database.close();
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Mastra fixture shutdown failed');
    }
  });

  function tree({
    requireApproval = false,
    delegation,
    childDelegation,
    childMemory = true,
    suspend = false,
    abortController,
    rootModel,
    leafModelOverride,
    childInputProcessor,
    childOutputProcessor,
    failChildInstructions = false,
  }: {
    requireApproval?: boolean;
    delegation?: DelegationConfig;
    childDelegation?: DelegationConfig;
    childMemory?: boolean;
    suspend?: boolean;
    abortController?: AbortController;
    rootModel?: ReturnType<typeof scriptedAgentModel>;
    leafModelOverride?: ReturnType<typeof scriptedAgentModel>;
    childInputProcessor?: InputProcessor;
    childOutputProcessor?: OutputProcessor;
    failChildInstructions?: boolean;
  } = {}): {
    child: Agent;
    childModel: ReturnType<typeof scriptedAgentModel>;
    childScopes: unknown[];
    effect: ReturnType<typeof vi.fn<() => Promise<{ value: string }>>>;
    host: Mastra;
    leaf: Agent;
    leafModel: ReturnType<typeof scriptedAgentModel>;
    parent: Agent;
    parentModel: ReturnType<typeof scriptedAgentModel>;
  } {
    const effect = vi.fn(() => {
      abortController?.abort();
      return Promise.resolve({ value: 'leaf result' });
    });
    const leafModel = leafModelOverride ?? toolThenAnswer('read', 'read-1', {});
    const childScopes: unknown[] = [];
    const leaf = new Agent({
      description: 'Read evidence',
      id: 'leaf',
      instructions: 'Read evidence.',
      model: leafModel.model,
      name: 'Leaf',
      ...(childMemory ? { memory: backing.memory } : {}),
      tools: {
        read: createTool({
          description: 'Read evidence',
          execute: async (_input, context) => {
            if (suspend && !context?.['agent']?.resumeData?.confirmed) {
              return context?.['agent']?.suspend({ question: 'Continue reading?' });
            }
            return effect();
          },
          id: 'read',
          inputSchema: z.object({}),
          requireApproval,
          resumeSchema: z.object({ confirmed: z.boolean() }),
        }),
      },
    });
    const childModel = toolThenAnswer('agent-leaf', 'leaf-1', { prompt: 'Read the evidence' });
    const child = new Agent({
      agents: { leaf },
      ...(childInputProcessor ? { inputProcessors: [childInputProcessor] } : {}),
      ...(childOutputProcessor ? { outputProcessors: [childOutputProcessor] } : {}),
      description: 'Delegate research',
      id: 'child',
      instructions: ({ requestContext }) => {
        if (failChildInstructions) {
          throw new Error('Child instructions failed before execution');
        }
        childScopes.push(requestContext.get('scope'));
        return 'Delegate to leaf.';
      },
      model: childModel.model,
      name: 'Child',
      ...(childMemory ? { memory: backing.memory } : {}),
      defaultOptions: { maxSteps: 4, ...(childDelegation ? { delegation: childDelegation } : {}) },
    });
    const parentModel =
      rootModel ?? toolThenAnswer('agent-child', 'child-1', { prompt: 'Find evidence' });
    const parent = new Agent({
      agents: { child },
      defaultOptions: { maxSteps: 4, ...(delegation ? { delegation } : {}) },
      id: 'parent',
      instructions: 'Delegate to child.',
      memory: backing.memory,
      model: parentModel.model,
      name: 'Parent',
    });
    const host = new Mastra({ agents: { parent }, logger: false, storage: backing.storage });
    hosts.add(host);
    return { child, childModel, childScopes, effect, host, leaf, leafModel, parent, parentModel };
  }

  it('rejects a stale leaf decision when the parent delegation call is reused', async () => {
    await assertStaleDelegatedDecision(tree);
  });

  it('fails closed when a context filter throws before the child sees parent context', async () => {
    const { parent, childModel, effect } = tree({
      delegation: {
        hookErrorStrategy: 'throw',
        messageFilter: () => {
          throw new Error('context policy failed');
        },
      },
    });
    const output = await parent.stream('PRIVATE_PARENT_CONTEXT', { maxSteps: 2 });
    const chunks = await collect(output.fullStream);
    expect(childModel.prompts).toHaveLength(0);
    expect(effect).not.toHaveBeenCalled();
    expect(JSON.stringify(chunks)).toContain('context policy failed');
  });

  it.each([true, false])(
    'exposes per-invocation identity before child publication (explicit memory=%s)',
    async (childMemory) => {
      const scopes = new Map<string, { threadId: string; resourceId: string }>();
      const parentRuns = new Map<string, string>();
      const processedRuns = new Map<string, Set<string>>();
      const publishedRuns = new Map<string, string>();
      const completions = vi.fn<(context: DelegationCompleteContext) => void>();
      const binding = createDelegatedConversationBinding(async (identity) => {
        const nativeThread = await backing.memory.getThreadById({
          threadId: identity.childThreadId,
        });
        expect(nativeThread?.resourceId).toBe(identity.childResourceId);
        parentRuns.set(identity.parentToolCallId, identity.parentRuntimeRunId);
        scopes.set(identity.parentToolCallId, {
          resourceId: identity.childResourceId,
          threadId: identity.childThreadId,
        });
      });
      const processor: OutputProcessor = {
        id: 'child-run-proof',
        processOutputStream: async ({ part, requestContext }) => {
          const scope = parseMemoryRequestContext(requestContext);
          if (!scope?.thread?.id) {
            throw new Error('Child scope is missing');
          }
          const runs = processedRuns.get(scope.thread.id) ?? new Set<string>();
          runs.add(part.runId);
          processedRuns.set(scope.thread.id, runs);
          return part;
        },
      };
      const rootModel = scriptedAgentModel((options) =>
        hasToolResult(options, 'agent-child')
          ? textParts('both complete')
          : [
              ...toolCallParts('agent-child', 'first', { prompt: 'First task' }).slice(0, 2),
              ...toolCallParts('agent-child', 'second', { prompt: 'Second task' }).slice(1),
            ]
      );
      const delegationPolicy = createDelegationConfig({
        abortSignal: new AbortController().signal,
        conversationBinding: binding,
        logger: createLogger('SubagentBindingTest'),
        personasById: new Map([
          [
            'child',
            {
              allowedToolIds: [],
              description: 'Read',
              id: 'child',
              instructions: 'Read',
              label: 'Child',
              maxSteps: 16,
            },
          ],
        ]),
        subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
      });
      const { parent, effect } = tree({
        childInputProcessor: binding.inputProcessor,
        childMemory,
        childOutputProcessor: processor,
        delegation: {
          hookErrorStrategy: 'throw',
          onDelegationComplete: completions,
          onDelegationStart: (context) => delegationPolicy.onDelegationStart?.(context),
        },
        rootModel,
      });
      const output = await parent.stream('Run both tasks', {
        memory: { resource: 'owner', thread: 'root' },
      });
      for await (const chunk of output.fullStream) {
        if (chunk.type !== 'tool-output') {
          continue;
        }
        const invocation = chunk.payload.toolCallId;
        const nested = z
          .object({ runId: z.string().min(1), type: z.string() })
          .parse(chunk.payload.output);
        // Includes the very first native `start`, which bypasses output
        // processors. Correlate by the parent's call id, never persona/FIFO.
        expect(scopes.has(invocation), `${invocation}: ${nested.type}`).toBe(true);
        const boundScope = scopes.get(invocation);
        if (!boundScope) {
          throw new Error('Published child has no bound scope');
        }
        expect(
          (await backing.memory.getThreadById({ threadId: boundScope.threadId }))?.resourceId
        ).toBe(boundScope.resourceId);
        const parentRuntimeRunId = parentRuns.get(invocation);
        if (!parentRuntimeRunId) {
          throw new Error('Missing observed parent run');
        }
        if (nested.type === 'start') {
          publishedRuns.set(invocation, nested.runId);
        }
        expect(publishedRuns.get(invocation)).toBe(nested.runId);
      }
      expect(effect).toHaveBeenCalledTimes(2);
      expect(completions).toHaveBeenCalledTimes(2);
      expect(scopes.size).toBe(2);
      expect(new Set(publishedRuns.values()).size).toBe(2);
      expect(new Set([...scopes.values()].map((scope) => scope.threadId)).size).toBe(2);
      for (const [completion] of completions.mock.calls) {
        expect(scopes.get(completion.toolCallId)).toEqual({
          resourceId: completion.result.subAgentResourceId,
          threadId: completion.result.subAgentThreadId,
        });
        if (!completion.result.subAgentThreadId) {
          throw new Error('Completed child has no native thread');
        }
        expect(processedRuns.get(completion.result.subAgentThreadId)).toEqual(
          new Set([publishedRuns.get(completion.toolCallId)])
        );
      }
    }
  );

  it('rejects a child whose parent was not registered by the trusted delegation hook', async () => {
    const persist = vi.fn(async () => undefined);
    const binding = createDelegatedConversationBinding(persist);
    const { parent, childModel, effect } = tree({ childInputProcessor: binding.inputProcessor });
    const output = await parent.stream('Find evidence', {
      memory: { resource: 'owner', thread: 'root' },
    });
    const chunks = await collect(output.fullStream);
    expect(JSON.stringify(chunks)).toContain('no trusted parent binding');
    expect(persist).not.toHaveBeenCalled();
    expect(childModel.prompts).toHaveLength(0);
    expect(effect).not.toHaveBeenCalled();
  });

  it('surfaces failed input identity binding before child model or tool execution', async () => {
    const binding = createDelegatedConversationBinding(async () => {
      await database.query('SELECT 1');
      throw new Error('Delegated identity persistence failed');
    });
    const { parent, childModel, effect } = tree({
      childInputProcessor: binding.inputProcessor,
      delegation: {
        hookErrorStrategy: 'throw',
        onDelegationStart: (context) =>
          binding.prepare(context, { personaId: context.primitiveId }),
      },
    });
    const output = await parent.stream('Find evidence', {
      memory: { resource: 'owner', thread: 'root' },
    });
    const chunks = await collect(output.fullStream);
    expect(childModel.prompts).toHaveLength(0);
    expect(effect).not.toHaveBeenCalled();
    expect(JSON.stringify(chunks)).toContain('Delegated identity persistence failed');
  });

  it('executes root, child and grandchild with distinct durable threads and raw nested results', async () => {
    const completions = vi.fn<(context: DelegationCompleteContext) => void>();
    const nestedCompletions = vi.fn<(context: DelegationCompleteContext) => void>();
    const { parent, effect, parentModel } = tree({
      childDelegation: { onDelegationComplete: nestedCompletions },
      delegation: { onDelegationComplete: completions },
    });
    const output = await parent.stream('Find evidence', {
      memory: { resource: 'owner', thread: 'root' },
    });
    const chunks = await collect(output.fullStream);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(await output.text).toBe('child-1 answered');
    expect(completions).toHaveBeenCalledTimes(1);
    expect(nestedCompletions).toHaveBeenCalledTimes(1);
    const parentResult = completions.mock.calls[0]?.[0];
    const childResult = nestedCompletions.mock.calls[0]?.[0];
    if (!(parentResult && childResult)) {
      throw new Error('Missing delegation completion');
    }
    expect(parentResult).toMatchObject({
      parentAgentId: 'parent',
      primitiveId: 'child',
      success: true,
      toolCallId: 'child-1',
    });
    expect(childResult).toMatchObject({
      parentAgentId: 'child',
      primitiveId: 'leaf',
      success: true,
      toolCallId: 'leaf-1',
    });
    expect(parentResult.result.subAgentThreadId).not.toBe(childResult.result.subAgentThreadId);
    expect(parentResult.result.subAgentToolResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: 'leaf-1', toolName: 'agent-leaf' }),
      ])
    );
    // Each scripted agent makes two provider calls at one input/output token each.
    // Native child usage excludes its descendants, so the tree sums each run once.
    expect(parentResult.result.usage).toMatchObject({
      inputTokens: 2,
      outputTokens: 2,
      totalTokens: 4,
    });
    expect(childResult.result.usage).toMatchObject({
      inputTokens: 2,
      outputTokens: 2,
      totalTokens: 4,
    });
    const rows = await database.query<{ thread_id: string }>(
      'SELECT DISTINCT thread_id FROM mastra_messages'
    );
    expect(new Set(rows.rows.map((row) => row.thread_id))).toEqual(
      new Set(['root', parentResult.result.subAgentThreadId, childResult.result.subAgentThreadId])
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          output: expect.objectContaining({
            payload: expect.objectContaining({ id: 'child' }),
            type: 'start',
          }),
          toolCallId: 'child-1',
        }),
        type: 'tool-output',
      })
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          output: expect.objectContaining({
            payload: expect.objectContaining({
              output: expect.objectContaining({
                payload: expect.objectContaining({ id: 'leaf' }),
                type: 'start',
              }),
              toolCallId: 'leaf-1',
            }),
            type: 'tool-output',
          }),
          toolCallId: 'child-1',
        }),
        type: 'tool-output',
      })
    );
    // Raw debug data remains outside the supervisor's next model call.
    expect(JSON.stringify(parentModel.prompts.at(-1)?.prompt)).not.toContain('leaf result');
  });

  it.each([true, false])(
    'routes grandchild approval through recreated agents and storage (approved=%s)',
    async (approved) => {
      const completions = vi.fn();
      const initialInput = vi.fn(
        ({ messages }: Parameters<NonNullable<InputProcessor['processInput']>>[0]) => messages
      );
      const { parent, effect, host } = tree({
        childInputProcessor: { id: 'resume-input-proof', processInput: initialInput },
        delegation: { onDelegationComplete: completions },
        requireApproval: true,
      });
      const output = await parent.stream('Read evidence', {
        memory: { resource: 'owner', thread: 'approval-root' },
      });
      const initialBindings: DelegatedRunIdentity[] = [];
      const authorizeInitial = createDelegatedRunPublicationGuard(
        async (identity) => {
          initialBindings.push(identity);
        },
        new Map([['agent-child', 'child']])
      );
      const chunks: ChunkType[] = [];
      for await (const chunk of output.fullStream) {
        await authorizeInitial(chunk);
        chunks.push(chunk);
      }
      expect(initialBindings).toHaveLength(1);
      const nativeMessages = initialChildMessageIdentities(chunks);
      expect(completions).not.toHaveBeenCalled();
      const approval = chunks.find((chunk) => chunk.type === 'tool-call-approval');
      expect(approval).toBeDefined();
      expect(effect).not.toHaveBeenCalled();
      if (approval?.type !== 'tool-call-approval') {
        throw new Error('Missing root approval');
      }
      await shutdownHost(host);
      backing = await createPgliteMastraMemory({
        database: memoryDatabase(),
        memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
      });
      expect(initialInput).toHaveBeenCalledTimes(1);
      const resumeInput = vi.fn(
        ({ messages }: Parameters<NonNullable<InputProcessor['processInput']>>[0]) => messages
      );
      const recreated = tree({
        childInputProcessor: { id: 'resume-input-proof', processInput: resumeInput },
        delegation: { onDelegationComplete: completions },
        requireApproval: true,
      });
      const resume = approved
        ? await recreated.parent.approveToolCall({
            runId: output.runId,
            toolCallId: approval.payload.toolCallId,
          })
        : await recreated.parent.declineToolCall({
            runId: output.runId,
            toolCallId: approval.payload.toolCallId,
          });
      const resumedBindings: DelegatedRunIdentity[] = [];
      const authorizeResume = createDelegatedRunPublicationGuard(
        async (identity) => {
          resumedBindings.push(identity);
        },
        new Map([['agent-child', 'child']])
      );
      const resumedChunks: ChunkType[] = [];
      const personas = new Map([
        ['agent-child', 'child'],
        ['agent-leaf', 'leaf'],
      ]);
      const createProjection = () =>
        createDelegatedStreamProjection({
          authorize: async (identity) => {
            const messageId = nativeMessages.get(identity.childRuntimeRunId);
            if (!messageId) {
              throw new Error('Unknown resumed native invocation');
            }
            const rows = await database.query<{ thread_id: string }>(
              'SELECT thread_id FROM mastra_messages WHERE id = $1',
              [messageId]
            );
            const threadId = rows.rows[0]?.thread_id;
            if (!threadId) {
              throw new Error('Missing persisted native child message');
            }
            return { messageId, threadId };
          },
          createState: (_personaId, threadId) =>
            createTurnAttemptLifecycleState({ memory: { threadId } }, undefined, undefined),
          isActiveToolCall: (state, toolCallId) =>
            state.activeToolEvents?.has(toolCallId) === true &&
            !state.terminalToolCallStates.has(toolCallId),
          mapPart: async (part, state, toolNames) => {
            const result = await processMastraStreamPart(
              part,
              toolNames,
              state,
              undefined,
              new Map(),
              personas
            );
            return {
              ...result,
              chunks: result.chunks.map((chunk) => {
                if (
                  chunk.type === 'delegated-conversation-chunk' ||
                  chunk.type === 'child-continuation-chunk'
                ) {
                  throw new Error('Child projection cannot contain an already-scoped chunk.');
                }
                return chunk;
              }),
            };
          },
          personas,
        });
      const pausedProjection = createProjection();
      const rootState = createTurnAttemptLifecycleState(undefined, undefined, undefined);
      const rootToolNames = new Map<string, string>();
      for (const chunk of chunks) {
        await pausedProjection?.project(chunk, rootToolNames);
        // Match streamAttemptChunks: project children first, then stop at the
        // first parent pause instead of consuming any later native chunks.
        const rootPart = await processMastraStreamPart(
          chunk,
          rootToolNames,
          rootState,
          undefined,
          new Map(),
          personas
        );
        if (rootPart.finished) {
          break;
        }
      }
      expect(
        pausedProjection?.finalize((state) =>
          makeDelegatedStreamTermination(state, false).map((chunk) => {
            if (
              chunk.type === 'delegated-conversation-chunk' ||
              chunk.type === 'child-continuation-chunk'
            ) {
              throw new Error('Child terminal cannot contain an already-scoped chunk.');
            }
            return chunk;
          })
        )
      ).toEqual([]);
      const projection = createProjection();
      const projected = [];
      for await (const chunk of resume.fullStream) {
        await authorizeResume(chunk);
        resumedChunks.push(chunk);
        projected.push(...((await projection?.project(chunk, new Map())) ?? []));
      }
      const firstNested = resumedChunks.find((chunk) => chunk.type === 'tool-output');
      expect(
        readMastraStreamPartString(readMastraStreamPartValue(firstNested, 'output'), 'messageId')
      ).toBeUndefined();
      expect(new Set(projected.map((chunk) => chunk.identity.childRuntimeRunId)).size).toBe(2);
      expect(projected.every((chunk) => Boolean(chunk.messageId))).toBe(true);
      expect(projected.filter((chunk) => chunk.chunk.type === 'message-finish')).toHaveLength(2);
      expect(resumedBindings).toEqual(initialBindings);
      expect(effect).not.toHaveBeenCalled();
      expect(recreated.effect).toHaveBeenCalledTimes(approved ? 1 : 0);
      expect(resumeInput).not.toHaveBeenCalled();
      expect(await resume.text).toBe('child-1 answered');
      expect(completions).toHaveBeenCalledOnce();
      expect(completions.mock.calls[0]?.[0]).toMatchObject({
        result: { usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } },
        runId: output.runId,
        toolCallId: 'child-1',
      });
    }
  );

  it('copies context entries per delegation without changing the parent map', async () => {
    const requestContext = new RequestContext();
    requestContext.set('scope', 'parent');
    const starts = vi.fn((context: DelegationStartContext) => {
      context.requestContext.set('scope', 'child');
    });
    const { parent, childScopes } = tree({ delegation: { onDelegationStart: starts } });
    const output = await parent.stream('Find evidence', { requestContext });
    await collect(output.fullStream);
    expect(starts).toHaveBeenCalledTimes(1);
    expect(starts.mock.calls[0]?.[0].requestContext.get('scope')).toBe('child');
    expect(requestContext.get('scope')).toBe('parent');
    expect(childScopes).toContain('child');
  });

  it('does not silently turn a failed Brainstrike completion hook into successful delegation', async () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        info: vi.fn(),
        trace: vi.fn(),
        warn: vi.fn(),
      },
      onChildUsage: () => {
        throw new Error('usage sink failed');
      },
      personasById: new Map([
        [
          'child',
          {
            allowedToolIds: [],
            description: 'Read',
            id: 'child',
            instructions: 'Read',
            label: 'Child',
            maxSteps: 4,
          },
        ],
      ]),
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    const { parent } = tree({ delegation: config });
    const output = await parent.stream('Find evidence');
    const chunks = await collect(output.fullStream);
    expect(JSON.stringify(chunks)).toContain('usage sink failed');
    expect(
      (await output.toolResults).some((part) =>
        JSON.stringify(part.payload.result).includes('leaf-1 answered')
      )
    ).toBe(false);
  });

  it('keeps concurrent invocations of one persona in distinct child threads', async () => {
    const completions = vi.fn<(context: DelegationCompleteContext) => void>();
    const rootModel = scriptedAgentModel((options) =>
      hasToolResult(options, 'agent-child')
        ? textParts('both complete')
        : [
            ...toolCallParts('agent-child', 'first', { prompt: 'First task' }).slice(0, 2),
            ...toolCallParts('agent-child', 'second', { prompt: 'Second task' }).slice(1),
          ]
    );
    const { parent, effect } = tree({
      delegation: { onDelegationComplete: completions },
      rootModel,
    });
    const output = await parent.stream('Run both tasks', {
      memory: { resource: 'owner', thread: 'root' },
    });
    await collect(output.fullStream);
    expect(effect).toHaveBeenCalledTimes(2);
    expect(completions).toHaveBeenCalledTimes(2);
    expect(new Set(completions.mock.calls.map(([context]) => context.toolCallId))).toEqual(
      new Set(['first', 'second'])
    );
    expect(
      new Set(completions.mock.calls.map(([context]) => context.result.subAgentThreadId)).size
    ).toBe(2);
    const rows = await database.query<{ thread_id: string }>(
      'SELECT DISTINCT thread_id FROM mastra_messages'
    );
    // One root + two child conversations + their two grandchildren.
    expect(rows.rows).toHaveLength(5);
  });

  it('requires explicit descendant memory to persist a grandchild (negative control)', async () => {
    const { parent, effect } = tree({ childMemory: false });
    const output = await parent.stream('Read', { memory: { resource: 'owner', thread: 'root' } });
    await collect(output.fullStream);
    expect(effect).toHaveBeenCalledTimes(1);
    const rows = await database.query<{ thread_id: string }>(
      'SELECT DISTINCT thread_id FROM mastra_messages'
    );
    expect(rows.rows).toHaveLength(2);
  });

  it.each(['instructions', 'input'] as const)(
    'joins native %s failures without waiting for a missing completion hook',
    async (failureStage) => {
      const owner = new AbortController();
      const persistence = createDelegatedTurnPersistence(backing.memory, {
        resourceId: 'owner',
        threadId: 'root',
      });
      if (!persistence) {
        throw new Error('Fixture requires memory');
      }
      const completion = vi.fn<(context: DelegationCompleteContext) => void>();
      const { parent, childModel, effect } = tree({
        childInputProcessor: {
          id: 'reject-child-input',
          processInputStep() {
            throw new Error('Child input rejected');
          },
        },
        delegation: {
          onDelegationComplete: completion,
          onDelegationStart: (context) => persistence.prepare(context, owner.signal),
        },
        failChildInstructions: failureStage === 'instructions',
        rootModel: toolThenAnswer('agent-child', 'child-1', {
          instructions: 'Read carefully',
          prompt: 'Find evidence',
        }),
      });
      const output = await parent.stream('Read', {
        abortSignal: owner.signal,
        hooks: persistence.hooks(owner.signal),
        memory: { resource: 'owner', thread: 'root' },
      });
      const chunks = await collect(output.fullStream);
      expect(JSON.stringify(chunks)).toContain(
        failureStage === 'instructions'
          ? 'Child instructions failed before execution'
          : 'Child input rejected'
      );
      expect(childModel.prompts).toHaveLength(0);
      expect(effect).not.toHaveBeenCalled();
      // Instructions are resolved outside native delegation's try/catch.
      expect(completion).toHaveBeenCalledTimes(failureStage === 'instructions' ? 0 : 1);
      owner.abort();
      await persistence.finalize();
    }
  );

  it('settles cancelled child persistence after native suspension skips delegation completion', async () => {
    const owner = new AbortController();
    const persistence = createDelegatedTurnPersistence(backing.memory, {
      resourceId: 'owner',
      threadId: 'root',
    });
    if (!persistence) {
      throw new Error('Fixture requires child persistence');
    }
    const completion = vi.fn<(context: DelegationCompleteContext) => void>();
    const { parent, effect } = tree({
      childInputProcessor: persistence.processor,
      childOutputProcessor: persistence.processor,
      delegation: {
        onDelegationComplete: completion,
        onDelegationStart: (context) => persistence.prepare(context, owner.signal),
      },
      suspend: true,
    });
    const output = await parent.stream('Read', {
      abortSignal: owner.signal,
      hooks: persistence.hooks(owner.signal),
      memory: { resource: 'owner', thread: 'root' },
    });
    const chunks = await collect(output.fullStream);
    expect(chunks.some((chunk) => chunk.type === 'tool-call-suspended')).toBe(true);
    expect(completion).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
    owner.abort();
    await persistence.finalize();
  });

  it('resumes a grandchild question through the root snapshot', async () => {
    const { parent, effect } = tree({ suspend: true });
    const output = await parent.stream('Read', { memory: { resource: 'owner', thread: 'root' } });
    const chunks = await collect(output.fullStream);
    const suspension = chunks.find((chunk) => chunk.type === 'tool-call-suspended');
    expect(suspension).toBeDefined();
    expect(effect).not.toHaveBeenCalled();
    if (suspension?.type !== 'tool-call-suspended') {
      throw new Error('Missing root suspension');
    }
    const resumed = await parent.resumeStream(
      { confirmed: true },
      { runId: output.runId, toolCallId: suspension.payload.toolCallId }
    );
    await collect(resumed.fullStream);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(await resumed.text).toBe('child-1 answered');
  });

  it('forwards root cancellation to the grandchild model loop', async () => {
    const abortController = new AbortController();
    const { parent, effect, leafModel } = tree({ abortController });
    const output = await parent.stream('Read', { abortSignal: abortController.signal });
    await collect(output.fullStream);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(leafModel.prompts).toHaveLength(1);
    expect(leafModel.prompts[0]?.abortSignal?.aborted).toBe(true);
    expect(await output.text).toBe('');
  });

  it('demonstrates that the implicit background-task store is not durable (negative control)', async () => {
    const host = new Mastra({
      backgroundTasks: { enabled: true },
      logger: false,
      storage: new MastraCompositeStore({
        domains: { memory: backing.store },
        id: 'omitted-domain-control',
      }),
    });
    hosts.add(host);
    const store = await host.backgroundTaskManager?.getStorage();
    if (!store) {
      throw new Error('Missing background manager');
    }
    await store.createTask({
      agentId: 'parent',
      args: {},
      createdAt: new Date(),
      id: 'background-proof',
      maxRetries: 0,
      retryCount: 0,
      runId: 'run',
      status: 'completed',
      timeoutMs: 1000,
      toolCallId: 'child-1',
      toolName: 'agent-child',
    });
    expect(await store.getTask('background-proof')).not.toBeNull();
    await shutdownHost(host);
    const recreated = await createPgliteMastraMemory({
      database: memoryDatabase(),
      memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
    });
    const nextHost = new Mastra({
      backgroundTasks: { enabled: true },
      logger: false,
      storage: new MastraCompositeStore({
        domains: { memory: recreated.store },
        id: 'omitted-domain-recreated',
      }),
    });
    hosts.add(nextHost);
    const nextStore = await nextHost.backgroundTaskManager?.getStorage();
    if (!nextStore) {
      throw new Error('Missing recreated background manager');
    }
    expect(await nextStore.getTask('background-proof')).toBeNull();
  });

  it('uses stream untilIdle without a second model invocation when no background work exists', async () => {
    const { parent, effect, parentModel } = tree();
    const output = await parent.stream('Read', {
      memory: { resource: 'owner', thread: 'root' },
      untilIdle: true,
    });
    await collect(output.fullStream);
    expect(await output.text).toBe('child-1 answered');
    expect(effect).toHaveBeenCalledTimes(1);
    expect(parentModel.prompts).toHaveLength(2);
  });
});
