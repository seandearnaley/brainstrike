/**
 * BST-988: the shared fake-Mastra harness behind every `mastra-*` streaming
 * spec.
 *
 * `mastra-streaming.spec.ts` grew to one 4,246-line file because this harness
 * — the mocked `Agent`/`Mastra`/MCP classes plus the mutable stream-part queue
 * they read — could only be declared once, so every test that needed a fake
 * Mastra stream had to live beside it. Hoisting it here lets the per-module
 * specs (`mastra-tool-lifecycle.spec.ts`, `mastra-tool-approval-chunks.spec.ts`,
 * `mastra-stream-termination.spec.ts`,
 * `mastra-stream-watchdogs.integration.spec.ts`) share ONE definition.
 *
 * WHY THE MUTABLE STATE IS BEHIND SETTERS. `streamParts`, `streamPartDelayMs`,
 * `mcpToolsets` and `suspendedRuns` were plain module-scope `let`s that tests
 * reassigned directly. An ESM importer cannot assign to an imported binding, so
 * each is now module-private with an explicit setter. The arrays that tests only
 * ever READ or mutate in place (`agentInstances`, `mastraInstances`,
 * `mcpInstances`) stay exported directly.
 *
 * ISOLATION. Vitest gives every test file its own module registry, so each spec
 * gets its own copy of this state — files cannot leak into one another.
 * `resetMastraStreamHarness()` is the whole per-test reset; call it from
 * `beforeEach`.
 *
 * The `vi.mock` calls themselves MUST stay in each spec file (they are hoisted
 * per-file); a spec wires them up by returning the exported mock modules below.
 */
