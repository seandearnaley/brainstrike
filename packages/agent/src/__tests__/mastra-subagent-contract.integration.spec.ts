import { createDelegatedConversationRepository, runDrizzleMigrations } from '@brainstrike/db';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
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
import type { ChunkType } from '@mastra/core/stream';
import { createTool } from '@mastra/core/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDelegatedConversationBinding } from '../mastra/delegated-conversation-binding';
import {
  createDelegatedRunPublicationGuard,
  type DelegatedRunIdentity,
} from '../mastra/delegated-run-publication';
import { createDelegationConfig } from '../mastra/subagent-delegation';
import { createPgliteMastraMemory, type PgliteDatabase } from '../pglite-mastra-memory';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
  toolThenAnswer,
} from './fixtures/scripted-agent-model';

async function collect(stream: AsyncIterable<ChunkType>): Promise<ChunkType[]> {
  const chunks: ChunkType[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
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
    database = await createEnginePglite();
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
    childInputProcessor,
    childOutputProcessor,
  }: {
    requireApproval?: boolean;
    delegation?: DelegationConfig;
    childDelegation?: DelegationConfig;
    childMemory?: boolean;
    suspend?: boolean;
    abortController?: AbortController;
    rootModel?: ReturnType<typeof scriptedAgentModel>;
    childInputProcessor?: InputProcessor;
    childOutputProcessor?: OutputProcessor;
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
    const leafModel = toolThenAnswer('read', 'read-1', {});
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
      await runDrizzleMigrations(database);
      const graph = createDelegatedConversationRepository(database);
      const rootScope = { ownerResourceId: 'owner', rootThreadId: 'root' };
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
        await graph.registerRoot(rootScope);
        await graph.createChild(rootScope, {
          color: 'blue',
          configuration: identity.configuration,
          displayName: identity.parentToolCallId,
          parentThreadId: identity.parentThreadId,
          resourceId: identity.childResourceId,
          threadId: identity.childThreadId,
        });
        await database.query(`INSERT INTO brainstrike_assistant_thread_runs
          (id, resource_id, thread_id, provider, model, runtime_kind, status,
            started_at, created_at, updated_at, turn_message_id)
          VALUES ('host-leg', 'owner', 'root', 'openai', 'scripted', 'desktop', 'running',
            NOW(), NOW(), NOW(), 'user-turn') ON CONFLICT (id) DO NOTHING`);
        await graph.createInvocation(rootScope, {
          hostRunId: 'host-leg',
          parentRuntimeRunId: identity.parentRuntimeRunId,
          parentThreadId: identity.parentThreadId,
          parentToolCallId: identity.parentToolCallId,
          personaId: identity.personaId,
          threadId: identity.childThreadId,
        });
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
      const reloadedGraph = createDelegatedConversationRepository(database);
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
        const persisted = await reloadedGraph.get(rootScope, boundScope.threadId);
        expect(persisted).toMatchObject({
          displayName: invocation,
          resourceId: boundScope.resourceId,
        });
        const parentRuntimeRunId = parentRuns.get(invocation);
        if (!parentRuntimeRunId) {
          throw new Error('Missing observed parent run');
        }
        const key = { parentRuntimeRunId, parentToolCallId: invocation };
        if (nested.type === 'start') {
          await graph.bindInvocationRun(rootScope, { ...key, personaId: 'child' }, nested.runId);
          publishedRuns.set(invocation, nested.runId);
        }
        expect(await reloadedGraph.getInvocation(rootScope, key)).toMatchObject({
          childRuntimeRunId: nested.runId,
          hostRunId: 'host-leg',
          threadId: boundScope.threadId,
          turnMessageId: 'user-turn',
        });
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
      for await (const chunk of resume.fullStream) {
        await authorizeResume(chunk);
      }
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
      storage: backing.storage,
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
      storage: recreated.storage,
    });
    hosts.add(nextHost);
    const nextStore = await nextHost.backgroundTaskManager?.getStorage();
    if (!nextStore) {
      throw new Error('Missing recreated background manager');
    }
    expect(await nextStore.getTask('background-proof')).toBeNull();
  });

  it('uses stream untilIdle without a second model invocation when no background work exists', async () => {
    const { parent, effect } = tree();
    const output = await parent.stream('Read', {
      memory: { resource: 'owner', thread: 'root' },
      untilIdle: true,
    });
    await collect(output.fullStream);
    expect(await output.text).toBe('child-1 answered');
    expect(effect).toHaveBeenCalledTimes(1);
  });
});
