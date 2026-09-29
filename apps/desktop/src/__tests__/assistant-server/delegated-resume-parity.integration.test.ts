// @vitest-environment node
/** Script only model transport and DB handle injection; use the real desktop memory,
 * Mastra stream mapper, durable host authority, and existing usage writer. */

import { randomUUID } from 'node:crypto';
import type { StreamChunk } from '@brainstrike/agent';
import {
  Agent,
  assertDelegatedToolActionPending,
  claimDelegatedToolAction,
  createAttemptDelegatedProjection,
  createResponseBoundaryProcessor,
  createTool,
  createTurnAttemptLifecycleState,
  type DelegationStartContext,
  discoverDelegatedToolPause,
  Mastra,
  processMastraStreamPart,
  readResumedApprovalToolCall,
} from '@brainstrike/agent/test-fixtures/delegated-stream';

import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
  toolThenAnswer,
} from '@brainstrike/agent/test-fixtures/scripted-agent-model';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import {
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
} from '@brainstrike/assistant-data';
import { BrainstrikeDataStreamRuntimeAdapter } from '@brainstrike/assistant-ui/data-stream-runtime';
import { migrate, wasmLoader } from '@brainstrike/db';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { DbHandle } from '@brainstrike/db/react';
import type { PGlite } from '@electric-sql/pglite';
import type { AssistantMessage } from 'assistant-stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDesktopDelegatedSuspensionResolver } from '../../assistant-server/delegated-conversation-host';
import { getDesktopMastraMemory } from '../../assistant-server/mastra-memory';
import { observeDesktopAssistantRunEvents } from '../../assistant-server/run-persistence';

const holder = vi.hoisted(() => ({
  database: undefined as PGlite | undefined,
}));
vi.mock('../../db-main', () => ({
  getDatabase: async () => {
    if (!holder.database) {
      throw new Error('Database not initialized');
    }
    return holder.database;
  },
}));
// Restore the real runtime: the desktop global setup installs inert agent mocks.
vi.mock('@brainstrike/agent', async (original) => ({
  ...(await original<typeof import('@brainstrike/agent')>()),
}));
const { createStatelessAssistantDataStreamResponse } = await import('@brainstrike/agent');

const settings = {
  ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  observationalMemory: {
    ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
    enabled: false,
  },
};
const persona: AssistantPersonaDefinition = {
  // Identity metadata only: this fixture tests native approval projection,
  // while production persona tool gating is covered by the factory suites.
  allowedToolIds: ['brainstrike.grepSearch'],
  description: 'Find the requested flag.',
  id: 'explore',
  instructions: 'Read and report the flag.',
  label: 'Explorer',
  maxSteps: 8,
};

