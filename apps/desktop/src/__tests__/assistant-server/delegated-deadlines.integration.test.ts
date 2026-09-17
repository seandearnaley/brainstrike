// @vitest-environment node
/** Script only model transport and DB handle injection; use the real desktop memory,
 * Mastra stream mapper, durable host authority, and existing usage writer. */

import {
  hasToolResult,
  parallelToolCallParts,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '@brainstrike/agent/test-fixtures/scripted-agent-model';
import { buildNativeToolRiskMap, getToolActionTarget } from '@brainstrike/assistant-contract';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { migrate, wasmLoader } from '@brainstrike/db';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
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
const { streamMastraAgent, streamMastraToolApprovalAction } = await import('@brainstrike/agent');

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

describe('desktop delegated deadline outcomes', () => {
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

  it.each(['stop', 'deadline'] as const)(
    'selectively ends Alpha by %s while Beta keeps its native and durable running state',
    async (ending) => {
      await database.exec(
        "UPDATE brainstrike_assistant_thread_runs SET generation_run_id='host-leg' WHERE id='host-leg'"
      );
      const release = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let started = 0;
      const alphaTerminal = Promise.withResolvers<void>();
      const alphaFailureDetails: (string | undefined)[] = [];
      holder.model = scriptedAgentModel((options) => {
        if (options.tools?.some((tool) => tool.name === 'agent-explore')) {
          if (hasToolResult(options, 'agent-explore')) {
            return textParts('Parent progress.');
          }
          return parallelToolCallParts(
            ['Alpha', 'Beta'].map((name) => ({
              args: {
                prompt: name,
                ...(ending === 'deadline'
                  ? {
                      _background: {
                        enabled: true,
                        maxRetries: 0,
                        timeoutMs: name === 'Alpha' ? 1000 : 30_000,
                      },
                    }
                  : {}),
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
        )?.includes('Alpha')
          ? 'Alpha'
          : 'Beta';
        return toolCallParts('brainstrike_grepSearch', `held-${name}`, { pattern: 'held' });
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
              execute: async (
                _input: unknown,
                context?: { readonly abortSignal?: AbortSignal }
              ) => {
                const signal = context?.abortSignal;
                if (!signal) {
                  throw new Error('Missing native tool signal');
                }
                started += 1;
                if (started === 2) {
                  entered.resolve();
                }
                const aborted = Promise.withResolvers<void>();
                const onAbort = () => aborted.resolve();
                signal.addEventListener('abort', onAbort, { once: true });
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
      const consuming = (async () => {
        for await (const chunk of persistDesktopChildRunUsage(
          observeDesktopAssistantRunEvents(stream, 'host-leg', [], async () => database),
          'host-leg',
          undefined,
          async () => database,
          true
        )) {
          if (
            chunk.type === 'delegated-conversation-chunk' &&
            chunk.identity.parentToolCallId === 'Alpha' &&
            chunk.chunk.type === 'run-event' &&
            chunk.chunk.event.kind === 'run.failed'
          ) {
            alphaFailureDetails.push(chunk.chunk.event.detail);
          }
          // Unscoped run events belong to the root; child failures stay scoped.
          if (chunk.type === 'run-event') {
            expect(chunk.event.kind).not.toBe('run.failed');
          }
          if (ending === 'deadline') {
            const alphaState = await database.query<{ status: string }>(
              "SELECT status FROM mastra_background_tasks WHERE tool_call_id='Alpha'"
            );
            if (
              ['completed', 'failed', 'timed_out', 'cancelled'].includes(
                alphaState.rows[0]?.status ?? ''
              )
            ) {
              alphaTerminal.resolve();
            }
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
        if (ending === 'deadline') {
          await Promise.race([
            alphaTerminal.promise,
            consuming.then(() => {
              throw new Error('Stream ended before Alpha failed');
            }),
          ]);
        } else {
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
        }
        const native = (
          await database.query(
            'SELECT tool_call_id, status FROM mastra_background_tasks ORDER BY tool_call_id'
          )
        ).rows;
        expect(native).toEqual([
          { status: ending === 'deadline' ? 'timed_out' : 'cancelled', tool_call_id: 'Alpha' },
          { status: 'running', tool_call_id: 'Beta' },
        ]);
        const durable = (
          await database.query(
            'SELECT invocation.parent_tool_call_id, runs.status FROM brainstrike_delegated_invocations invocation JOIN brainstrike_assistant_thread_runs runs ON runs.thread_id=invocation.thread_id ORDER BY invocation.parent_tool_call_id'
          )
        ).rows;
        expect(durable).toEqual([
          { parent_tool_call_id: 'Alpha', status: ending === 'deadline' ? 'failed' : 'cancelled' },
          { parent_tool_call_id: 'Beta', status: 'running' },
        ]);
        release.resolve();
        await consuming;
        if (ending === 'deadline') {
          expect(alphaFailureDetails).toEqual(['Error: Task timed out after 1000ms']);
        }
        expect(
          (
            await database.query(
              "SELECT metadata->>'parentToolCallId' AS child, kind FROM brainstrike_assistant_run_events WHERE kind IN ('run.cancelled', 'run.failed', 'run.finished') AND run_id != 'host-leg' ORDER BY child"
            )
          ).rows
        ).toEqual([
          { child: 'Alpha', kind: ending === 'deadline' ? 'run.failed' : 'run.cancelled' },
          { child: 'Beta', kind: 'run.finished' },
        ]);
        expect(
          (
            await database.query(
              'SELECT tool_call_id, status FROM mastra_background_tasks ORDER BY tool_call_id'
            )
          ).rows
        ).toEqual([
          { status: ending === 'deadline' ? 'timed_out' : 'cancelled', tool_call_id: 'Alpha' },
          { status: 'completed', tool_call_id: 'Beta' },
        ]);
      } finally {
        release.resolve();
        await Promise.allSettled([consuming]);
      }
    }
  );

  it('persists replacement usage after a sibling deadline while another child remains active', async () => {
    await database.exec(
      "UPDATE brainstrike_assistant_thread_runs SET generation_run_id='host-leg' WHERE id='host-leg'"
    );
    const release = Promise.withResolvers<void>();
    let parentCalls = 0;
    holder.model = scriptedAgentModel((options) => {
      if (options.tools?.some((tool) => tool.name === 'agent-explore')) {
        parentCalls += 1;
        if (parentCalls === 1) {
          return parallelToolCallParts(
            ['Alpha', 'Beta'].map((name) => ({
              args: {
                _background: {
                  enabled: true,
                  maxRetries: 0,
                  timeoutMs: name === 'Alpha' ? 1000 : 30_000,
                },
                prompt: name,
              },
              toolCallId: name,
              toolName: 'agent-explore',
            }))
          );
        }
        if (parentCalls === 3) {
          return toolCallParts('agent-explore', 'replacement', { prompt: 'Replacement evidence' });
        }
        return textParts('Parent progress.');
      }
      const prompt = JSON.stringify(
        options.prompt.filter((message) => message.role === 'user').at(-1)
      );
      if (
        prompt?.includes('Replacement evidence') ||
        hasToolResult(options, 'brainstrike_grepSearch')
      ) {
        return textParts('Child evidence.');
      }
      return toolCallParts(
        'brainstrike_grepSearch',
        prompt?.includes('Alpha') ? 'alpha-read' : 'beta-read',
        { pattern: 'held' }
      );
    }).model;
    const runtime = {
      apiKey: 'test-key',
      memory: { memorySettings: settings, resourceId: 'owner', threadId: 'root' },
      model: 'test',
      provider: 'openai',
    };
    const memory = await getDesktopMastraMemory(settings, 'host-leg', undefined, runtime);
    const stream = await streamMastraAgent(
      [{ id: 'user-turn', parts: [{ text: 'Run evidence children', type: 'text' }], role: 'user' }],
      {
        ...memory,
        personas: [persona],
        runtime,
        tools: {
          'brainstrike.grepSearch': {
            description: 'Read evidence',
            execute: async (_input: unknown, context?: { readonly abortSignal?: AbortSignal }) => {
              const signal = context?.abortSignal;
              if (!signal) {
                throw new Error('Missing native executor signal');
              }
              const aborted = Promise.withResolvers<void>();
              const onAbort = () => aborted.resolve();
              signal.addEventListener('abort', onAbort, { once: true });
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
    let replacementUsage = false;
    try {
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
        if (
          chunk.type === 'child-run-usage' &&
          chunk.value.delegation?.parentToolCallId === 'replacement'
        ) {
          replacementUsage = true;
          expect(
            (
              await database.query(
                "SELECT tool_call_id,status FROM mastra_background_tasks WHERE tool_call_id IN ('Alpha','Beta') ORDER BY tool_call_id"
              )
            ).rows
          ).toEqual([
            { status: 'timed_out', tool_call_id: 'Alpha' },
            { status: 'running', tool_call_id: 'Beta' },
          ]);
          release.resolve();
        }
      }
      expect(replacementUsage).toBe(true);
      expect(
        (
          await database.query(
            "SELECT delegation_tool_call_id,input_tokens,output_tokens FROM brainstrike_assistant_run_usage WHERE run_kind='subagent' ORDER BY delegation_tool_call_id"
          )
        ).rows
      ).toEqual([
        { delegation_tool_call_id: 'Alpha', input_tokens: 1, output_tokens: 1 },
        { delegation_tool_call_id: 'Beta', input_tokens: 2, output_tokens: 2 },
        { delegation_tool_call_id: 'replacement', input_tokens: 1, output_tokens: 1 },
      ]);
      const invocations = (
        await database.query<{ parent_runtime_run_id: string }>(
          'SELECT parent_runtime_run_id FROM brainstrike_delegated_invocations'
        )
      ).rows;
      expect(invocations).toHaveLength(3);
      expect(new Set(invocations.map((row) => row.parent_runtime_run_id)).size).toBe(2);
    } finally {
      release.resolve();
    }
  });

  it.each(['stop', 'approve', 'deadline'] as const)(
    'persists the actual model response before a delegated approval and retains exact usage after %s and reload',
    async (mode) => {
      let childCalls = 0;
      holder.model = scriptedAgentModel((options) => {
        if (
          JSON.stringify(
            options.prompt.filter((message) => message.role === 'user').at(-1)
          )?.includes('ROOT_RUNTIME_TASK')
        ) {
          return hasToolResult(options, 'agent-explore')
            ? textParts('Parent: FLAG-42')
            : toolCallParts('agent-explore', 'delegation-call', {
                prompt: 'find the flag',
                ...(mode === 'deadline'
                  ? { _background: { enabled: true, maxRetries: 0, timeoutMs: 1000 } }
                  : {}),
              });
        }
        childCalls += 1;
        return hasToolResult(options, 'brainstrike_grepSearch')
          ? textParts('Child: FLAG-42')
          : toolCallParts('brainstrike_grepSearch', 'child-call', { pattern: 'flag' });
      }).model;
      const backgroundRuntime = {
        apiKey: 'test-key',
        memory: { memorySettings: settings, resourceId: 'owner', threadId: 'root' },
        model: 'test',
        provider: 'openai',
      };
      if (mode === 'deadline') {
        await database.exec(
          "UPDATE brainstrike_assistant_thread_runs SET generation_run_id='host-leg' WHERE id='host-leg'"
        );
      }
      const backing = await getDesktopMastraMemory(
        settings,
        'host-leg',
        undefined,
        mode === 'deadline' ? backgroundRuntime : undefined
      );
      const execute = vi.fn(
        async (_input: unknown, context?: { readonly abortSignal?: AbortSignal }) => {
          if (mode === 'deadline') {
            const signal = context?.abortSignal;
            if (!signal) {
              throw new Error('Missing resumed execution signal');
            }
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve();
                return;
              }
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          }
          return { matches: ['FLAG-42'] };
        }
      );
      const options = {
        ...backing,
        model: 'test',
        personas: [persona],
        runtime: {
          apiKey: 'test-key',
          memory: { memorySettings: settings, resourceId: 'owner', threadId: 'root' },
          model: 'test',
          permissionPolicy: {
            policies: {
              edit: 'deny' as const,
              execute: 'deny' as const,
              mcp: 'deny' as const,
              read: 'ask' as const,
            },
            riskByTool: buildNativeToolRiskMap(),
            yolo: false,
          },
          provider: 'openai' as const,
        },
        tools: {
          'brainstrike.grepSearch': {
            description: 'Read flags',
            execute,
            id: 'brainstrike.grepSearch',
            inputSchema: z.object({ pattern: z.string() }),
          },
        },
      };
      const stream = await streamMastraAgent(
        [
          {
            id: 'user-turn',
            parts: [{ text: 'ROOT_RUNTIME_TASK: find the flag', type: 'text' }],
            role: 'user',
          },
        ],
        options
      );
      const chunks = [];
      for await (const chunk of persistDesktopChildRunUsage(
        observeDesktopAssistantRunEvents(stream, 'host-leg', [], async () => database),
        'host-leg',
        undefined,
        async () => database,
        true
      )) {
        chunks.push(chunk);
      }
      const pending = chunks.find((chunk) => chunk.type === 'tool-approval-required');
      if (pending?.type !== 'tool-approval-required') {
        throw new Error('Missing exact native approval');
      }
      expect(childCalls).toBe(1);
      expect(execute).not.toHaveBeenCalled();
      const query =
        'SELECT run_id, input_tokens, output_tokens FROM brainstrike_assistant_run_usage WHERE delegation_tool_call_id=$1';
      expect((await database.query(query, ['delegation-call'])).rows).toEqual([
        { input_tokens: 1, output_tokens: 1, run_id: 'host-leg' },
      ]);
      const child = (
        await database.query<{ thread_id: string }>(
          'SELECT thread_id FROM brainstrike_delegated_invocations'
        )
      ).rows[0];
      if (!child) {
        throw new Error('Missing admitted child');
      }
      const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
      if (mode === 'stop') {
        const targets = await revokeDelegatedConversationAdmission(
          database,
          scope,
          child.thread_id,
          false
        );
        await completeDelegatedConversationCancellation(database, scope, targets);
      } else {
        await database.exec(`UPDATE brainstrike_assistant_thread_runs SET status='completed' WHERE id='host-leg';
        INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id)
        VALUES ('resume-host','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'user-turn');`);
        if (mode === 'deadline') {
          await database.exec(
            "UPDATE brainstrike_assistant_thread_runs SET generation_run_id='host-leg' WHERE id='resume-host'"
          );
        }
        const resumed = await streamMastraToolApprovalAction(
          { ...getToolActionTarget(pending), action: 'approve' },
          {
            ...options,
            ...(await getDesktopMastraMemory(
              settings,
              'resume-host',
              undefined,
              mode === 'deadline' ? backgroundRuntime : undefined
            )),
          }
        );
        for await (const _chunk of persistDesktopChildRunUsage(
          observeDesktopAssistantRunEvents(resumed, 'resume-host', [], async () => database),
          'resume-host',
          undefined,
          async () => database,
          true
        )) {
          // The production writer owns durable usage before its refresh becomes visible.
        }
      }
      const reloaded = await createEnginePglite({ loadDataDir: await database.dumpDataDir() });
      try {
        const expected = mode === 'approve' ? 2 : 1;
        expect((await reloaded.query(query, ['delegation-call'])).rows).toEqual([
          { input_tokens: expected, output_tokens: expected, run_id: 'host-leg' },
        ]);
        expect(execute).toHaveBeenCalledTimes(mode === 'stop' ? 0 : 1);
        // Native resume enters the next model step before its aborted stream
        // settles; that invocation contributes no additional persisted usage.
        expect(childCalls).toBe(mode === 'stop' ? 1 : 2);
        if (mode === 'deadline') {
          expect(
            (
              await reloaded.query(
                "SELECT status FROM mastra_background_tasks WHERE tool_call_id='delegation-call'"
              )
            ).rows
          ).toEqual([{ status: 'timed_out' }]);
          expect(
            (
              await reloaded.query(
                'SELECT status FROM brainstrike_assistant_thread_runs WHERE thread_id=$1',
                [child.thread_id]
              )
            ).rows
          ).toEqual([{ status: 'failed' }, { status: 'failed' }]);
          expect(
            (
              await reloaded.query(
                "SELECT kind, detail FROM brainstrike_assistant_run_events WHERE thread_id=$1 AND kind IN ('run.finished','run.failed','run.cancelled')",
                [child.thread_id]
              )
            ).rows
          ).toEqual([{ detail: 'Error: Task timed out after 1000ms', kind: 'run.failed' }]);
        }
      } finally {
        await reloaded.close();
      }
    }
  );
});
