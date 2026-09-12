import { createServer } from 'node:http';
import {
  getToolActionTarget,
  type McpHostPort,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { parseMcpHostOperationResult } from '@brainstrike/assistant-contract/mcp-host-runtime';
import { BUILT_IN_PERSONAS } from '@brainstrike/assistant-contract/personas';
import { InMemoryStore } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer, type Transport } from '@modelcontextprotocol/server';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createDelegatedConversationBinding,
  type DelegatedConversationIdentity,
  type DelegatedToolActionScope,
} from '../mastra/delegated-conversation-binding';
import type { DelegatedRunIdentity } from '../mastra/delegated-run-publication';
import { ExplicitHttpMcpClient } from '../mcp/explicit-http-client';
import { ExplicitStdioMcpClient } from '../mcp/explicit-stdio-client';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../test-fixtures/scripted-agent-model';
import type { StreamChunk } from '../types';

const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as ReturnType<typeof scriptedAgentModel>['model'] | undefined },
}));
vi.mock('../providers/provider-factory', async (original) => ({
  ...(await original<typeof import('../providers/provider-factory')>()),
  createProvider: () => {
    if (!modelHolder.current) {
      throw new Error('Missing scripted model');
    }
    return modelHolder.current;
  },
}));
const { streamMastraAgent, streamMastraToolApprovalAction } = await import(
  '../mastra/agent-streaming'
);

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

