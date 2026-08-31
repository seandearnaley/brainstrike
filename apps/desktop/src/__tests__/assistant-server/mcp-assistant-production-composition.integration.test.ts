import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  AgentMessage,
  AssistantToolApprovalAction,
  RuntimeData,
  StreamChunk,
} from '@brainstrike/agent';
import type { PgliteDatabase } from '@brainstrike/agent/pglite-mastra-memory';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { initializeAgentStream } from '@brainstrike/assistant-service/stream-init';
import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import type { DesktopDatabase } from '../../db-main';

const { desktopAgentStreamCapabilities, desktopAssistantServerLogger } = await import(
  '../../assistant-server'
);
const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
const { createDesktopMcpHostRuntime } = await import('../../mcp/host-runtime');

const SERVER_ID = parseConfiguredMcpServerId('linear.production');
const TOOL_ID = 'issues.create';
const MODEL_TOOL_ID = 'linear_production_issues_create';

function readApproval(chunks: readonly StreamChunk[]): AssistantToolApprovalAction {
  const approval = chunks.find(
    (chunk): chunk is Extract<StreamChunk, { type: 'tool-approval-required' }> =>
      chunk.type === 'tool-approval-required'
  );
  if (approval) {
    return {
      action: 'approve',
      runId: approval.runId,
      toolCallId: approval.toolCallId,
      toolName: approval.toolName,
    };
  }
  throw new Error(
    `BST-1538 fresh turn did not emit an approval request; observed ${chunks.map(({ type }) => type).join(', ')}`
  );
}

async function readTurn(result: Awaited<ReturnType<typeof initializeAgentStream>>) {
  if (!result.ok) {
    throw new Error(`BST-1538 assistant turn failed: ${result.payload.message}`);
  }
  const chunks: StreamChunk[] = [];
  for await (const chunk of result.stream) {
    chunks.push(chunk);
    // Mastra advances the producer and releases host leases on its setImmediate queue.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return chunks;
}

async function closeVerifier(resources: readonly Promise<unknown>[]): Promise<void> {
  const failures = (await Promise.allSettled(resources)).flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'BST-1538 verifier cleanup failed');
  }
}

