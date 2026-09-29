// @vitest-environment node
/** Script only model transport and DB handle injection; use the real desktop memory,
 * Mastra stream mapper, durable host authority, and existing usage writer. */

import type { StreamChunk } from '@brainstrike/agent';
import {
  hasToolResult,
  parallelToolCallParts,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '@brainstrike/agent/test-fixtures/scripted-agent-model';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getDesktopMastraMemory } from '../../assistant-server/mastra-memory';
import {
  observeDesktopAssistantRunEvents,
  persistDesktopChildRunUsage,
  recordDesktopAssistantThreadRunStatus,
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

describe('desktop delegated usage failure outcomes', () => {
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

  it('preserves the usage rejection and settles both active children after native cleanup', async () => {
    await database.exec(
      "UPDATE brainstrike_assistant_thread_runs SET generation_run_id='host-leg' WHERE id='host-leg'"
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let started = 0;
    let dispatched = false;
    holder.model = scriptedAgentModel((options) => {
      if (options.tools?.some((tool) => tool.name === 'agent-explore')) {
        if (dispatched) {
          return textParts('Waiting for both children.');
        }
        dispatched = true;
        return parallelToolCallParts(
          ['Alpha', 'Beta'].map((name) => ({
            args: {
              _background: { enabled: true, maxRetries: 0, timeoutMs: 30_000 },
              prompt: name,
            },
            toolCallId: name,
            toolName: 'agent-explore',
          }))
        );
      }
      if (hasToolResult(options, 'brainstrike_grepSearch')) {
        return textParts('Child complete.');
      }
      const name = JSON.stringify(
        options.prompt.filter((message) => message.role === 'user').at(-1)
      ).includes('Alpha')
        ? 'Alpha'
        : 'Beta';
      return toolCallParts('brainstrike_grepSearch', `read-${name}`, { pattern: name });
    }).model;
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
            execute: async (_input: unknown, context?: { readonly abortSignal?: AbortSignal }) => {
              const signal = context?.abortSignal;
              if (!signal) {
                throw new Error('Missing native executor signal');
              }
              const aborted = Promise.withResolvers<void>();
              const onAbort = () => aborted.resolve();
              signal.addEventListener('abort', onAbort, { once: true });
              started += 1;
              if (started === 2) {
                entered.resolve();
              }
              try {
                await Promise.race([release.promise, aborted.promise]);
                return { matches: ['FLAG'] };
              } finally {
                signal.removeEventListener('abort', onAbort);
              }
            },
            id: 'brainstrike.grepSearch',
            inputSchema: z.object({ pattern: z.string() }),
          },
        },
      }
    );
    let injected = false;
    async function* rejectSecondUsage(): AsyncIterable<StreamChunk> {
      for await (const chunk of stream) {
        if (
          !injected &&
          chunk.type === 'child-run-usage' &&
          chunk.value.delegation?.parentToolCallId === 'Beta'
        ) {
          await entered.promise;
          expect(
            (
              await database.query(
                'SELECT status FROM mastra_background_tasks ORDER BY tool_call_id'
              )
            ).rows
          ).toEqual([{ status: 'running' }, { status: 'running' }]);
          injected = true;
          yield {
            ...chunk,
            value: {
              ...chunk.value,
              delegation: { ...chunk.value.delegation, resourceId: 'wrong-owner' },
            },
          };
        } else {
          yield chunk;
        }
      }
    }
    try {
      const consuming = async () => {
        for await (const _chunk of persistDesktopChildRunUsage(
          observeDesktopAssistantRunEvents(
            rejectSecondUsage(),
            'host-leg',
            [],
            async () => database
          ),
          'host-leg',
          undefined,
          async () => database,
          true
        )) {
          /* Drain the production persistence chain. */
        }
      };
      await expect(consuming()).rejects.toMatchObject({ reason: 'usage-binding-conflict' });
      expect(injected).toBe(true);
      // The HTTP error handler records the root status after joining stream cleanup.
      await recordDesktopAssistantThreadRunStatus(
        'host-leg',
        'failed',
        'usage-binding-conflict',
        async () => database
      );
      const native = (
        await database.query(
          'SELECT tool_call_id,status FROM mastra_background_tasks ORDER BY tool_call_id'
        )
      ).rows;
      const durable = (
        await database.query(
          "SELECT status FROM brainstrike_assistant_thread_runs WHERE id <> 'host-leg' ORDER BY id"
        )
      ).rows;
      const terminal = (
        await database.query(
          "SELECT kind,status FROM brainstrike_assistant_run_events WHERE run_id <> 'host-leg' AND kind IN ('run.finished','run.failed','run.cancelled') ORDER BY run_id"
        )
      ).rows;
      console.info('[BST1771-ACCEPTANCE]', JSON.stringify({ durable, native, terminal }));
      expect(native).toEqual([
        { status: 'cancelled', tool_call_id: 'Alpha' },
        { status: 'cancelled', tool_call_id: 'Beta' },
      ]);
      expect(durable).toEqual([{ status: 'cancelled' }, { status: 'cancelled' }]);
      expect(terminal).toEqual([
        { kind: 'run.cancelled', status: 'cancelled' },
        { kind: 'run.cancelled', status: 'cancelled' },
      ]);
      expect(
        (
          await database.query(
            'SELECT delegation_tool_call_id,input_tokens,output_tokens FROM brainstrike_assistant_run_usage ORDER BY delegation_tool_call_id'
          )
        ).rows
      ).toEqual([{ delegation_tool_call_id: 'Alpha', input_tokens: 1, output_tokens: 1 }]);
      expect(
        (
          await database.query(
            "SELECT status FROM brainstrike_assistant_thread_runs WHERE id='host-leg'"
          )
        ).rows
      ).toEqual([{ status: 'failed' }]);
    } finally {
      release.resolve();
    }
  });
});
