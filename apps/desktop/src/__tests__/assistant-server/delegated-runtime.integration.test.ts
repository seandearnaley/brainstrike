// @vitest-environment node
/** Script only model transport and DB handle injection; use the real desktop memory,
 * Mastra stream mapper, durable host authority, and existing usage writer. */

import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '@brainstrike/agent/test-fixtures/scripted-agent-model';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { migrate, wasmLoader } from '@brainstrike/db';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
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

describe('desktop durable delegation production loop', () => {
  afterEach(async () => {
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

  it('binds a fast native child before metering it through a slow consumer, and survives engine reconstruction', async () => {
    let parentReceivedChildResult: (() => void) | undefined;
    const parentContinuation = new Promise<void>((resolve) => {
      parentReceivedChildResult = resolve;
    });
    holder.model = scriptedAgentModel((options) => {
      if (options.tools?.some((tool) => tool.name === 'agent-explore')) {
        if (hasToolResult(options, 'agent-explore')) {
          parentReceivedChildResult?.();
          return textParts('Parent: FLAG-42');
        }
        return toolCallParts('agent-explore', 'delegation-call', { prompt: 'find the flag' });
      }
      if (hasToolResult(options, 'brainstrike_grepSearch')) {
        return textParts('Child: FLAG-42');
      }
      return toolCallParts('brainstrike_grepSearch', 'child-call', { pattern: 'flag' });
    }).model;
    const memory = await getDesktopMastraMemory(settings, 'host-leg');
    expect(memory.conversationBinding?.bindRun).toBeTypeOf('function');
    const execute = vi.fn(async () => {
      expect(
        (await database.query('SELECT thread_id FROM brainstrike_delegated_invocations')).rows
      ).toHaveLength(1);
      return { matches: ['FLAG-42'] };
    });
    const stream = await streamMastraAgent(
      [{ id: 'user-turn', parts: [{ text: 'find the flag', type: 'text' }], role: 'user' }],
      {
        ...memory,
        personas: [persona],
        runtime: {
          apiKey: 'test-key',
          memory: { memorySettings: settings, resourceId: 'owner', threadId: 'root' },
          model: 'test',
          provider: 'openai',
        },
        tools: {
          'brainstrike.grepSearch': {
            description: 'Read flags',
            execute,
            id: 'brainstrike.grepSearch',
            inputSchema: z.object({ pattern: z.string() }),
          },
        },
      }
    );
    let paused = false;
    let usageCount = 0;
    for await (const chunk of persistDesktopChildRunUsage(
      observeDesktopAssistantRunEvents(stream, 'host-leg', [], async () => database),
      'host-leg',
      undefined,
      async () => database,
      true
    )) {
      if (!paused) {
        paused = true;
        await parentContinuation;
      }
      if (chunk.type === 'child-run-usage') {
        usageCount += 1;
        expect(
          (
            await database.query(
              'SELECT child_runtime_run_id FROM brainstrike_delegated_invocations'
            )
          ).rows[0]
        ).toMatchObject({
          child_runtime_run_id: expect.any(String),
        });
      }
      if (chunk.type === 'run-event') {
        expect(chunk.event.kind).not.toBe('run.failed');
      }
    }
    expect(execute).toHaveBeenCalledTimes(1);
    expect(usageCount).toBe(1);
    const read = `SELECT usage.run_id, usage.thread_id, usage.input_tokens, usage.output_tokens,
      invocation.thread_id AS child_thread_id, invocation.child_runtime_run_id,
      invocation.turn_message_id FROM brainstrike_assistant_run_usage usage
      JOIN brainstrike_delegated_invocations invocation
      ON invocation.root_thread_id = usage.thread_id
        AND invocation.parent_runtime_run_id = usage.delegation_parent_run_id
        AND invocation.parent_tool_call_id = usage.delegation_tool_call_id`;
    expect(
      (
        await database.query(`SELECT event.status FROM brainstrike_assistant_run_events event
      JOIN brainstrike_delegated_invocations invocation
        ON event.thread_id = invocation.root_thread_id
        AND event.resource_id = invocation.owner_resource_id
        AND event.metadata->>'parentRuntimeRunId' = invocation.parent_runtime_run_id
        AND event.metadata->>'parentToolCallId' = invocation.parent_tool_call_id
      WHERE event.kind = 'subagent.finished'`)
      ).rows
    ).toEqual([{ status: 'completed' }]);
    const rows = (await database.query(read)).rows;
    expect(rows).toEqual([
      expect.objectContaining({
        child_runtime_run_id: expect.any(String),
        child_thread_id: expect.any(String),
        input_tokens: 2,
        output_tokens: 2,
        run_id: 'host-leg',
        thread_id: 'root',
        turn_message_id: 'user-turn',
      }),
    ]);
    const reloaded = await createEnginePglite({ loadDataDir: await database.dumpDataDir() });
    try {
      expect((await reloaded.query(read)).rows).toEqual(rows);
    } finally {
      await reloaded.close();
    }
  });
});