// Runtime assembly and native approval are real; this in-memory host port is
// deliberately not another proof of desktop persistence or process restart.
it.each([true, false])('restores worker MCP tools (memory=%s)', async (withMemory) => {
  const action = 'approve';
  const worker = BUILT_IN_PERSONAS.find((persona) => persona.id === 'worker');
  expect(worker, 'The production built-in worker must be available after BST-1720').toBeDefined();
  if (!worker) {
    throw new Error('Built-in worker is not implemented');
  }
  const failures: unknown[] = [];
  const server = await startWorkerMcpServer();
  const mcpHost = createRealTransportMcpHost({
    name: 'remote',
    transport: 'streamable-http',
    url: server.url,
  });
  try {
    const preToolUse = vi.fn(async () => ({ decision: 'allow' as const }));
    const postToolUse = vi.fn(async () => ({}));
    const identities: DelegatedConversationIdentity[] = [];
    const scopes: DelegatedToolActionScope[] = [];
    const observedMessageIds = new Map<string, string>();
    const binding = {
      ...createDelegatedConversationBinding(async (identity) => {
        identities.push(identity);
      }),
      bindRun: async (identity: DelegatedRunIdentity) => {
        const child = identities.find(
          (entry) => entry.parentToolCallId === identity.parentToolCallId
        );
        if (!child) {
          throw new Error('Native child was not bound');
        }
        scopes.splice(0, scopes.length, {
          configuration: child.configuration,
          identity,
          ...(child.originalToolCall ? { originalToolCall: child.originalToolCall } : {}),
          resourceId: child.childResourceId,
          threadId: child.childThreadId,
        });
        const messageId = observedMessageIds.get(identity.childRuntimeRunId);
        return {
          threadId: child.childThreadId,
          ...(messageId ? { messageId } : {}),
        };
      },
      claimToolAction: async () => undefined,
      finishToolActions: async () => undefined,
      prepareToolAction: async () => undefined,
      releaseUnexecutedToolAction: async () => undefined,
      resolveToolAction: async () => scopes,
    };
    const childCatalogs: string[][] = [];
    const parentResults: unknown[] = [];
    let childStep = 0;
    modelHolder.current = scriptedAgentModel((options) => {
      if (options.tools?.some((tool) => tool.name === 'agent-worker')) {
        if (hasToolResult(options, 'agent-worker')) {
          parentResults.push(options.prompt);
          return textParts('PARENT_RECEIVED_WORKER_RESULT');
        }
        return toolCallParts('agent-worker', 'worker-delegation', {
          prompt: 'Discover the eligible remote echo and execute it after approval.',
        });
      }
      const names = options.tools?.map((tool) => tool.name) ?? [];
      childCatalogs.push(names);
      expect(names).not.toContain('remote_forbidden');
      childStep += 1;
      if (childStep === 1) {
        return toolCallParts('search_tools', 'search-remote', { query: 'remote echo' });
      }
      if (childStep === 2) {
        return toolCallParts('load_tool', 'load-forbidden', { toolName: 'remote_forbidden' });
      }
      if (childStep === 3) {
        return toolCallParts('load_tool', 'load-remote', { toolName: 'remote_echo' });
      }
      expect(names).toContain('remote_echo');
      if (!hasToolResult(options, 'remote_echo')) {
        return toolCallParts('remote_echo', 'worker-edit', { value: 'WORKER_REMOTE_EFFECT' });
      }
      return textParts('WORKER_DELIVERABLE_RESULT');
    }).model;
    const storage = new InMemoryStore({ id: `worker-${action}` });
    const memory = new Memory({ options: { generateTitle: false }, storage });
    const options = {
      conversationBinding: binding,
      mcpHost,
      memory,
      personas: [worker],
      runtime: {
        apiKey: 'test-key',
        hookRunner: { postToolUse, preToolUse },
        memory: { resourceId: `worker-resource-${action}`, threadId: `worker-root-${action}` },
        permissionPolicy: {
          policies: { edit: 'ask', execute: 'ask', mcp: 'deny', read: 'allow' },
          riskByTool: { remote_echo: 'edit', remote_forbidden: 'mcp' },
          yolo: false,
        },
        provider: 'openai',
      },
      storage,
    } as const;
    const initial = await drain(
      await streamMastraAgent(
        [
          {
            id: 'workspace-context',
            parts: [{ text: 'TRUSTED_WORKSPACE_CONVENTION', type: 'text' }],
            role: 'system',
          },
          {
            id: 'user',
            parts: [{ text: 'Delegate my deliverable to Worker.', type: 'text' }],
            role: 'user',
          },
        ],
        options
      )
    );
    // Preserve the actual stream-owned message id across runtime reconstruction,
    // as the durable host does when resume forwards a descendant before start.
    for (const frame of initial) {
      if (frame.type !== 'delegated-conversation-chunk') {
        continue;
      }
      observedMessageIds.set(frame.identity.childRuntimeRunId, frame.messageId);
    }
    expect(observedMessageIds.size).toBe(1);
    const pending = initial.find((chunk) => chunk.type === 'tool-approval-required');
    expect(pending).toBeDefined();
    expect(server.executions).toEqual([]);
    expect(preToolUse).not.toHaveBeenCalled();
    if (pending?.type !== 'tool-approval-required') {
      throw new Error('Missing native child approval');
    }
    expect(pending.delegation).toBeDefined();
    const target = getToolActionTarget(pending);
    expect(target.runId).toBe(scopes[0]?.identity.parentRuntimeRunId);
    expect(target.toolCallId).toBe('worker-delegation');
    expect(target.delegation?.toolCallId).toBe('worker-edit');
    const resumed = await drain(
      await streamMastraToolApprovalAction(
        {
          action,
          ...target,
          toolName: pending.toolName,
        },
        {
          ...options,
          runtime: withMemory
            ? options.runtime
            : {
                apiKey: options.runtime.apiKey,
                hookRunner: options.runtime.hookRunner,
                permissionPolicy: options.runtime.permissionPolicy,
                provider: options.runtime.provider,
              },
        }
      )
    );
    expect(server.executions, JSON.stringify({ childCatalogs, resumed })).toEqual([
      'WORKER_REMOTE_EFFECT',
    ]);
    expect(preToolUse).toHaveBeenCalledTimes(1);
    expect(postToolUse).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(resumed)).toContain('PARENT_RECEIVED_WORKER_RESULT');
    expect(JSON.stringify(parentResults)).toContain('WORKER_DELIVERABLE_RESULT');
    expect(childCatalogs[0]).toContain('search_tools');
    expect(childCatalogs[0]).toContain('load_tool');
    expect(childCatalogs[0]).not.toContain('remote_echo');
    expect(identities[0]?.configuration).toMatchObject({
      persona: { allowedToolIds: expect.arrayContaining(['remote.echo']) },
    });
    expect(JSON.stringify(identities[0]?.configuration)).not.toContain('"*"');
    expect(childCatalogs.at(-1)).toContain('remote_echo');
    await memory.settled();
  } catch (error) {
    failures.push(error);
  } finally {
    const results = await Promise.allSettled([mcpHost.close(), server.close()]);
    failures.push(
      ...results.filter((result) => result.status === 'rejected').map((result) => result.reason)
    );
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Worker MCP acceptance and cleanup failed', {
      cause: failures[0],
    });
  }
});

