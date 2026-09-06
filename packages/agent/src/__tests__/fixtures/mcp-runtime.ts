import {
  type McpHostOperationResult,
  type McpHostPort,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { parseMcpHostOperationResult } from '@brainstrike/assistant-contract/mcp-host-runtime';
import type { ToolsInput } from '@mastra/core/agent';
import { vi } from 'vitest';
import type { ExplicitHttpMcpCallToolResult } from '../../mcp/explicit-http-client';

export type ExecutableTool = ToolsInput[string] & {
  execute: (input: unknown, context?: unknown) => Promise<unknown>;
  inputSchema?: unknown;
  outputSchema?: unknown;
  toModelOutput?: (output: unknown) => unknown;
};

export function requireExecutableTool(tool: ToolsInput[string] | undefined): ExecutableTool {
  if (!tool || typeof (tool as { execute?: unknown }).execute !== 'function') {
    throw new Error('Expected an executable MCP tool');
  }
  return tool as ExecutableTool;
}

interface TestHostClient {
  callTool: (...args: unknown[]) => Promise<ExplicitHttpMcpCallToolResult>;
  close: ReturnType<typeof vi.fn>;
  listTools: () => Promise<{ tools: unknown[] }>;
  release?: () => void;
}

export function createTestHost(clients: Record<string, TestHostClient>): {
  host: McpHostPort;
  unwatch: ReturnType<typeof vi.fn>;
} {
  const unwatch = vi.fn();
  const host: McpHostPort = {
    close: vi.fn(async () => ({
      callbacksClosed: 0,
      childProcessesClosed: 0,
      clientsClosed: 0,
      failures: [],
      loopbackPortsClosed: 0,
      probesClosed: 0,
      requestsSettled: 0,
      subscriptionsClosed: 0,
    })),
    control: vi.fn(async () => {
      throw new Error('Test host controls are not supported');
    }),
    invoke: vi.fn<McpHostPort['invoke']>(async (operation, options) => {
      const client = clients[operation.configuredServerId];
      if (!client) {
        throw new Error('unknown server');
      }
      if (operation.type === 'tools/list') {
        // Catalog fixtures cross the same validated DTO boundary as the host.
        // Unlike raw Tasks/Apps call results below, these are ordinary core lists.
        return parseMcpHostOperationResult({
          result: await client.listTools(),
          type: 'tools/list',
        });
      }
      if (operation.type !== 'tools/call') {
        throw new Error('Test host only supports tools/list and tools/call');
      }
      // Task/App fixtures deliberately inject their raw result shape at this
      // boundary. Parsing them as core CallToolResult would add content: []
      // and conceal precisely the raw-envelope behavior these tests exercise.
      return {
        result: await client.callTool(
          {
            ...(operation._meta ? { _meta: operation._meta } : {}),
            ...(operation.arguments ? { arguments: operation.arguments } : {}),
            name: operation.toolName,
          },
          {
            ...(options?.onProgress ? { onprogress: options.onProgress } : {}),
            ...(options?.signal ? { signal: options.signal } : {}),
          }
        ),
        type: 'tools/call',
      } as unknown as McpHostOperationResult;
    }),
    replaceConfig: vi.fn(),
    snapshot: () => ({
      revision: 1,
      servers: Object.keys(clients).map((name) => ({
        configuredProtocol: 'legacy' as const,
        configuredServerId: parseConfiguredMcpServerId(name),
        generation: 7,
        state: 'disconnected' as const,
        transport: 'stdio' as const,
      })),
    }),
    watch: vi.fn((filter) => {
      const ids = filter.configuredServerIds;
      if (ids?.length !== 1) {
        throw new Error('test host requires one configured server id per lease');
      }
      return clients[ids[0]]?.release ?? unwatch;
    }),
  };
  return { host, unwatch };
}