import { ReadableStream } from 'node:stream/web';
import {
  type McpHostJsonValue,
  type McpHostPort,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { expect } from 'vitest';
import { MastraAgentError, type MastraAgentErrorCode } from '../../mastra/mastra-agent-error';

export interface MockMastraAgentInstance {
  approveToolCallCalls: unknown[];
  config: { instructions?: string; memory?: unknown; tools: Record<string, unknown> };
  declineToolCallCalls: unknown[];
  generateTitleFromUserMessageCalls: unknown[];
  getModelCalls: unknown[];
  registeredMastra?: unknown;
  resumeStreamCalls: Array<{ options: unknown; resumeData: unknown }>;
  streamCalls: Array<{ input: unknown; options: unknown }>;
  tools: Record<string, unknown>;
}

export interface MockSuspendedRun {
  runId: string;
  status: 'suspended';
  suspendedAt: Date;
  toolCalls: Array<{
    args?: Record<string, unknown>;
    requiresApproval: boolean;
    suspendPayload?: unknown;
    toolCallId: string;
    toolName: string;
  }>;
}

export type MockMcpToolsets = Record<
  string,
  Record<string, { _meta?: Record<string, McpHostJsonValue>; description: string; id: string }>
>;

export const agentInstances: MockMastraAgentInstance[] = [];
export const mcpInstances: unknown[] = [];
export const mastraInstances: Array<{
  config: unknown;
  shutdownCalls: number;
  shutdown: () => Promise<void>;
}> = [];

let mcpToolsets: MockMcpToolsets = {};
let mcpDiscoveryFailures: Record<string, string> = {};
let mockMessageList: unknown;
let streamFailure: { call: number; error: Error } | undefined;
let streamPartDelayMs = 0;
let completeStream: () => Promise<unknown> = async () => ({});
export function setStreamCompletion(complete: () => Promise<unknown>): void {
  completeStream = complete;
}
/** Error to surface AFTER N parts have streamed (mid-iteration, not at construction). */
let streamPartFailure: { afterParts: number; error: Error } | undefined;
let streamParts: unknown[] = [];
let titleGenerationHandler:
  | ((options: unknown, call: number) => Promise<string | undefined> | string | undefined)
  | undefined;
let titleGenerationResults: Array<string | undefined | Error | Promise<string | undefined>> = [];
let titleModel: Error | object | undefined;
/**
 * Per-`stream()`-call part overrides, keyed by 1-based call number on the
 * agent instance (same numbering as `setStreamFailure`). Lets a multi-attempt
 * test give attempt 1 and attempt 2 DIFFERENT streams — e.g. an empty first
 * response recovered by a real second one — where the global `streamParts`
 * would replay the same parts on every attempt.
 */
const streamPartsForCall = new Map<number, unknown[]>();
let suspendedRuns: MockSuspendedRun[] = [];

export const mcpHost: McpHostPort = {
  close: async () => ({
    callbacksClosed: 0,
    childProcessesClosed: 0,
    clientsClosed: 0,
    failures: [],
    loopbackPortsClosed: 0,
    probesClosed: 0,
    requestsSettled: 0,
    subscriptionsClosed: 0,
  }),
  // Required by McpHostPort. No agent test drives server control through this
  // harness, so it throws rather than returning an empty snapshot that would
  // read as "control succeeded, zero servers".
  control: async () => {
    throw new Error('mastra-stream-harness does not mock MCP server control');
  },
  invoke: async (operation) => {
    const toolset = mcpToolsets[operation.configuredServerId];
    if (!toolset) {
      throw new Error(`unknown MCP server: ${operation.configuredServerId}`);
    }
    if (operation.type === 'tools/list') {
      const discoveryFailure = mcpDiscoveryFailures[operation.configuredServerId];
      if (discoveryFailure) {
        throw new Error(discoveryFailure);
      }
      return {
        result: {
          tools: Object.entries(toolset).map(([name, tool]) => ({
            ...(tool._meta ? { _meta: tool._meta } : {}),
            description: tool.description,
            inputSchema: { additionalProperties: true, type: 'object' as const },
            name,
          })),
        },
        type: operation.type,
      };
    }
    if (operation.type === 'tools/call') {
      return {
        result: { content: [{ text: 'mock MCP output', type: 'text' as const }] },
        type: operation.type,
      };
    }
    // Every other operation THROWS rather than returning a tool-call-shaped
    // result. The previous `type: operation.type` spread claimed to answer
    // prompts/*, resources/* and completion/complete with `content`, which the
    // McpHostOperationResult discriminated union does not allow — a fixture
    // silently returning the wrong shape for an operation it does not model.
    // No agent test drives those through this harness; the HTTP-client protocol
    // specs use their own fetch mocks.
    throw new Error(`mastra-stream-harness does not mock MCP operation: ${operation.type}`);
  },
  replaceConfig: async () => ({ revision: 0, servers: [] }),
  snapshot: () => ({
    revision: 1,
    servers: Object.keys(mcpToolsets).map((name) => ({
      configuredProtocol: 'legacy',
      configuredServerId: parseConfiguredMcpServerId(name),
      generation: 1,
      state: 'disconnected',
      transport: 'stdio',
    })),
  }),
  watch: () => {
    const lease = { closeCalls: 0 };
    mcpInstances.push(lease);
    return () => {
      lease.closeCalls += 1;
    };
  },
};

export function setMockStreamParts(parts: unknown[]): void {
  streamParts = [...parts];
}

export function setMockTitleGenerationResults(
  results: Array<string | undefined | Error | Promise<string | undefined>>
): void {
  titleGenerationResults = [...results];
}

export function setMockTitleGenerationHandler(
  handler:
    | ((options: unknown, call: number) => Promise<string | undefined> | string | undefined)
    | undefined
): void {
  titleGenerationHandler = handler;
}

export function setMockTitleModel(model: Error | object | undefined): void {
  titleModel = model;
}

export function setMockStreamPartsForCall(call: number, parts: unknown[]): void {
  streamPartsForCall.set(call, [...parts]);
}

export function setMockMessageList(messageList: unknown): void {
  mockMessageList = messageList;
}

export function setStreamFailure(call: number, error: Error): void {
  streamFailure = { call, error };
}

export function setStreamPartDelayMs(delayMs: number): void {
  streamPartDelayMs = delayMs;
}

/**
 * Fail the stream MID-ITERATION, after `afterParts` parts have been delivered.
 *
 * Distinct from {@link setStreamFailure}, which rejects the `agent.stream()`
 * call itself so no iterator is ever produced. Cases about an error escaping
 * WHILE consuming a stream need this one: with the construction failure the
 * consumer loop never runs, so any "and nothing downstream was emitted"
 * assertion passes trivially.
 *
 * Added because a test wanted exactly this and, lacking a seam, borrowed an
 * unrelated validation throw as its vehicle — which then broke when that
 * validation stopped throwing.
 */
export function setStreamPartFailure(afterParts: number, error: Error): void {
  streamPartFailure = { afterParts, error };
}

export function setMcpToolsets(toolsets: MockMcpToolsets): void {
  mcpToolsets = toolsets;
}

/**
 * Make one configured server's `tools/list` throw (BST-1602). The server stays
 * in `snapshot()` — it IS configured — but contributes nothing, which is
 * exactly the per-server discovery failure `collectCombinedTools` reports as a
 * `scope: 'server'` skip. Its own seam rather than a borrowed throw: see the
 * setStreamPartFailure note above.
 */
export function setMcpDiscoveryFailure(serverName: string, message: string): void {
  mcpDiscoveryFailures = { ...mcpDiscoveryFailures, [serverName]: message };
}

export function setSuspendedRuns(runs: MockSuspendedRun[]): void {
  suspendedRuns = runs;
}

/** The default suspended-run fixtures every streaming spec starts from. */
function defaultSuspendedRuns(): MockSuspendedRun[] {
  return [
    {
      runId: 'run-approval-1',
      status: 'suspended',
      suspendedAt: new Date('2026-07-21T00:00:00Z'),
      toolCalls: [
        {
          args: { path: 'src/index.ts' },
          requiresApproval: true,
          toolCallId: 'tool-call-1',
          toolName: 'workspace.writeFile',
        },
      ],
    },
    {
      runId: 'run-approval-2',
      status: 'suspended',
      suspendedAt: new Date('2026-07-21T00:00:00Z'),
      toolCalls: [
        {
          args: { command: 'echo declined' },
          requiresApproval: true,
          toolCallId: 'tool-call-2',
          toolName: 'shell_tool',
        },
      ],
    },
    {
      runId: 'run-approval-grant-all',
      status: 'suspended',
      suspendedAt: new Date('2026-07-21T00:00:00Z'),
      toolCalls: [
        {
          args: { path: 'src/index.ts' },
          requiresApproval: true,
          toolCallId: 'tool-call-grant-all',
          toolName: 'workspace.writeFile',
        },
      ],
    },
  ];
}

/** The whole per-test reset. Call from `beforeEach`. */
export function resetMastraStreamHarness(): void {
  setStreamCompletion(async () => ({}));
  agentInstances.length = 0;
  mastraInstances.length = 0;
  mcpInstances.length = 0;
  mcpDiscoveryFailures = {};
  // Every field goes through its setter, including this reset. The header
  // above advertises each as module-private behind an explicit setter; a
  // direct assignment here would silently bypass any validation or logging a
  // setter later gains (review #2173).
  setMcpToolsets({
    filesystem: {
      'remote tool': { description: 'remote', id: 'remote tool' },
    },
  });
  setMockMessageList(undefined);
  setMockStreamParts([]);
  setMockTitleGenerationHandler(undefined);
  setMockTitleGenerationResults([]);
  setMockTitleModel(undefined);
  streamPartsForCall.clear();
  streamFailure = undefined;
  streamPartFailure = undefined;
  setStreamPartDelayMs(0);
  setSuspendedRuns(defaultSuspendedRuns());
}

function createMockMastraOutput(parts: readonly unknown[] = streamParts) {
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
    async start(controller) {
      let delivered = 0;
      for (const part of parts) {
        if (streamPartDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, streamPartDelayMs));
        }
        if (cancelled) {
          return;
        }
        if (streamPartFailure && delivered === streamPartFailure.afterParts) {
          // Yield first: `controller.error()` DISCARDS whatever is still
          // queued, so erroring in the same synchronous run as the enqueues
          // would deliver NOTHING and quietly turn a mid-stream case into a
          // failed-to-start one.
          await new Promise((resolve) => setTimeout(resolve, 0));
          controller.error(streamPartFailure.error);
          return;
        }
        controller.enqueue(part);
        delivered += 1;
      }
      if (streamPartFailure && delivered === streamPartFailure.afterParts) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.error(streamPartFailure.error);
        return;
      }
      if (!cancelled) {
        controller.close();
      }
    },
  });
  return {
    fullStream: stream,
    getFullOutput: () => completeStream(),
    ...(mockMessageList ? { messageList: mockMessageList } : {}),
  } as { fullStream: ReadableStream<unknown>; getFullOutput: () => Promise<unknown> };
}

