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
import {
  decodeToolOutputArtifactContent,
  isToolOutputArtifactEnvelope,
  isToolOutputArtifactPage,
} from '@brainstrike/assistant-contract/tool-output-artifact';
import { buildUserPersona } from '@brainstrike/assistant-contract/user-personas';
import {
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
} from '@brainstrike/assistant-data';
import { buildToolOutputArtifactCapabilities } from '@brainstrike/assistant-service/stream-init';
import { BrainstrikeDataStreamRuntimeAdapter } from '@brainstrike/assistant-ui/data-stream-runtime';
import { migrate, ToolOutputArtifactRepository, wasmLoader } from '@brainstrike/db';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { DbHandle } from '@brainstrike/db/react';
import type { PGlite } from '@electric-sql/pglite';
import type { AssistantMessage } from 'assistant-stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createArtifactReaderModelProjection } from '../../assistant-server/artifact-reader-model-projection';
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
const {
  streamMastraAgent,
  createStatelessAssistantDataStreamResponse,
  readToolOutputArtifact,
  NATIVE_TOOL_INPUT_SCHEMAS,
} = await import('@brainstrike/agent');

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

  it('retains distinct oversized output from siblings that reuse a native tool call id', async () => {
    const userPersona = buildUserPersona({
      content: '---\ndescription: Recover complete evidence\n---\nRead and recover all evidence.',
      fileName: 'artifact-recovery.md',
    });
    if (!userPersona.ok) {
      throw new Error(userPersona.error);
    }
    let childIndex = 0;
    const recovered: string[] = [];
    const completions: unknown[] = [];
    const modelPage = z.object({
      type: z.literal('json'),
      value: z.object({
        complete: z.literal(true).optional(),
        content: z.string(),
        contentEncoding: z.literal('json-string').optional(),
        next: z.object({ input: z.object({ cursor: z.string() }), tool: z.string() }).optional(),
      }),
    });
    holder.model = scriptedAgentModel((options) => {
      const isParent = JSON.stringify(
        options.prompt.filter((message) => message.role === 'user').at(-1)
      )?.includes('ROOT_RUNTIME_TASK');
      if (isParent && hasToolResult(options, 'agent-artifact-recovery')) {
        return textParts('Parent summary.');
      }
      const results = options.prompt.flatMap((message) =>
        message.role === 'tool' ? message.content : []
      );
      const last = results.at(-1);
      if (!isParent && last) {
        const page = modelPage.parse(last.output).value;
        if (page.next) {
          return toolCallParts(page.next.tool, `read-${results.length}`, page.next.input);
        }
        completions.push(page.complete);
        recovered.push(
          results
            .map((result) => {
              const value = modelPage.parse(result.output).value;
              return decodeToolOutputArtifactContent(value.content, value.contentEncoding);
            })
            .join('')
        );
        return textParts('Child recovered complete evidence.');
      }
      if (isParent) {
        // One stream-start, two tool calls, then one tool-calls finish.
        return [
          ...toolCallParts('agent-artifact-recovery', 'first-delegation', {
            prompt: 'First task',
          }).slice(0, 2),
          ...toolCallParts('agent-artifact-recovery', 'second-delegation', {
            prompt: 'Second task',
          }).slice(1),
        ];
      }
      childIndex += 1;
      return toolCallParts('brainstrike_grepSearch', 'reused-child-call', {
        pattern: `child-${childIndex}`,
      });
    }).model;
    const runtime = {
      apiKey: 'test-key',
      memory: { memorySettings: settings, resourceId: 'owner', threadId: 'root' },
      model: 'test',
      provider: 'openai',
    };
    const artifacts = buildToolOutputArtifactCapabilities(
      runtime,
      'host-leg',
      async () => database,
      {
        capabilities: {
          artifacts: { createRepository: () => new ToolOutputArtifactRepository(database) },
        },
      }
    );
    const memory = await getDesktopMastraMemory(settings, 'host-leg');
    const executed: string[] = [];
    const stream = await streamMastraAgent(
      [
        {
          id: 'user-turn',
          parts: [{ text: 'ROOT_RUNTIME_TASK: Run both tasks.', type: 'text' }],
          role: 'user',
        },
      ],
      {
        ...memory,
        personas: [userPersona.persona],
        runtime,
        toolOutputArtifactStore: artifacts.toolOutputArtifactStore,
        tools: {
          'brainstrike.grepSearch': {
            description: 'Read evidence',
            execute: async (input: { pattern: string }) => {
              executed.push(input.pattern);
              return { matches: [input.pattern.repeat(2000)] };
            },
            id: 'brainstrike.grepSearch',
            inputSchema: z.object({ pattern: z.string() }),
          },
          'brainstrike.readToolOutputArtifact': {
            description: 'Read artifact',
            execute: async (input: unknown) => {
              if (!artifacts.toolOutputArtifactReader) {
                throw new Error('Missing artifact reader');
              }
              const parsed =
                NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.readToolOutputArtifact'].parse(input);
              return readToolOutputArtifact(
                { ...parsed, mode: 'cursor' },
                { reader: artifacts.toolOutputArtifactReader }
              );
            },
            id: 'brainstrike.readToolOutputArtifact',
            inputSchema: NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.readToolOutputArtifact'],
            toModelOutput: createArtifactReaderModelProjection(() => 12_000),
          },
        },
      }
    );
    const response = createStatelessAssistantDataStreamResponse(
      observeDesktopAssistantRunEvents(stream, 'host-leg', [], async () => database),
      { messageId: 'parent-message' }
    );
    const decoded = new Map<string, AssistantMessage>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    );
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test',
      onDelegatedConversation: (update) => {
        decoded.set(update.messageId, update.message);
      },
    });
    let parent: AssistantMessage | undefined;
    for await (const message of adapter.resume(
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
      {
        eventId: 'host-leg:-1',
        resumeApi: 'http://assistant.test/resume',
      }
    )) {
      parent = message as AssistantMessage;
    }
    expect(
      parent?.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
    ).toBe('Parent summary.');
    expect(fetch).toHaveBeenCalledOnce();
    expect(decoded.size).toBe(2);
    expect(completions).toEqual([true, true]);
    expect(executed.sort()).toEqual(['child-1', 'child-2']);
    const stored = await database.query<{ id: string }>(
      'SELECT id FROM brainstrike_assistant_tool_output_artifacts ORDER BY id'
    );
    expect(stored.rows).toHaveLength(2);
    expect(recovered.sort()).toEqual(
      ['child-1', 'child-2'].map((label) => JSON.stringify({ matches: [label.repeat(2000)] }))
    );
    const scopes = await database.query<{
      thread_id: string;
      resource_id: string;
      artifact_id: string;
    }>(`
      SELECT child.thread_id, child.resource_id, artifact.id AS artifact_id
      FROM brainstrike_delegated_conversations child
      JOIN brainstrike_assistant_tool_output_artifacts artifact
        ON artifact.execution_thread_id = child.thread_id
      WHERE artifact.thread_id = 'root' AND artifact.resource_id = 'owner'
        AND artifact.run_id = 'host-leg' AND artifact.tool_call_id = 'reused-child-call'`);
    expect(scopes.rows).toHaveLength(2);
    const reloaded = await createEnginePglite({ loadDataDir: await database.dumpDataDir() });
    try {
      const reader = buildToolOutputArtifactCapabilities(runtime, undefined, async () => reloaded, {
        capabilities: {
          artifacts: { createRepository: () => new ToolOutputArtifactRepository(reloaded) },
        },
      }).toolOutputArtifactReader;
      if (!reader) {
        throw new Error('Missing reconstructed artifact reader');
      }
      for (const child of scopes.rows) {
        const load = (db: PGlite) =>
          createAssistantThreadHistoryAdapter({
            repository: createPgliteAssistantThreadRepository(db as unknown as DbHandle),
            resourceId: child.resource_id,
            threadId: child.thread_id,
          }).load();
        const history = await load(reloaded);
        expect(history).toEqual(await load(database));
        const results = history.messages
          .flatMap(({ message }) => (message.role === 'assistant' ? message.content : []))
          .filter((part) => part.type === 'tool-call' && part.toolCallId === 'reused-child-call');
        expect(results).toHaveLength(1);
        const result = results[0];
        if (result?.type !== 'tool-call' || !isToolOutputArtifactEnvelope(result.result)) {
          throw new Error('Missing hydrated artifact envelope');
        }
        expect(result.result.artifactRef.id).toBe(child.artifact_id);
        const liveResults = [...decoded.values()]
          .flatMap((message) => message.parts)
          .filter(
            (part) =>
              part.type === 'tool-call' &&
              isToolOutputArtifactEnvelope(part.result) &&
              part.result.artifactRef.id === child.artifact_id
          );
        expect(liveResults).toHaveLength(1);
        expect(liveResults[0]).toMatchObject({
          result: result.result,
          toolCallId: 'reused-child-call',
        });
        const bytes = [
          decodeToolOutputArtifactContent(result.result.preview, result.result.contentEncoding),
        ];
        let cursor: string | undefined = result.result.nextCursor;
        while (cursor) {
          const page: Awaited<ReturnType<typeof readToolOutputArtifact>> =
            await readToolOutputArtifact({ cursor, mode: 'cursor' }, { reader });
          if (!isToolOutputArtifactPage(page)) {
            throw new Error('Expected continuation page');
          }
          bytes.push(decodeToolOutputArtifactContent(page.content, page.contentEncoding));
          cursor = page.nextCursor;
        }
        expect(recovered).toContain(bytes.join(''));
      }
    } finally {
      await reloaded.close();
    }
  });

  it.each([false, true])(
    'retains the cancelled child transcript and paired terminal events after engine reconstruction (partial text: %s)',
    async (partialText) => {
      const abort = new AbortController();
      const toolStarted = Promise.withResolvers<void>();
      holder.model = scriptedAgentModel((options) => {
        if (
          JSON.stringify(
            options.prompt.filter((message) => message.role === 'user').at(-1)
          )?.includes('ROOT_RUNTIME_TASK')
        ) {
          return toolCallParts('agent-explore', 'cancelled-delegation', {
            prompt: 'find the flag',
          });
        }
        return [
          ...(partialText
            ? textParts('Partial child evidence.').slice(0, -1)
            : [{ type: 'stream-start' as const, warnings: [] }]),
          ...toolCallParts('brainstrike_grepSearch', 'waiting-tool', { pattern: 'flag' }).slice(1),
        ];
      }).model;
      const memory = await getDesktopMastraMemory(settings, 'host-leg');
      if (!memory.memory) {
        throw new Error('Native memory is unavailable');
      }
      const stream = await streamMastraAgent(
        [
          {
            id: 'user-turn',
            parts: [{ text: 'ROOT_RUNTIME_TASK: find the flag', type: 'text' }],
            role: 'user',
          },
        ],
        {
          ...memory,
          personas: [persona],
          runtime: {
            apiKey: 'test-key',
            memory: { memorySettings: settings, resourceId: 'owner', threadId: 'root' },
            model: 'test',
            provider: 'openai',
            signal: abort.signal,
          },
          tools: {
            'brainstrike.grepSearch': {
              description: 'Read flags',
              execute: () =>
                new Promise<{ matches: string[] }>((resolve) => {
                  toolStarted.resolve();
                  if (abort.signal.aborted) {
                    resolve({ matches: [] });
                    return;
                  }
                  abort.signal.addEventListener('abort', () => resolve({ matches: [] }), {
                    once: true,
                  });
                }),
              id: 'brainstrike.grepSearch',
              inputSchema: z.object({ pattern: z.string() }),
            },
          },
        }
      );
      const liveEventIds: string[] = [];
      let liveText = '';
      for await (const chunk of observeDesktopAssistantRunEvents(
        stream,
        'host-leg',
        [],
        async () => database
      )) {
        if (chunk.type !== 'delegated-conversation-chunk') {
          continue;
        }
        if (chunk.chunk.type === 'text-delta') {
          liveText += chunk.chunk.value;
        }
        if (chunk.chunk.type === 'run-event') {
          liveEventIds.push(chunk.chunk.event.id);
        }
        if (chunk.chunk.type === 'tool-event' && chunk.chunk.status === 'start') {
          // The queue publishes the call before execution. This case exercises
          // cancellation of a running tool and its late native memory write.
          await toolStarted.promise;
          abort.abort();
          const child = (
            await database.query<{ thread_id: string; resource_id: string }>(
              "SELECT thread_id, resource_id FROM brainstrike_delegated_conversations WHERE parent_thread_id = 'root'"
            )
          ).rows[0];
          if (!child) {
            throw new Error('Missing running child');
          }
          // Before the suspended consumer resumes terminal snapshot settlement,
          // inject a late native write through Memory. Root abort now prevents the
          // old automatic write; the frozen visible snapshot must still win.
          await memory.memory.saveMessages({
            messages: [
              {
                content: {
                  format: 2,
                  parts: [
                    {
                      text: 'Late native write must not replace the cancelled snapshot.',
                      type: 'text',
                    },
                    {
                      toolInvocation: {
                        args: { pattern: 'flag' },
                        result: { matches: [] },
                        state: 'result',
                        toolCallId: 'waiting-tool',
                        toolName: 'brainstrike_grepSearch',
                      },
                      type: 'tool-invocation',
                    },
                  ],
                },
                createdAt: new Date(),
                id: chunk.messageId,
                resourceId: child.resource_id,
                role: 'assistant',
                threadId: child.thread_id,
              },
            ],
          });
        }
      }
      expect(abort.signal.aborted).toBe(true);
      expect(liveText).toBe(partialText ? 'Partial child evidence.' : '');
      const child = (
        await database.query<{ thread_id: string; resource_id: string }>(
          "SELECT thread_id, resource_id FROM brainstrike_delegated_conversations WHERE parent_thread_id = 'root'"
        )
      ).rows[0];
      if (!child) {
        throw new Error('Missing cancelled native child');
      }
      const reloaded = await createEnginePglite({ loadDataDir: await database.dumpDataDir() });
      try {
        const load = (db: PGlite) =>
          createAssistantThreadHistoryAdapter({
            repository: createPgliteAssistantThreadRepository(db as unknown as DbHandle),
            resourceId: child.resource_id,
            threadId: child.thread_id,
          }).load();
        const history = await load(reloaded);
        expect(await load(database)).toEqual(history);
        const content = history.messages.flatMap(({ message }) =>
          message.role === 'assistant' ? message.content : []
        );
        if (partialText) {
          expect(content).toContainEqual(expect.objectContaining({ text: liveText, type: 'text' }));
        }
        expect(content).not.toContainEqual(
          expect.objectContaining({
            text: 'Late native write must not replace the cancelled snapshot.',
          })
        );
        expect(content.filter((part) => part.type === 'tool-call')).toEqual([]);
        const events = content
          .flatMap((part) =>
            part.type === 'data' && part.name === 'brainstrike.run-event' ? [part.data] : []
          )
          .map((event) =>
            z.object({ id: z.string(), kind: z.string(), status: z.string() }).parse(event)
          );
        expect(events.map((event) => event.id)).toEqual(liveEventIds);
        expect(events.filter((event) => event.kind === 'run.cancelled')).toHaveLength(1);
        expect(events.filter((event) => event.kind === 'tool.failed')).toMatchObject([
          { status: 'cancelled' },
        ]);
      } finally {
        await reloaded.close();
      }
    }
  );

  it('binds a fast native child before metering it through a slow consumer, and survives engine reconstruction', async () => {
    let parentReceivedChildResult: (() => void) | undefined;
    const parentContinuation = new Promise<void>((resolve) => {
      parentReceivedChildResult = resolve;
    });
    holder.model = scriptedAgentModel((options) => {
      if (
        JSON.stringify(
          options.prompt.filter((message) => message.role === 'user').at(-1)
        )?.includes('ROOT_RUNTIME_TASK')
      ) {
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
      [
        {
          id: 'user-turn',
          parts: [{ text: 'ROOT_RUNTIME_TASK: find the flag', type: 'text' }],
          role: 'user',
        },
      ],
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
    const childEventIds: string[] = [];
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
      if (chunk.type === 'delegated-conversation-chunk' && chunk.chunk.type === 'run-event') {
        childEventIds.push(chunk.chunk.event.id);
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
      const child = (
        await database.query<{ thread_id: string; resource_id: string }>(
          "SELECT thread_id, resource_id FROM brainstrike_delegated_conversations WHERE parent_thread_id = 'root'"
        )
      ).rows[0];
      expect(child).toBeDefined();
      if (!child) {
        throw new Error('Missing native child');
      }
      expect(childEventIds.length).toBeGreaterThan(2);
      const load = async (db: PGlite) =>
        createAssistantThreadHistoryAdapter({
          repository: createPgliteAssistantThreadRepository(db as unknown as DbHandle),
          resourceId: child.resource_id,
          threadId: child.thread_id,
        }).load();
      const before = await load(database);
      expect(await load(reloaded)).toEqual(before);
      const assistant = before.messages.filter(({ message }) => message.role === 'assistant');
      expect(assistant).toHaveLength(1);
      const content = assistant.flatMap(({ message }) =>
        message.role === 'assistant' ? message.content : []
      );
      expect(content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'Child: FLAG-42', type: 'text' }),
          expect.objectContaining({
            result: { matches: ['FLAG-42'] },
            toolCallId: 'child-call',
            type: 'tool-call',
          }),
        ])
      );
      const hydratedIds = content
        .flatMap((part) =>
          part.type === 'data' && part.name === 'brainstrike.run-event' ? [part.data] : []
        )
        .map((event) => z.object({ id: z.string() }).parse(event).id);
      expect(hydratedIds).toEqual(childEventIds);
      expect(JSON.stringify(before)).not.toContain('Parent: FLAG-42');
    } finally {
      await reloaded.close();
    }
  });
});
