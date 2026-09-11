// @vitest-environment node
/** Real native waiting decision plus the desktop cancellation HTTP endpoint.
 * Native model transport alone is scripted; UI coverage is a separate Electron spec. */

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { StreamChunk } from '@brainstrike/agent';
import {
  Agent,
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
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import {
  registerSteerableRun,
  unregisterSteerableRun,
} from '@brainstrike/assistant-service/steering';
import { migrate } from '@brainstrike/db';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { DbHandle } from '@brainstrike/db/react';
import type { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { handleCancelRequest } from '../../assistant-server/control-endpoints';
import { createDesktopDelegatedConversationHost } from '../../assistant-server/delegated-conversation-host';
import { readDelegatedDecisionStates } from '../../assistant-server/delegated-decision-discovery';
import { getDesktopMastraMemory } from '../../assistant-server/mastra-memory';
import {
  observeDesktopAssistantRunEvents,
  recordDesktopAssistantThreadRunStatus,
} from '../../assistant-server/run-persistence';

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

it('cancels a durably waiting child and rejects its stale decision through a fresh host', async () => {
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
            binding.prepare(context, { personaId: context.primitiveId }),
        },
        hooks: binding.hooks,
        maxSteps: 4,
      },
      id: 'brainstrike-assistant',
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
    const controller = new AbortController();
    registerSteerableRun('initial', controller);
    const initial = await parent.stream('Read both.', {
      abortSignal: controller.signal,
      memory: { resource: 'owner', thread: 'root' },
    });
    const chunks = await drain(initial.fullStream);
    // Mirror assistant-server.ts's finally after a native suspended stream completes.
    unregisterSteerableRun('initial');
    const notice = chunks.find(
      (chunk) =>
        chunk.type === 'tool-approval-required' && chunk.delegation?.path[0]?.personaId === 'cedar'
    );
    if (notice?.type !== 'tool-approval-required' || !notice.delegation) {
      throw new Error('Missing waiting native child');
    }
    const action = {
      delegation: notice.delegation,
      runId: initial.runId,
      toolCallId: notice.toolCallId,
    };
    const pending = await parent.listSuspendedRuns({ resourceId: 'owner', threadId: 'root' });
    expect(pending.runs).toHaveLength(1);
    expect(effects).toEqual([]);
    await database.query(
      `UPDATE brainstrike_assistant_thread_runs SET status = 'completed' WHERE id = 'initial'`
    );
    await database.query(`INSERT INTO brainstrike_assistant_thread_runs
        (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, created_at, updated_at, turn_message_id)
        VALUES ('after-reload', 'owner', 'root', 'openai', 'test', 'desktop', 'running', NOW(), NOW(), NOW(), 'user-turn')`);
    // Reconstruct only durable host authority, as renderer reload does not replace
    // the native model/store. This is not packaged renderer or process-restart proof.
    const decisionBinding = {
      ...binding,
      ...createDesktopDelegatedConversationHost(database, 'after-reload'),
    };
    const completeCancelledTurn = vi.fn(async () => {
      const pending = await database.query(
        "SELECT status FROM brainstrike_assistant_thread_runs WHERE id = 'initial'"
      );
      expect(pending.rows).toEqual([{ status: 'cancelling' }]);
    });
    const server = createServer((req, res) => {
      void handleCancelRequest(req, res, { completeCancelledTurn });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Missing control endpoint port');
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/assistant/cancel`, {
        body: JSON.stringify({ runId: 'initial' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const payload: unknown = await response.json();
      expect
        .soft({ payload, status: response.status })
        .toMatchObject({ payload: { accepted: true }, status: 200 });
      await recordDesktopAssistantThreadRunStatus(
        'initial',
        'completed',
        null,
        async () => database
      );
      await createPgliteAssistantThreadRepository(database as DbHandle).completeThreadRun(
        'initial',
        { status: 'completed' }
      );
      const cancelled = await database.query(
        "SELECT status FROM brainstrike_assistant_thread_runs WHERE id = 'initial'"
      );
      expect(cancelled.rows).toEqual([{ status: 'cancelled' }]);
      expect(completeCancelledTurn).toHaveBeenCalledOnce();
      expect(completeCancelledTurn).toHaveBeenCalledWith({
        runId: 'initial',
        threadId: 'root',
        turnRunIds: expect.arrayContaining(['initial', 'after-reload']),
      });
      const resumedController = new AbortController();
      registerSteerableRun('after-reload', resumedController);
      const repeated = await fetch(`http://127.0.0.1:${address.port}/assistant/cancel`, {
        body: JSON.stringify({ runId: 'initial' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(repeated.status).toBe(200);
      expect(resumedController.signal.aborted).toBe(true);
      unregisterSteerableRun('after-reload');
      // A new leg created AFTER cancellation must also be rejected; checking
      // only the cancelled leg's status would miss this exact restart boundary.
      await database.query(`INSERT INTO brainstrike_assistant_thread_runs
        (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, created_at, updated_at, turn_message_id)
        VALUES ('late-resume', 'owner', 'root', 'openai', 'test', 'desktop', 'running', NOW(), NOW(), NOW(), 'user-turn')`);
      const lateBinding = {
        ...binding,
        ...createDesktopDelegatedConversationHost(database, 'late-resume'),
      };
      await expect(
        claimDelegatedToolAction(action, lateBinding, { agent: parent, requiresApproval: true })
      ).rejects.toThrow();
      // Use the production durable host admission and native freshness recheck,
      // not an assumption that a missing in-memory registration invalidates a snapshot.
      await expect
        .soft(
          claimDelegatedToolAction(action, decisionBinding, {
            agent: parent,
            requiresApproval: true,
          })
        )
        .rejects.toThrow();
      const states = await readDelegatedDecisionStates(
        database,
        { ownerResourceId: 'owner', rootThreadId: 'root' },
        [action]
      );
      expect([...states.values()]).toEqual(['cancelled']);
      expect(effects).toEqual([]);
    } finally {
      server.close();
      await once(server, 'close');
      unregisterSteerableRun('initial');
    }
  } finally {
    await host?.shutdown();
    await database.close();
    holder.database = undefined;
  }
});