interface RunEventChunk {
  event: { kind: string; label: string; metadata?: Record<string, unknown>; status: string };
  type: 'run-event';
}

export function findRunEventChunks(chunks: readonly unknown[], kind: string): RunEventChunk[] {
  return chunks.filter(
    (chunk): chunk is RunEventChunk =>
      typeof chunk === 'object' &&
      chunk !== null &&
      (chunk as { type?: string }).type === 'run-event' &&
      (chunk as { event?: { kind?: string } }).event?.kind === kind
  );
}

export async function expectMastraAgentError(
  promise: Promise<unknown>,
  code: MastraAgentErrorCode
): Promise<void> {
  let received: unknown;
  try {
    await promise;
  } catch (error) {
    received = error;
  }

  expect(received).toBeInstanceOf(MastraAgentError);
  expect((received as MastraAgentError).code).toBe(code);
}

/**
 * Every initial-turn stream leads with the transient run-start context
 * breakdown (context-ring WS8). Assert it explicitly, then hand back the
 * remaining chunks so each test keeps its original whole-array expectation.
 */
export function expectLeadingContextBreakdown(chunks: unknown[]): unknown[] {
  expect(chunks[0]).toMatchObject({
    // Whole-breakdown provenance is ALWAYS the heuristic — tool-definition
    // precision rides toolDefinitionsProvenance (provenance must never lie).
    breakdown: { provenance: 'heuristic' },
    type: 'context-breakdown',
  });
  return chunks.slice(1);
}

