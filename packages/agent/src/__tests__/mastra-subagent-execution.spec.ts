/**
 * End-to-end coverage for the REAL Mastra supervisor/subagent delegation loop.
 *
 * Like mastra-tool-execution.spec.ts, this file does NOT mock
 * `@mastra/core/agent`. It drives the real `streamMastraAgent` → real supervisor
 * `Agent` (with `agents` config built by `buildPersonaSubAgents`) → real child
 * `Agent` → real child tool `execute` path. ONE scripted `LanguageModelV2` serves
 * BOTH levels, discriminated by `options.tools`: when the tool set contains the
 * `agent-explore` delegation tool it is the PARENT; otherwise it is the CHILD.
 */
import { ReadableStream } from 'node:stream/web';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { PGlite } from '@electric-sql/pglite';
import { createTool } from '@mastra/core/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PgliteDatabase } from '../pglite-mastra-memory';
import type { StreamChunk } from '../types';

const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as LanguageModelV2 | undefined },
}));

vi.mock('../providers/provider-factory', async (importActual) => {
  const actual = await importActual<typeof import('../providers/provider-factory')>();
  return {
    ...actual,
    createProvider: () => {
      if (!modelHolder.current) {
        throw new Error('test fake model was not configured');
      }
      return modelHolder.current;
    },
    getDefaultModel: () => 'fake-model',
  };
});

const { streamMastraAgent, createMastraAgentRuntime } = await import('../mastra/agent-runtime');
const { createPgliteMastraMemory } = await import('../pglite-mastra-memory');

const OM_DISABLED_MEMORY_SETTINGS = {
  ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  observationalMemory: {
    ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
    enabled: false,
  },
};

interface PersistedMessageRow {
  content: string | { parts?: Record<string, unknown>[] };
  id: string;
  resourceId: string;
  role: string;
  thread_id: string;
}

function parsePersistedParts(row: PersistedMessageRow): Record<string, unknown>[] {
  const content = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
  return Array.isArray(content?.parts) ? (content.parts as Record<string, unknown>[]) : [];
}

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

const DELEGATION_TOOL = 'agent-explore';
// The parent tool map is keyed by original id `brainstrike.grepSearch`; the
// sanitizer renames dots to underscores, so the model sees `brainstrike_grepSearch`.
const CHILD_TOOL = 'brainstrike_grepSearch';

const testPersona: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.grepSearch'],
  description: 'Explore the workspace and report findings.',
  id: 'explore',
  instructions: 'You are the Explorer subagent.',
  label: 'Explorer',
  maxSteps: 8,
};

function toolNamesOf(options: LanguageModelV2CallOptions): string[] {
  const tools = (options as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .map((tool) =>
      tool && typeof tool === 'object' ? (tool as { name?: unknown }).name : undefined
    )
    .filter((name): name is string => typeof name === 'string');
}

function promptHasToolResult(options: LanguageModelV2CallOptions): boolean {
  return Array.isArray(options.prompt) && options.prompt.some((message) => message.role === 'tool');
}

function enqueue(parts: LanguageModelV2StreamPart[]): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

function toolCallStream(
  toolName: string,
  toolCallId: string,
  input: string
): LanguageModelV2StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { input, toolCallId, toolName, type: 'tool-call' },
    { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
  ];
}

function finalTextStream(text: string): LanguageModelV2StreamPart[] {
  const id = 'text-final';
  return [
    { type: 'stream-start', warnings: [] },
    { id, type: 'text-start' },
    { delta: text, id, type: 'text-delta' },
    { id, type: 'text-end' },
    { finishReason: 'stop', type: 'finish', usage: USAGE },
  ];
}

/**
 * A two-level scripted model. PARENT (has agent-explore): turn 1 delegates,
 * then produces a final answer once the delegation result is in the prompt.
 * CHILD (has the native tool, no agent-explore): turn 1 calls its tool, then
 * produces its written summary once the tool result is in the prompt.
 */
function createSupervisorModel(childToolCallId: string): LanguageModelV2 {
  return {
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: (options: LanguageModelV2CallOptions) => {
      const isParent = toolNamesOf(options).includes(DELEGATION_TOOL);
      const hasResult = promptHasToolResult(options);
      if (isParent) {
        return Promise.resolve({
          stream: enqueue(
            hasResult
              ? finalTextStream('PARENT_ANSWER: the flag is FLAG-42.')
              : toolCallStream(
                  DELEGATION_TOOL,
                  'delegation-call-1',
                  JSON.stringify({ prompt: 'find the flag' })
                )
          ),
        });
      }
      return Promise.resolve({
        stream: enqueue(
          hasResult
            ? finalTextStream('CHILD_ANSWER: found FLAG-42 in the workspace.')
            : toolCallStream(CHILD_TOOL, childToolCallId, JSON.stringify({ pattern: 'flag' }))
        ),
      });
    },
    modelId: 'fake-model',
    provider: 'fake',
    specificationVersion: 'v2',
    supportedUrls: {},
  };
}