it('keeps one desktop MCP host generation across fresh discovery and approval resume', async () => {
  const productionSource = readFileSync(
    path.resolve(import.meta.dirname, '../../assistant-server.ts'),
    'utf8'
  );
  // The behavioral path below supplies the host directly; this narrow source pin
  // proves the production composer selects the same singleton without coupling to key order.
  expect(productionSource).toContain('mcpHost: getDesktopMcpHostRuntime().host');
  const database = new PGlite();
  let modelTurn = 0;
  const llmHostManager = {
    generateForMain: vi.fn(async () => {
      modelTurn += 1;
      return modelTurn === 1
        ? {
            finishReason: 'tool_calls' as const,
            text: '',
            toolCalls: [
              {
                function: {
                  arguments: JSON.stringify({ title: 'Production composition proof' }),
                  name: MODEL_TOOL_ID,
                },
                id: 'bst-1538-mcp-call',
                type: 'function' as const,
              },
            ],
            usage: { completionTokens: 4, promptTokens: 8, totalTokens: 12 },
          }
        : {
            finishReason: 'stop' as const,
            text: 'BST-1538 approval resumed.',
            usage: { completionTokens: 4, promptTokens: 12, totalTokens: 16 },
          };
    }),
    warmupForMain: vi.fn(async () => undefined),
  };
  const transport = {
    callTool: vi.fn(async () => ({
      content: [{ text: 'Linear issue created', type: 'text' as const }],
    })),
    close: vi.fn(async () => undefined),
    complete: vi.fn(async () => ({ completion: { values: [] } })),
    connect: vi.fn(async () => undefined),
    getNegotiatedProtocolVersion: vi.fn(() => '2026-07-28'),
    getPrompt: vi.fn(async () => ({ messages: [] })),
    getProtocolEra: vi.fn(() => 'modern' as const),
    getServerCapabilities: vi.fn(() => ({ tools: {} })),
    getServerVersion: vi.fn(() => ({ name: 'linear-fixture', version: '1.0.0' })),
    listen: vi.fn(async () => ({
      close: vi.fn(async () => undefined),
      closed: Promise.resolve('local' as const),
      honoredFilter: {},
    })),
    listPrompts: vi.fn(async () => ({ prompts: [] })),
    listResources: vi.fn(async () => ({ cacheScope: 'private', resources: [], ttlMs: 1000 })),
    listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
    listTools: vi.fn(async () => ({
      tools: [
        {
          description: 'Create a Linear issue',
          inputSchema: {
            additionalProperties: false,
            properties: { title: { type: 'string' } },
            required: ['title'],
            type: 'object' as const,
          },
          name: TOOL_ID,
        },
      ],
    })),
    readResource: vi.fn(async () => ({ contents: [] })),
    subscribeResource: vi.fn(async () => undefined),
    unsubscribeResource: vi.fn(async () => undefined),
    watchServerFeatures: vi.fn(() => vi.fn()),
  };
  const createHttpTransportClient = vi.fn(() => transport);
  const createStdioTransportClient = vi.fn(() => transport);
  const runtime = createDesktopMcpHostRuntime({
    createHttpTransportClient,
    createStdioTransportClient,
  });
  await runtime.replaceResolvedConfig({
    servers: [
      {
        enabledTools: [TOOL_ID],
        name: SERVER_ID,
        protocol: 'auto',
        startup: 'automatic',
        transport: 'streamable-http',
        url: 'https://linear.invalid/mcp',
      },
    ],
  });

  const invoke = vi.spyOn(runtime.host, 'invoke');
  const hostClose = vi.spyOn(runtime.host, 'close');
  const realWatch = runtime.host.watch.bind(runtime.host);
  let releasedLeases = 0;
  const watch = vi.spyOn(runtime.host, 'watch').mockImplementation((filter, listener) => {
    const release = realWatch(filter, listener);
    return () => {
      releasedLeases += 1;
      release();
    };
  });
  const runtimeData: RuntimeData = {
    enabledNativeToolIds: [],
    memory: { resourceId: 'bst-1538-resource', threadId: 'bst-1538-thread' },
    model: 'onnx-community/gemma-4-E2B-it-ONNX',
    permissionPolicyRequest: {
      enforce: true,
      policies: { edit: 'deny', execute: 'deny', mcp: 'ask', read: 'allow' },
    },
    provider: 'local',
  };
  const capabilities = {
    ...desktopAgentStreamCapabilities,
    compaction: {
      ...desktopAgentStreamCapabilities.compaction,
      runPreRequest: async () => ({ kind: 'noop' as const }),
    },
    memory: {
      ...desktopAgentStreamCapabilities.memory,
      create: async () =>
        await createPgliteMastraMemory({ database: database as unknown as PgliteDatabase }),
    },
  };
  const run = (messages: AgentMessage[], approval?: AssistantToolApprovalAction) =>
    initializeAgentStream({
      apiKey: undefined,
      capabilities,
      compactionOverlayLookup: { listActiveCompactionRanges: async () => [] },
      getDatabase: async () =>
        ({ query: async () => ({ rows: [] }) }) as unknown as DesktopDatabase,
      logger: desktopAssistantServerLogger,
      mcpConfig: undefined,
      mcpHost: runtime.host,
      messages,
      resolveProviderApiKey: async () => undefined,
      runId: undefined,
      runtimeData,
      signal: new AbortController().signal,
      toolApprovalAction: approval,
      toolDependencies: { llmHostManager },
      toolProjectionRewriteLookup: undefined,
      toolResumeAction: undefined,
    });

  try {
    const approval = readApproval(
      await readTurn(
        await run([
          {
            id: 'bst-1538-user',
            parts: [{ text: 'Create the issue', type: 'text' }],
            role: 'user',
          },
        ])
      )
    );
    expect(approval.toolName).toBe(`${SERVER_ID}.${TOOL_ID}`);
    await vi.waitFor(() => expect(releasedLeases).toBe(1));
    expect(transport.close).not.toHaveBeenCalled();
    const resumed = await readTurn(await run([], approval));

    expect(resumed).toContainEqual(
      expect.objectContaining({ type: 'text-delta', value: 'BST-1538 approval resumed.' })
    );
    expect(runtime.host.snapshot().servers).toEqual([
      expect.objectContaining({ configuredServerId: SERVER_ID, generation: 1 }),
    ]);
    expect(invoke.mock.calls.map(([operation]) => operation.type)).toEqual([
      'tools/list',
      'tools/list',
      'tools/call',
    ]);
    expect(
      invoke.mock.calls.every(([operation]) => operation.configuredServerId === SERVER_ID)
    ).toBe(true);
    expect(watch).toHaveBeenCalledTimes(2);
    expect(
      watch.mock.calls.every(([filter]) => filter.configuredServerIds?.[0] === SERVER_ID)
    ).toBe(true);
    await vi.waitFor(() => expect(releasedLeases).toBe(2));
    expect(createHttpTransportClient).toHaveBeenCalledTimes(1);
    expect(createStdioTransportClient).not.toHaveBeenCalled();
    expect(transport.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: TOOL_ID }),
      expect.anything()
    );
    expect(hostClose).not.toHaveBeenCalled();
    expect(transport.close).not.toHaveBeenCalled();
  } finally {
    await closeVerifier([runtime.host.close(), database.close()]);
  }
}, 30_000);