/** Mock module for `@ai-sdk/openai`. */
export const openAiSdkMock = {
  createOpenAI: (config?: { apiKey?: string; baseURL?: string }) => (modelId: string) => ({
    modelId,
    provider: config?.baseURL?.includes('openrouter') ? 'openrouter' : 'openai',
    ...(modelId === 'legacy-test-model' ? { specificationVersion: 'v1' } : {}),
  }),
};

/** Mock module for `@ai-sdk/anthropic`. */
export const anthropicSdkMock = {
  createAnthropic: () => (modelId: string) => ({ modelId, provider: 'anthropic' }),
};

/** Mock module for `@ai-sdk/google`. */
export const googleSdkMock = {
  createGoogle: () => (modelId: string) => ({ modelId, provider: 'google' }),
};

/** Mock module for `@mastra/core/agent`. */
export const mastraAgentModuleMock = {
  Agent: class {
    config: { memory?: unknown; tools: Record<string, unknown> };
    approveToolCallCalls: unknown[] = [];
    declineToolCallCalls: unknown[] = [];
    generateTitleFromUserMessageCalls: unknown[] = [];
    getModelCalls: unknown[] = [];
    registeredMastra?: unknown;
    resumeStreamCalls: Array<{ options: unknown; resumeData: unknown }> = [];
    streamCalls: Array<{ input: unknown; options: unknown }> = [];
    tools: Record<string, unknown>;
    memory?: unknown;
    model?:
      | {
          apiKey?: string;
          id?: string;
          modelId?: string;
          provider?: string;
          specificationVersion?: string;
        }
      | undefined;

    constructor(config: {
      instructions?: string;
      memory?: unknown;
      tools?: Record<string, unknown>;
      model?:
        | {
            apiKey?: string;
            id?: string;
            modelId?: string;
            provider?: string;
            specificationVersion?: string;
          }
        | undefined;
    }) {
      const tools = (config.tools ?? {}) as Record<string, unknown>;
      this.config = {
        tools,
        ...(config.instructions ? { instructions: config.instructions } : {}),
        ...(config.memory ? { memory: config.memory } : {}),
      };
      this.tools = tools;
      this.memory = config.memory;
      this.model = config.model;
      agentInstances.push(this as unknown as MockMastraAgentInstance);
    }

    async stream(input: unknown, options: unknown) {
      this.streamCalls.push({ input, options });
      if (streamFailure?.call === this.streamCalls.length) {
        throw streamFailure.error;
      }
      return createMockMastraOutput(streamPartsForCall.get(this.streamCalls.length) ?? streamParts);
    }

    async approveToolCall(options: unknown) {
      this.approveToolCallCalls.push(options);
      return createMockMastraOutput();
    }

    async declineToolCall(options: unknown) {
      this.declineToolCallCalls.push(options);
      return createMockMastraOutput();
    }

    async generateTitleFromUserMessage(options: unknown) {
      this.generateTitleFromUserMessageCalls.push(options);
      if (titleGenerationHandler) {
        return await titleGenerationHandler(options, this.generateTitleFromUserMessageCalls.length);
      }
      const result = titleGenerationResults.shift();
      if (result instanceof Error) {
        throw result;
      }
      return await result;
    }

    getModel(options?: unknown) {
      this.getModelCalls.push(options);
      if (titleModel instanceof Error) {
        throw titleModel;
      }
      return titleModel ?? this.model;
    }

    listSuspendedRuns() {
      return Promise.resolve({ runs: suspendedRuns, total: suspendedRuns.length });
    }

    async resumeStream(resumeData: unknown, options: unknown) {
      this.resumeStreamCalls.push({ options, resumeData });
      return createMockMastraOutput();
    }

    __setTools(tools: Record<string, unknown>) {
      this.tools = tools;
    }

    __registerMastra(mastra: unknown) {
      this.registeredMastra = mastra;
    }
  },
};