interface CollectedStream {
  delegationToolEvents: StreamChunk[];
  finalText: string;
  runEvents: Array<{ kind: string; metadata?: Record<string, unknown> }>;
  toolEventNames: string[];
}

async function collect(iterator: AsyncIterable<StreamChunk>): Promise<CollectedStream> {
  const runEvents: Array<{ kind: string; metadata?: Record<string, unknown> }> = [];
  const delegationToolEvents: StreamChunk[] = [];
  const toolEventNames: string[] = [];
  let finalText = '';
  for await (const chunk of iterator) {
    if (chunk.type === 'run-event') {
      runEvents.push({
        kind: chunk.event.kind,
        ...(chunk.event.metadata ? { metadata: chunk.event.metadata } : {}),
      });
    } else if (chunk.type === 'text-delta') {
      finalText += chunk.value;
    } else if (chunk.type === 'tool-event') {
      const name = typeof chunk.name === 'string' ? chunk.name : '';
      toolEventNames.push(name);
      if (name === DELEGATION_TOOL) {
        delegationToolEvents.push(chunk);
      }
    }
  }
  return { delegationToolEvents, finalText, runEvents, toolEventNames };
}

function makeChildTool(spy: ReturnType<typeof vi.fn>) {
  return createTool({
    description: 'Search the workspace for a pattern.',
    execute: spy,
    id: 'brainstrike_grepSearch',
    inputSchema: z.object({ pattern: z.string() }),
    outputSchema: z.object({ matches: z.array(z.string()) }),
  });
}

describe('mastra subagent delegation (real @mastra/core supervisor loop)', () => {
  beforeEach(() => {
    modelHolder.current = undefined;
  });

  it('delegates to a real child agent whose tool executes, and surfaces subagent.* run events', async () => {
    const childCallId = 'child-call-1';
    const executeSpy = vi.fn(() => Promise.resolve({ matches: ['found FLAG-42'] }));
    modelHolder.current = createSupervisorModel(childCallId);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'find the flag', type: 'text' }], role: 'user' }],
      {
        personas: [testPersona],
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: { 'brainstrike.grepSearch': makeChildTool(executeSpy) },
      }
    );

    const { delegationToolEvents, finalText, runEvents, toolEventNames } = await collect(iterator);
    const kinds = runEvents.map((event) => event.kind);

    // The child tool actually executed through the REAL delegation loop.
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[0]).toMatchObject({ pattern: 'flag' });

    // The parent produced its final answer after incorporating the delegation.
    expect(finalText).toContain('PARENT_ANSWER');

    // Generic delegation lifecycle stays intact (existing timeline unbroken).
    expect(kinds).toContain('tool.started');
    expect(kinds).toContain('tool.completed');

    // New subagent.* run events, in order, all sharing parentToolCallId.
    const subagentEvents = runEvents.filter((event) => event.kind.startsWith('subagent'));
    const subagentKinds = subagentEvents.map((event) => event.kind);
    expect(subagentKinds).toEqual([
      'subagent.started',
      'subagent.tool.started',
      'subagent.tool.completed',
      'subagent.finished',
    ]);
    for (const event of subagentEvents) {
      expect(event.metadata?.parentToolCallId).toBe('delegation-call-1');
      expect(event.metadata?.personaId).toBe('explore');
    }
    const toolStarted = subagentEvents.find((event) => event.kind === 'subagent.tool.started');
    expect(toolStarted?.metadata?.toolCallId).toBe(childCallId);

    // The delegation tool-result carries the raw subAgentToolResults with the
    // child's toolCallId (available to the UI / hydration).
    const successEvent = delegationToolEvents.find(
      (event) => event.type === 'tool-event' && event.status === 'success'
    );
    expect(successEvent).toBeDefined();
    const payload =
      successEvent && successEvent.type === 'tool-event'
        ? (successEvent.payload as {
            result?: { subAgentToolResults?: Array<{ toolCallId?: string }> };
          })
        : undefined;
    const subAgentToolResults = payload?.result?.subAgentToolResults ?? [];
    expect(subAgentToolResults.some((entry) => entry.toolCallId === childCallId)).toBe(true);

    // The nested child chunks did NOT leak a second `agent-explore`-named
    // success tool-event per nested chunk (delegation tool-output is bypassed).
    const delegationSuccesses = delegationToolEvents.filter(
      (event) => event.type === 'tool-event' && event.status === 'success'
    );
    expect(delegationSuccesses).toHaveLength(1);
    // No child tool-event surfaced on the parent stream (nested → subagent.* only).
    expect(toolEventNames).not.toContain(CHILD_TOOL);
  });

  it('does NOT delegate when personas are absent (no-personas regression pin)', async () => {
    const executeSpy = vi.fn(() => Promise.resolve({ matches: [] }));
    // No personas → the delegation tool is never registered; the model sees only
    // the native tool and (per the child branch) calls it directly.
    modelHolder.current = createSupervisorModel('unused');

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'find the flag', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: { 'brainstrike.grepSearch': makeChildTool(executeSpy) },
      }
    );

    const { runEvents, toolEventNames } = await collect(iterator);
    const kinds = runEvents.map((event) => event.kind);
    expect(kinds.some((kind) => kind.startsWith('subagent'))).toBe(false);
    expect(toolEventNames).not.toContain(DELEGATION_TOOL);
  });

  it('drops persona delegation tools in plan mode', async () => {
    modelHolder.current = createSupervisorModel('unused');
    const runtime = await createMastraAgentRuntime({
      personas: [testPersona],
      runtime: { apiKey: 'test-key', planMode: true, provider: 'openai' },
      storage: undefined,
      tools: { 'brainstrike.grepSearch': makeChildTool(vi.fn()) },
    });
    expect(runtime.delegationToolPersonas.size).toBe(0);
    expect(runtime.personasById.size).toBe(0);
    await runtime.dispose();
  });

  it('does not build delegation tools for the local provider', async () => {
    modelHolder.current = createSupervisorModel('unused');
    const runtime = await createMastraAgentRuntime({
      personas: [testPersona],
      runtime: { apiKey: 'test-key', provider: 'local' },
      tools: { 'brainstrike.grepSearch': makeChildTool(vi.fn()) },
    });
    expect(runtime.delegationToolPersonas.size).toBe(0);
    await runtime.dispose();
  });
});

