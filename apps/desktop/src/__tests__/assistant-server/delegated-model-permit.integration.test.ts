// @vitest-environment node
/** Real desktop/Mastra/PGlite cancellation and model-permit regressions. */
import {
  hasToolResult,
  parallelToolCallParts,
  scriptedAgentModel,
  textParts,
} from '@brainstrike/agent/test-fixtures/scripted-agent-model';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  completeDelegatedConversationCancellation,
  revokeDelegatedConversationAdmission,
} from '../../assistant-server/delegated-cancellation-admission';
import { joinDesktopDelegatedCancellation } from '../../assistant-server/delegated-execution-controls';
import { getDesktopMastraMemory } from '../../assistant-server/mastra-memory';
import {
  observeDesktopAssistantRunEvents,
  persistDesktopChildRunUsage,
} from '../../assistant-server/run-persistence';

const holder = vi.hoisted(() => ({
  database: undefined as PGlite | undefined,
  model: undefined as ReturnType<typeof scriptedAgentModel>['model'] | undefined,
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
vi.mock('@brainstrike/agent/providers/provider-factory', async (original) => ({
  ...(await original<{ createProvider: typeof import('@brainstrike/agent')['createProvider'] }>()),
  createProvider: () => {
    if (!holder.model) {
      throw new Error('Model not initialized');
    }
    return holder.model;
  },
}));
const { streamMastraAgent } = await import('@brainstrike/agent');

const settings = {
  ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  observationalMemory: {
    ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
    enabled: false,
  },
};
const persona: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.grepSearch'],
  description: 'Find the requested flag.',
  id: 'explore',
  instructions: 'Read and report the flag.',
  label: 'Explorer',
  maxSteps: 8,
};

describe('desktop selective cancellation', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await holder.database?.close();
    holder.database = undefined;
    holder.model = undefined;
  });

  let database: PGlite;
  // The suite's existing database hook timeout owns full migration setup.
  beforeEach(async () => {
    database = await wasmLoader.createPGlite('memory://delegated-runtime');
    holder.database = database;
    await migrate(database);
    await database.exec(`INSERT INTO mastra_threads
      (id, "resourceId", title, metadata, "createdAt", "updatedAt")
      VALUES ('root', 'owner', 'Root', '{}', NOW(), NOW());
      INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status,
       started_at, created_at, updated_at, turn_message_id)
      VALUES ('host-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
        NOW(), NOW(), NOW(), 'user-turn');`);
  });

  it('releases a stopped model permit while Beta streams and Gamma completes', async () => {
    await database.exec(
      "UPDATE brainstrike_assistant_thread_runs SET generation_run_id='host-leg' WHERE id='host-leg'"
    );
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let started = 0;
    let gammaStarted = false;
    const transport = scriptedAgentModel((options) => {
      if (options.tools?.some((tool) => tool.name === 'agent-explore')) {
        return hasToolResult(options, 'agent-explore')
          ? textParts('Parent progress.')
          : parallelToolCallParts(
              ['Alpha', 'Beta', 'Gamma'].map((name) => ({
                args: { prompt: name },
                toolCallId: name,
                toolName: 'agent-explore',
              }))
            );
      }
      return textParts('Child complete.');
    });
    holder.model = {
      ...transport.model,
      doStream: async (options) => {
        const response = await transport.model.doStream(options);
        if (options.tools?.some((tool) => tool.name === 'agent-explore')) {
          return response;
        }
        const prompt = JSON.stringify(
          options.prompt.filter((message) => message.role === 'user').at(-1)
        );
        if (prompt.includes('Gamma')) {
          gammaStarted = true;
          return response;
        }
        started += 1;
        if (started === 2) {
          entered.resolve();
        }
        return {
          ...response,
          stream: response.stream.pipeThrough(
            new TransformStream({
              async transform(part, controller) {
                if (part.type === 'finish') {
                  await release.promise;
                }
                controller.enqueue(part);
              },
            })
          ),
        };
      },
    };
    const runtime = {
      apiKey: 'test-key',
      memory: { memorySettings: settings, resourceId: 'owner', threadId: 'root' },
      model: 'test',
      provider: 'openai',
    };
    const memory = await getDesktopMastraMemory(settings, 'host-leg', undefined, runtime);
    const stream = await streamMastraAgent(
      [{ id: 'user-turn', parts: [{ text: 'Run both children', type: 'text' }], role: 'user' }],
      {
        ...memory,
        personas: [persona],
        runtime,
        tools: {
          'brainstrike.grepSearch': {
            description: 'Read flags',
            execute: async () => ({ matches: ['FLAG'] }),
            id: 'brainstrike.grepSearch',
            inputSchema: z.object({ pattern: z.string() }),
          },
        },
      }
    );
    const consuming = (async () => {
      for await (const chunk of persistDesktopChildRunUsage(
        observeDesktopAssistantRunEvents(stream, 'host-leg', [], async () => database),
        'host-leg',
        undefined,
        async () => database,
        true
      )) {
        if (chunk.type === 'run-event') {
          expect(chunk.event.kind).not.toBe('run.failed');
        }
      }
    })();
    consuming.catch(() => {});
    try {
      await Promise.race([
        entered.promise,
        consuming.then(() => {
          throw new Error('Stream ended before both tools started');
        }),
      ]);
      expect(gammaStarted).toBe(false);
      const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
      const alpha = (
        await database.query<{ thread_id: string }>(
          "SELECT thread_id FROM brainstrike_delegated_invocations WHERE parent_tool_call_id='Alpha'"
        )
      ).rows[0];
      if (!alpha) {
        throw new Error('Missing Alpha');
      }
      const targets = await revokeDelegatedConversationAdmission(
        database,
        scope,
        alpha.thread_id,
        false
      );
      await joinDesktopDelegatedCancellation(database, scope, targets);
      await completeDelegatedConversationCancellation(database, scope, targets);
      await expect.poll(() => gammaStarted).toBe(true);
      await expect
        .poll(
          async () =>
            (
              await database.query<{ status: string }>(
                "SELECT status FROM mastra_background_tasks WHERE tool_call_id='Gamma'"
              )
            ).rows[0]?.status
        )
        .toBe('completed');
      const native = (
        await database.query(
          'SELECT tool_call_id, status FROM mastra_background_tasks ORDER BY tool_call_id'
        )
      ).rows;
      expect(native).toEqual([
        { status: 'cancelled', tool_call_id: 'Alpha' },
        { status: 'running', tool_call_id: 'Beta' },
        { status: 'completed', tool_call_id: 'Gamma' },
      ]);
      const durable = (
        await database.query(
          'SELECT invocation.parent_tool_call_id, runs.status FROM brainstrike_delegated_invocations invocation JOIN brainstrike_assistant_thread_runs runs ON runs.thread_id=invocation.thread_id ORDER BY invocation.parent_tool_call_id'
        )
      ).rows;
      expect(durable).toEqual([
        { parent_tool_call_id: 'Alpha', status: 'cancelled' },
        { parent_tool_call_id: 'Beta', status: 'running' },
        { parent_tool_call_id: 'Gamma', status: 'completed' },
      ]);
      release.resolve();
      await consuming;
      expect(
        (
          await database.query(
            "SELECT metadata->>'parentToolCallId' AS child, kind FROM brainstrike_assistant_run_events WHERE kind IN ('run.cancelled', 'run.failed', 'run.finished') AND run_id != 'host-leg' ORDER BY child"
          )
        ).rows
      ).toEqual([
        { child: 'Alpha', kind: 'run.cancelled' },
        { child: 'Beta', kind: 'run.finished' },
        { child: 'Gamma', kind: 'run.finished' },
      ]);
      expect(
        (
          await database.query(
            'SELECT tool_call_id, status FROM mastra_background_tasks ORDER BY tool_call_id'
          )
        ).rows
      ).toEqual([
        { status: 'cancelled', tool_call_id: 'Alpha' },
        { status: 'completed', tool_call_id: 'Beta' },
        { status: 'completed', tool_call_id: 'Gamma' },
      ]);
    } finally {
      release.resolve();
      await Promise.allSettled([consuming]);
    }
  });
});
