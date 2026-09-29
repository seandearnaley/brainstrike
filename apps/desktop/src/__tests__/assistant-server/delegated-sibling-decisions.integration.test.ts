// @vitest-environment node
/** Real native siblings and desktop admission; model transport alone is scripted.
 * This starts below HTTP/attempt-leg construction and does not claim UI coverage. */
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
  Mastra,
  processMastraStreamPart,
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
import { migrate } from '@brainstrike/db';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getDesktopMastraMemory } from '../../assistant-server/mastra-memory';
import { observeDesktopAssistantRunEvents } from '../../assistant-server/run-persistence';

const holder = vi.hoisted(() => ({ database: undefined as PGlite | undefined }));
vi.mock('../../db-main', () => ({
  getDatabase: async () => {
    if (!holder.database) {
      throw new Error('Missing fixture database');
    }
    return holder.database;
  },
}));
vi.mock('@brainstrike/agent', async (original) => ({
  ...(await original<typeof import('@brainstrike/agent')>()),
}));

it('resumes exactly one of two native sibling decisions, rejects replay and completes the other', async () => {
  const database = await createEnginePglite();
  holder.database = database;
  let host: Mastra | undefined;
  try {
    await migrate(database);
    await database.exec(`INSERT INTO mastra_threads
      (id, "resourceId", title, metadata, "createdAt", "updatedAt")
      VALUES ('root', 'owner', 'Root', '{}', NOW(), NOW());
      INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, created_at, updated_at, turn_message_id)
      VALUES ('initial', 'owner', 'root', 'openai', 'test', 'desktop', 'running', NOW(), NOW(), NOW(), 'user-turn');`);
    const backing = await getDesktopMastraMemory(
      {
        ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
        observationalMemory: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
          enabled: false,
        },
      },
      'initial'
    );
    const binding = backing.conversationBinding;
    if (!(backing.memory && backing.storage && binding)) {
      throw new Error('Missing native backing');
    }
    const effects: string[] = [];
    const boundary = createResponseBoundaryProcessor();
    const child = (id: string) =>
      new Agent({
        description: `Read ${id}`,
        id,
        inputProcessors: [binding.inputProcessor],
        instructions: `Read ${id}`,
        memory: backing.memory,
        model: toolThenAnswer('read', 'shared-leaf-call', { query: id }).model,
        name: id,
        outputProcessors: [boundary],
        tools: {
          read: createTool({
            description: 'Read evidence',
            execute: async ({ query }) => {
              effects.push(query);
              return { value: query };
            },
            id: 'read',
            inputSchema: z.object({ query: z.string() }),
            requireApproval: true,
          }),
        },
      });
    const cedar = child('cedar');
    const flint = child('flint');
    const parent = new Agent({
      agents: { cedar, flint },
      defaultOptions: {
        delegation: {
          hookErrorStrategy: 'throw',
          onDelegationStart: (context: DelegationStartContext) =>
            binding.prepare(context, { maxSteps: 4, personaId: context.primitiveId }),
        },
        hooks: binding.hooks,
        maxSteps: 4,
      },
      id: 'parent',
      instructions: 'Delegate to both children.',
      memory: backing.memory,
      model: scriptedAgentModel((options) => {
        if (hasToolResult(options, 'agent-cedar') && hasToolResult(options, 'agent-flint')) {
          return textParts('Both children answered.');
        }
        return [
          ...toolCallParts('agent-cedar', 'cedar-call', { prompt: 'Read Cedar' }).slice(0, -1),
          ...toolCallParts('agent-flint', 'flint-call', { prompt: 'Read Flint' }).slice(1),
        ];
      }).model,
      name: 'Parent',
    });
    host = new Mastra({ agents: { parent }, logger: false, storage: backing.storage });
    const personas = new Map([
      ['agent-cedar', 'cedar'],
      ['agent-flint', 'flint'],
    ]);
    const metadata: AssistantPersonaDefinition = {
      allowedToolIds: ['read'],
      description: 'Read',
      id: 'cedar',
      instructions: 'Read',
      label: 'Cedar',
      maxSteps: 4,
    };
    async function drain(stream: AsyncIterable<unknown>) {
      const state = createTurnAttemptLifecycleState(
        { memory: { threadId: 'root' } },
        undefined,
        undefined
      );
      const runtime = {
        askTools: new Map(),
        conversationBinding: binding,
        delegationToolPersonas: personas,
        personasById: new Map([
          ['cedar', metadata],
          ['flint', { ...metadata, id: 'flint' }],
        ]),
      };
      const projection = createAttemptDelegatedProjection({
        lifecycleState: state,
        runtime,
        runtimeData: {
          memory: { resourceId: 'owner', threadId: 'root' },
          model: 'test',
          provider: 'openai',
        },
        sanitizedNameMap: undefined,
      });
      const names = new Map<string, string>();
      const chunks: StreamChunk[] = [];
      for await (const part of stream) {
        chunks.push(...(await projection.project(part, names)));
        const mapped = await processMastraStreamPart(
          projection.preparePart(part),
          names,
          state,
          undefined,
          runtime.askTools,
          personas
        );
        chunks.push(...mapped.chunks.map((chunk) => projection.decorate(chunk)));
      }
      chunks.push(...projection.settle());
      async function* recorded() {
        yield* chunks;
      }
      for await (const _chunk of observeDesktopAssistantRunEvents(
        recorded(),
        'initial',
        [],
        async () => database
      )) {
        // Persist the actual projected child message identity before native resume.
      }
      return chunks;
    }
    const initial = await parent.stream('Read both.', {
      memory: { resource: 'owner', thread: 'root' },
    });
    const chunks = await drain(initial.fullStream);
    const approvals = chunks.filter((chunk) => chunk.type === 'tool-approval-required');
    expect(approvals).toHaveLength(2);
    expect(effects).toEqual([]);
    const actionFor = (id: string) => {
      const notice = approvals.find((approval) => approval.delegation?.path[0]?.personaId === id);
      if (!notice?.delegation) {
        throw new Error(`Missing ${id} native decision`);
      }
      return { delegation: notice.delegation, runId: initial.runId, toolCallId: notice.toolCallId };
    };
    const cedarAction = actionFor('cedar');
    const flintAction = actionFor('flint');
    expect(cedarAction.delegation.toolCallId).toBe(flintAction.delegation.toolCallId);
    expect(cedarAction.delegation.path[0]?.childRuntimeRunId).not.toBe(
      flintAction.delegation.path[0]?.childRuntimeRunId
    );
    const native = { agent: parent, requiresApproval: true };
    // A sibling root alias paired with Cedar's immutable guard must never enter execution.
    await expect(
      claimDelegatedToolAction(
        { ...cedarAction, toolCallId: flintAction.toolCallId },
        binding,
        native
      )
    ).rejects.toThrow();
    await claimDelegatedToolAction(cedarAction, binding, native);
    await expect(claimDelegatedToolAction(flintAction, binding, native)).rejects.toThrow();
    await expect(claimDelegatedToolAction(cedarAction, binding, native)).rejects.toThrow();
    const resumedCedar = await parent.approveToolCall({
      runId: cedarAction.runId,
      toolCallId: cedarAction.toolCallId,
    });
    await drain(resumedCedar.fullStream);
    await binding.finishToolActions?.();
    expect(effects).toEqual(['cedar']);
    await expect(claimDelegatedToolAction(cedarAction, binding, native)).rejects.toThrow();
    await expect(
      assertDelegatedToolActionPending({ action: flintAction, binding, ...native })
    ).resolves.toMatchObject({ toolCallId: 'shared-leaf-call' });
    await claimDelegatedToolAction(flintAction, binding, native);
    const resumedFlint = await parent.approveToolCall({
      runId: flintAction.runId,
      toolCallId: flintAction.toolCallId,
    });
    await drain(resumedFlint.fullStream);
    await binding.finishToolActions?.();
    expect(effects).toEqual(['cedar', 'flint']);
    expect(await resumedFlint.text).toBe('Both children answered.');
    await expect(claimDelegatedToolAction(flintAction, binding, native)).rejects.toThrow();
    expect(effects).toEqual(['cedar', 'flint']);
  } finally {
    await host?.shutdown();
    await database.close();
    holder.database = undefined;
  }
});