/** Mock module for `@mastra/core/mastra`. */
export const mastraCoreModuleMock = {
  Mastra: class {
    config: unknown;
    shutdownCalls = 0;

    constructor(config: {
      agents?: Record<string, { __registerMastra?: (mastra: unknown) => void }>;
    }) {
      this.config = config;
      mastraInstances.push(this);
      for (const agent of Object.values(config.agents ?? {})) {
        agent.__registerMastra?.(this);
      }
    }

    async shutdown() {
      this.shutdownCalls += 1;
    }
  },
};

/** Mock module for `../../mcp/explicit-stdio-client`. */
export const explicitStdioMcpClientModuleMock = {
  ExplicitStdioMcpClient: class {
    closeCalls = 0;
    options: { name: string };

    constructor(options: { name: string }) {
      this.options = options;
      mcpInstances.push(this);
    }

    async callTool() {
      return { content: [{ text: 'mock MCP output', type: 'text' }] };
    }

    async close() {
      this.closeCalls += 1;
    }

    async listTools() {
      return {
        tools: Object.entries(mcpToolsets[this.options.name] ?? {}).map(([name, tool]) => ({
          ...(tool._meta ? { _meta: tool._meta } : {}),
          description: tool.description,
          inputSchema: { additionalProperties: true, type: 'object' },
          name,
        })),
      };
    }
  },
};