describe('mastra subagent delegation persistence (real PGlite memory)', () => {
  let database: PGlite;

  beforeEach(() => {
    database = new PGlite();
    modelHolder.current = undefined;
  });

  afterEach(async () => {
    await database.close();
  });

  it('persists the delegation as a tool-invocation part with inline subAgentToolResults; child rows live under a suffixed thread', async () => {
    const childCallId = 'child-call-persist';
    const parentThreadId = 'thread-supervisor-1';
    const resourceId = 'resource-supervisor-test';
    modelHolder.current = createSupervisorModel(childCallId);
    const { memory } = await createPgliteMastraMemory({
      database: database as unknown as PgliteDatabase,
      memorySettings: OM_DISABLED_MEMORY_SETTINGS,
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'find the flag', type: 'text' }], role: 'user' }],
      {
        memory,
        personas: [testPersona],
        runtime: {
          apiKey: 'test-key',
          memory: {
            memorySettings: OM_DISABLED_MEMORY_SETTINGS,
            resourceId,
            threadId: parentThreadId,
          },
          provider: 'openai',
        },
        tools: { 'brainstrike.grepSearch': makeChildTool(vi.fn()) },
      }
    );
    for await (const _chunk of iterator) {
      // Drain the stream so Mastra finalizes persistence.
    }

    const allRows = (
      await database.query(
        'SELECT id, role, content, thread_id, "resourceId" FROM mastra_messages ORDER BY "createdAt" ASC'
      )
    ).rows as PersistedMessageRow[];

    // Parent thread: the delegation persists as a Mastra v2 tool-invocation
    // part (toolName agent-explore) whose inline result carries the child's
    // subAgentToolResults — the empirical pin of §2.4/D11a.
    const parentRows = allRows.filter((row) => row.thread_id === parentThreadId);
    const parentParts = parentRows.flatMap(parsePersistedParts);
    const delegationPart = parentParts.find(
      (part) =>
        part['type'] === 'tool-invocation' &&
        (part['toolInvocation'] as { toolName?: string } | undefined)?.toolName === 'agent-explore'
    );
    expect(delegationPart).toBeDefined();
    const invocation = delegationPart?.['toolInvocation'] as {
      result?: { subAgentToolResults?: Array<{ toolCallId?: string }> };
      state?: string;
    };
    expect(invocation?.state).toBe('result');
    const persistedSubResults = invocation?.result?.subAgentToolResults ?? [];
    expect(persistedSubResults.some((entry) => entry.toolCallId === childCallId)).toBe(true);

    // Child rows never pollute the parent thread; they live under a delegation
    // thread prefixed `${parentThreadId}-` with resourceId `${resourceId}-explore`.
    const childRows = allRows.filter((row) => row.thread_id !== parentThreadId);
    expect(childRows.length).toBeGreaterThan(0);
    for (const row of childRows) {
      expect(row.thread_id.startsWith(`${parentThreadId}-`)).toBe(true);
      expect(row.resourceId).toBe(`${resourceId}-explore`);
    }
  }, 30_000);
});
