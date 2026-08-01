/**
 * BST-988: the shared fake-Mastra harness behind every `mastra-*` streaming
 * spec.
 *
 * `mastra-streaming.spec.ts` grew to one 4,246-line file because this harness
 * — the mocked `Agent`/`Mastra`/MCP classes plus the mutable stream-part queue
 * they read — could only be declared once, so every test that needed a fake
 * Mastra stream had to live beside it. Hoisting it here lets the per-module
 * specs (`mastra-tool-lifecycle.spec.ts`, `mastra-tool-approval-chunks.spec.ts`,
 * `mastra-stream-termination.spec.ts`) share ONE definition.
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
import { expect } from 'vitest';
import { MastraAgentError, type MastraAgentErrorCode } from '../../mastra/mastra-agent-error';

export interface MockMastraAgentInstance {
  approveToolCallCalls: unknown[];
  config: { instructions?: string; memory?: unknown; tools: Record<string, unknown> };
  declineToolCallCalls: unknown[];
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
    args: Record<string, unknown>;
    requiresApproval: true;
    toolCallId: string;
    toolName: string;
  }>;
}

export type MockMcpToolsets = Record<string, Record<string, { description: string; id: string }>>;

export const agentInstances: MockMastraAgentInstance[] = [];
export const mcpInstances: unknown[] = [];
export const mastraInstances: Array<{ config: unknown; shutdownCalls: number }> = [];

let mcpToolsets: MockMcpToolsets = {};
let streamPartDelayMs = 0;
let streamParts: unknown[] = [];
let suspendedRuns: MockSuspendedRun[] = [];

export function setMockStreamParts(parts: unknown[]): void {
  streamParts = [...parts];
}

export function setStreamPartDelayMs(delayMs: number): void {
  streamPartDelayMs = delayMs;
}

export function setMcpToolsets(toolsets: MockMcpToolsets): void {
  mcpToolsets = toolsets;
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
  agentInstances.length = 0;
  mastraInstances.length = 0;
  mcpInstances.length = 0;
  mcpToolsets = {
    filesystem: {
      'remote tool': { description: 'remote', id: 'remote tool' },
    },
  };
  setMockStreamParts([]);
  streamPartDelayMs = 0;
  suspendedRuns = defaultSuspendedRuns();
}

function createMockMastraOutput() {
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
    async start(controller) {
      for (const part of streamParts) {
        if (streamPartDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, streamPartDelayMs));
        }
        if (cancelled) {
          return;
        }
        controller.enqueue(part);
      }
      if (!cancelled) {
        controller.close();
      }
    },
  });
  return {
    fullStream: stream,
  } as { fullStream: ReadableStream<unknown> };
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
  createGoogleGenerativeAI: () => (modelId: string) => ({ modelId, provider: 'google' }),
};

/** Mock module for `@mastra/core/agent`. */
export const mastraAgentModuleMock = {
  Agent: class {
    static reset() {
      agentInstances.length = 0;
    }

    config: { memory?: unknown; tools: Record<string, unknown> };
    approveToolCallCalls: unknown[] = [];
    declineToolCallCalls: unknown[] = [];
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
      return createMockMastraOutput();
    }

    async approveToolCall(options: unknown) {
      this.approveToolCallCalls.push(options);
      return createMockMastraOutput();
    }

    async declineToolCall(options: unknown) {
      this.declineToolCallCalls.push(options);
      return createMockMastraOutput();
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
          description: tool.description,
          inputSchema: { additionalProperties: true, type: 'object' },
          name,
        })),
      };
    }
  },
};