// Real Streamable HTTP MCP boundary; only the external language model is scripted.
async function startWorkerMcpServer() {
  const executions: string[] = [];
  const failures: unknown[] = [];
  const http = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const server = new McpServer({ name: 'worker-discovery', version: '1.0.0' });
    const transport = new NodeStreamableHTTPServerTransport({});
    try {
      for (const name of ['echo', 'forbidden']) {
        server.registerTool(
          name,
          { description: `Remote ${name} tool`, inputSchema: z.object({ value: z.string() }) },
          async ({ value }) => {
            executions.push(name === 'echo' ? value : 'FORBIDDEN_EFFECT');
            return { content: [{ text: value, type: 'text' }] };
          }
        );
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(
        request,
        response,
        JSON.parse(Buffer.concat(chunks).toString('utf8'))
      );
    } catch (error) {
      failures.push(error);
      if (!response.headersSent) {
        response.writeHead(500).end();
      }
    } finally {
      const settled = await Promise.allSettled([transport.close(), server.close()]);
      for (const result of settled) {
        if (result.status === 'rejected') {
          failures.push(result.reason);
        }
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const address = http.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing MCP port');
  }
  return {
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve()))
      );
      if (failures.length) {
        throw new AggregateError(failures, 'Worker MCP fixture failed');
      }
    },
    executions,
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
}
const INERT_MCP_HOST_CLOSE_REPORT = {
  callbacksClosed: 0,
  childProcessesClosed: 0,
  clientsClosed: 1,
  failures: [],
  loopbackPortsClosed: 0,
  probesClosed: 0,
  requestsSettled: 0,
  subscriptionsClosed: 0,
} as const;

function createRealTransportMcpHost(
  server:
    | { name: string; transport: 'streamable-http'; url: string }
    | {
        args: readonly string[];
        command: string;
        env: Record<string, string>;
        name: string;
        transport: 'stdio';
      }
): McpHostPort {
  const configuredServerId = parseConfiguredMcpServerId(server.name);
  const client =
    server.transport === 'stdio'
      ? new ExplicitStdioMcpClient({
          args: server.args,
          command: server.command,
          env: server.env,
          name: server.name,
        })
      : new ExplicitHttpMcpClient({
          name: server.name,
          transport: server.transport,
          url: server.url,
        });
  // Deliberately inert: tool routing consumes only identity/generation here.
  // Live connection-state projection is covered by the host-runtime suite.
  const snapshot = {
    revision: 1,
    servers: [
      {
        configuredProtocol: 'legacy' as const,
        configuredServerId,
        generation: 1,
        state: 'disconnected' as const,
        transport: server.transport,
      },
    ],
  };

  return {
    async close() {
      await client.close();
      return INERT_MCP_HOST_CLOSE_REPORT;
    },
    control: async () => {
      throw new Error('Test MCP host control is unsupported');
    },
    async invoke(operation, options) {
      if (operation.configuredServerId !== configuredServerId) {
        throw new Error(`Unexpected MCP server id: ${operation.configuredServerId}`);
      }
      const requestOptions = {
        ...(options?.onProgress ? { onprogress: options.onProgress } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      };
      if (operation.type === 'tools/list') {
        return parseMcpHostOperationResult({
          result: await client.listTools(
            requestOptions,
            operation.cursor ? { cursor: operation.cursor } : undefined
          ),
          type: operation.type,
        });
      }
      if (operation.type !== 'tools/call') {
        throw new Error(`Unexpected MCP operation: ${operation.type}`);
      }
      return parseMcpHostOperationResult({
        result: await client.callTool(
          {
            ...(operation._meta ? { _meta: operation._meta } : {}),
            ...(operation.arguments ? { arguments: operation.arguments } : {}),
            ...(operation.task ? { task: operation.task } : {}),
            name: operation.toolName,
          },
          requestOptions
        ),
        type: operation.type,
      });
    },
    replaceConfig: async () => {
      throw new Error('Test MCP host config is immutable');
    },
    snapshot: () => snapshot,
    watch: () => () => undefined,
  };
}