describe('native approval resume child transcript parity', () => {
  let database: PGlite;
  const hosts = new Set<Mastra>();
  beforeEach(async () => {
    database = await wasmLoader.createPGlite(`memory://delegated-resume-parity-${randomUUID()}`);
    holder.database = database;
    await migrate(database);
    await database.exec(`INSERT INTO mastra_threads
      (id, "resourceId", title, metadata, "createdAt", "updatedAt")
      VALUES ('root', 'owner', 'Root', '{}', NOW(), NOW());
      INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status,
       started_at, created_at, updated_at, turn_message_id)
      VALUES ('initial', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
        NOW(), NOW(), NOW(), 'user-turn');`);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const host of hosts) {
      await host.shutdown();
    }
    hosts.clear();
    await database.close();
    holder.database = undefined;
  });

  async function tree(hostRunId: string, continuation = 'Leaf after approval.') {
    const backing = await getDesktopMastraMemory(settings, hostRunId);
    const binding = backing.conversationBinding;
    if (!(backing.memory && backing.storage && binding)) {
      throw new Error('Missing native backing');
    }
    const delegation = {
      hookErrorStrategy: 'throw' as const,
      onDelegationStart: (context: DelegationStartContext) =>
        binding.prepare(context, { maxSteps: 4, personaId: context.primitiveId }),
    };
    const effect = vi.fn(async () => ({ value: 'APPROVED-EVIDENCE' }));
    const leafModel = scriptedAgentModel((options) =>
      hasToolResult(options, 'read')
        ? textParts(continuation)
        : [
            ...textParts('Leaf before approval.').slice(0, -1),
            { id: 'reasoning', type: 'reasoning-start' },
            { delta: 'Inspect approved evidence.', id: 'reasoning', type: 'reasoning-delta' },
            { id: 'reasoning', type: 'reasoning-end' },
            ...toolCallParts('read', 'read-1', { query: 'needle' }).slice(1),
          ]
    );
    const boundary = createResponseBoundaryProcessor();
    const leaf = new Agent({
      description: 'Read evidence',
      id: 'leaf',
      inputProcessors: [binding.inputProcessor],
      instructions: 'Read evidence.',
      memory: backing.memory,
      model: leafModel.model,
      name: 'Leaf',
      outputProcessors: [boundary],
      tools: {
        read: createTool({
          description: 'Read evidence',
          execute: effect,
          id: 'read',
          inputSchema: z.object({ query: z.string() }),
          requireApproval: true,
        }),
      },
    });
    const child = new Agent({
      agents: { leaf },
      defaultOptions: { delegation, hooks: binding.hooks, maxSteps: 4 },
      description: 'Delegate',
      id: 'child',
      inputProcessors: [binding.inputProcessor],
      instructions: 'Delegate to leaf.',
      memory: backing.memory,
      model: toolThenAnswer('agent-leaf', 'leaf-1', { prompt: 'Read' }).model,
      name: 'Child',
      outputProcessors: [boundary],
    });
    const parent = new Agent({
      agents: { child },
      defaultOptions: { delegation, hooks: binding.hooks, maxSteps: 4 },
      id: 'parent',
      instructions: 'Delegate.',
      memory: backing.memory,
      model: toolThenAnswer('agent-child', 'child-1', { prompt: 'Delegate' }).model,
      name: 'Parent',
    });
    const host = new Mastra({ agents: { parent }, logger: false, storage: backing.storage });
    hosts.add(host);
    return { binding, effect, host, parent, storage: backing.storage };
  }

  async function decode(
    native: AsyncIterable<unknown>,
    backing: Awaited<ReturnType<typeof tree>>,
    hostRunId: string
  ) {
    const nativeChunks: unknown[] = [];
    for await (const part of native) {
      nativeChunks.push(part);
    }
    const personas = new Map([
      ['agent-child', 'child'],
      ['agent-leaf', 'leaf'],
    ]);
    const rootState = createTurnAttemptLifecycleState(
      { memory: { threadId: 'root' } },
      undefined,
      undefined
    );
    const runtime = {
      askTools: new Map(),
      conversationBinding: backing.binding,
      delegationToolPersonas: personas,
      personasById: new Map([
        ['child', { ...persona, id: 'child' }],
        ['leaf', { ...persona, id: 'leaf' }],
      ]),
    };
    const projection = createAttemptDelegatedProjection({
      lifecycleState: rootState,
      runtime,
      runtimeData: {
        memory: { resourceId: 'owner', threadId: 'root' },
        model: 'test',
        provider: 'openai',
      },
      sanitizedNameMap: undefined,
    });
    const rootChunks: StreamChunk[] = [];
    async function* mapped(): AsyncIterable<StreamChunk> {
      const names = new Map<string, string>();
      for (const part of nativeChunks) {
        yield* await projection.project(part, names);
        const result = await processMastraStreamPart(
          part,
          names,
          rootState,
          undefined,
          runtime.askTools,
          personas
        );
        for (const chunk of result.chunks) {
          const decorated = projection.decorate(chunk);
          rootChunks.push(decorated);
          yield decorated;
        }
        if (result.finished) {
          break;
        }
      }
      yield* projection.settle();
    }
    const response = createStatelessAssistantDataStreamResponse(
      observeDesktopAssistantRunEvents(mapped(), hostRunId, [], async () => database),
      { messageId: 'parent-message' }
    );
    const children = new Map<
      string,
      { messageId: string; message: AssistantMessage; baseline: unknown }
    >();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (response.bodyUsed) {
          throw new Error('Unexpected second fetch for a native stream leg');
        }
        return response;
      })
    );
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test',
      onDelegatedConversation: (update) => {
        children.set(
          update.continuation ? update.continuation.nativeRunId : update.identity.childRuntimeRunId,
          {
            baseline: 'baseline' in update ? update.baseline : undefined,
            message: update.message,
            messageId: update.messageId,
          }
        );
      },
    });
    for await (const _message of adapter.resume(
      {
        abortSignal: new AbortController().signal,
        context: { callSettings: {}, config: {}, tools: {} },
        messages: [],
        runConfig: {},
        unstable_getMessage: () => ({
          content: [],
          createdAt: new Date(0),
          id: 'parent-message',
          metadata: {
            custom: {},
            steps: [],
            unstable_annotations: [],
            unstable_data: [],
            unstable_state: null,
          },
          role: 'assistant',
          status: { type: 'running' },
        }),
      } as Parameters<BrainstrikeDataStreamRuntimeAdapter['resume']>[0],
      { eventId: `${hostRunId}:-1`, resumeApi: 'http://assistant.test/resume' }
    )) {
      /* Drain the public receiver. */
    }
    return { children, nativeChunks, rootChunks };
  }

  it.each([
    { approved: true, continuation: 'Leaf after approval.' },
    { approved: false, continuation: 'Leaf after approval.' },
    { approved: true, continuation: 'Leaf before approval.' },
  ])(
    'keeps grandchild transcript after reconstruction ($approved / $continuation)',
    async ({ approved, continuation }) => {
      const initial = await tree('initial');
      const first = await initial.parent.stream('Delegate.', {
        memory: { resource: 'owner', thread: 'root' },
      });
      const before = await decode(first.fullStream, initial, 'initial');
      expect(initial.effect).not.toHaveBeenCalled();
      const notice = before.nativeChunks.find(
        (part) => z.object({ type: z.literal('tool-call-approval') }).safeParse(part).success
      );
      expect(notice, 'Native approval notice must be emitted').toBeDefined();
      const approval = z.object({ payload: z.object({ toolCallId: z.string() }) }).parse(notice);
      expect(before.children.size).toBe(2);
      for (const child of before.children.values()) {
        const initialBaseline = z
          .object({ messages: z.array(z.object({ role: z.string() })) })
          .parse(child.baseline);
        expect(initialBaseline.messages.some((message) => message.role === 'user')).toBe(true);
        expect(
          initialBaseline.messages.every(
            (message) => message.role === 'user' || message.role === 'system'
          )
        ).toBe(true);
      }
      await initial.host.shutdown();
      expect(hosts.delete(initial.host)).toBe(true);
      const replacement = await createEnginePglite({ loadDataDir: await database.dumpDataDir() });
      await database.close();
      database = replacement;
      holder.database = database;
      await database.exec(`INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, created_at, updated_at, turn_message_id)
      VALUES ('resumed', 'owner', 'root', 'openai', 'test', 'desktop', 'running', NOW(), NOW(), NOW(), 'user-turn')`);
      const resumed = await tree('resumed', continuation);
      const rootNotice = before.rootChunks.find((chunk) => chunk.type === 'tool-approval-required');
      if (rootNotice?.type !== 'tool-approval-required' || !rootNotice.delegation) {
        throw new Error('Missing delegated leaf identity on the root approval notice');
      }
      const action = {
        delegation: rootNotice.delegation,
        runId: first.runId,
        toolCallId: approval.payload.toolCallId,
      };
      expect(action.delegation.path).toHaveLength(2);
      expect((await resumed.binding.resolveToolAction?.(action))?.[0]).toMatchObject({
        originalToolCall: {
          args: { prompt: 'Delegate' },
          toolName: 'agent-child',
        },
      });
      const readParentStart = () =>
        readResumedApprovalToolCall(
          {
            agent: resumed.parent,
            conversationBinding: resumed.binding,
            toolNameMap: new Map(),
          },
          { memory: { resourceId: 'owner', threadId: 'root' } },
          {
            ...action,
            action: 'approve',
          }
        );
      await expect(readParentStart()).resolves.toMatchObject({
        approvedToolName: 'read',
        args: { prompt: 'Delegate' },
        displayToolName: 'agent-child',
        registeredToolName: 'agent-child',
        toolCallId: 'child-1',
      });
      const original = await database.query<{ original_tool_call: unknown }>(
        `SELECT original_tool_call FROM brainstrike_delegated_invocations
         WHERE root_thread_id = 'root' AND parent_runtime_run_id = $1 AND parent_tool_call_id = $2`,
        [action.runId, action.toolCallId]
      );
      expect(original.rows).toHaveLength(1);
      await database.query(
        `UPDATE brainstrike_delegated_invocations SET original_tool_call = NULL
         WHERE root_thread_id = 'root' AND parent_runtime_run_id = $1 AND parent_tool_call_id = $2`,
        [action.runId, action.toolCallId]
      );
      await expect(readParentStart()).rejects.toThrow('original delegation input is unavailable');
      expect(resumed.effect).not.toHaveBeenCalled();
      await database.query(
        `UPDATE brainstrike_delegated_invocations SET original_tool_call = $3::jsonb
         WHERE root_thread_id = 'root' AND parent_runtime_run_id = $1 AND parent_tool_call_id = $2`,
        [action.runId, action.toolCallId, JSON.stringify(original.rows[0]?.original_tool_call)]
      );
      const discovered = await discoverDelegatedToolPause({
        resolveInvocation: createDesktopDelegatedSuspensionResolver(database, {
          ownerResourceId: 'owner',
          rootThreadId: 'root',
        }),
        rootThreadId: 'root',
        runId: action.runId,
        storage: resumed.storage,
        toolCall: { requiresApproval: true, toolCallId: action.toolCallId, toolName: 'read' },
      });
      expect(discovered).toMatchObject({
        delegation: action.delegation,
        toolCall: { args: { query: 'needle' }, toolCallId: 'read-1', toolName: 'read' },
      });
      await expect(
        assertDelegatedToolActionPending({
          action,
          agent: resumed.parent,
          binding: resumed.binding,
          requiresApproval: true,
        })
      ).resolves.toMatchObject({ args: { query: 'needle' }, toolCallId: 'read-1' });
      const nativeTarget = { agent: resumed.parent, requiresApproval: true };
      const pendingRead = vi.spyOn(resumed.parent, 'listAgents');
      pendingRead.mockRejectedValueOnce(
        new Error('Snapshot read interrupted before native resume')
      );
      await expect(claimDelegatedToolAction(action, resumed.binding, nativeTarget)).rejects.toThrow(
        'Snapshot read interrupted before native resume'
      );
      pendingRead.mockRestore();
      expect(resumed.effect).not.toHaveBeenCalled();
      expect(
        (await database.query('SELECT state FROM brainstrike_delegated_tool_decisions')).rows
      ).toEqual([]);
      await claimDelegatedToolAction(action, resumed.binding, nativeTarget);
      await expect(
        claimDelegatedToolAction(action, resumed.binding, nativeTarget)
      ).rejects.toThrow();
      const nativeAction = { runId: action.runId, toolCallId: action.toolCallId };
      const next = approved
        ? await resumed.parent.approveToolCall(nativeAction)
        : await resumed.parent.declineToolCall(nativeAction);
      const after = await decode(next.fullStream, resumed, 'resumed');
      await resumed.binding.finishToolActions?.();
      await expect(
        claimDelegatedToolAction(action, resumed.binding, nativeTarget)
      ).rejects.toThrow();
      expect(resumed.effect).toHaveBeenCalledTimes(approved ? 1 : 0);
      expect(after.children.size).toBe(2);
      expect(
        [...after.children.values()]
          .flatMap(({ message }) => message.parts)
          .filter((part) => part.type === 'tool-call' && part.toolName === 'read')
      ).toHaveLength(1);
      const reloaded = await createEnginePglite({ loadDataDir: await database.dumpDataDir() });
      try {
        for (const [runId, { messageId, message: live, baseline }] of after.children) {
          const row = (
            await database.query<{ thread_id: string; resourceId: string }>(
              'SELECT thread_id, "resourceId" FROM mastra_messages WHERE id = $1',
              [messageId]
            )
          ).rows[0];
          if (!row) {
            throw new Error('Missing native assistant row');
          }
          // A fresh renderer must combine replay with the history that existed
          // before this leg, not with rows already updated by that same replay.
          const previous = z
            .object({
              hostRunId: z.literal('resumed'),
              messages: z.array(z.object({ content: z.unknown(), id: z.string() })),
              runEvents: z.array(z.object({ kind: z.string(), timestamp: z.string() })),
              threadId: z.literal(row.thread_id),
            })
            .parse(baseline);
          expect(previous.runEvents.length).toBeGreaterThan(0);
          expect(
            previous.runEvents.every((event) => Number.isFinite(Date.parse(event.timestamp)))
          ).toBe(true);
          expect(JSON.stringify(previous.messages)).not.toContain('APPROVED-EVIDENCE');
          const prior = before.children.get(runId);
          expect(previous.messages.some((message) => message.id === prior?.messageId)).toBe(true);
          const loadHistory = (db: PGlite) =>
            createAssistantThreadHistoryAdapter({
              repository: createPgliteAssistantThreadRepository(db as unknown as DbHandle),
              resourceId: row.resourceId,
              threadId: row.thread_id,
            }).load();
          const history = await loadHistory(database);
          expect(await loadHistory(reloaded)).toEqual(history);
          const hydratedText = history.messages
            .flatMap(({ message }) =>
              message.id === messageId && message.role === 'assistant' ? message.content : []
            )
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('');
          const liveText = live.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('');
          const initialText =
            before.children
              .get(runId)
              ?.message.parts.filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('') ?? '';
          expect(initialText + liveText).toBe(hydratedText);
          const hydrated = history.messages.flatMap(({ message }) =>
            message.id === messageId && message.role === 'assistant' ? message.content : []
          );
          const read = live.parts.find(
            (part) => part.type === 'tool-call' && part.toolName === 'read'
          );
          if (read?.type === 'tool-call') {
            const args = z.object({ query: z.string() }).parse(read.args);
            expect(args).toEqual({ query: 'needle' });
            if (approved) {
              expect(read.result).toEqual({ value: 'APPROVED-EVIDENCE' });
            }
            const storedRead = hydrated.find(
              (part) => part.type === 'tool-call' && part.toolCallId === read.toolCallId
            );
            expect(storedRead).toMatchObject({ args, result: read.result, toolName: 'read' });
            expect(
              hydrated
                .filter(
                  (part) =>
                    part.type === 'text' || part.type === 'reasoning' || part.type === 'tool-call'
                )
                .map((part) => part.type)
            ).toEqual(['text', 'reasoning', 'tool-call', 'text']);
          }
        }
      } finally {
        await reloaded.close();
      }
    }
  );
});
