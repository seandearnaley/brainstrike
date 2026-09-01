import type {
  McpHostOperation,
  McpHostOperationResult,
  McpHostPort,
  McpHostServerSnapshot,
  McpHostSnapshot,
  McpHostWatchEvent,
  McpHostWatchFilter,
} from '@brainstrike/assistant-contract';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  createMcpContentApplicationPort,
  MCP_CONTENT_APPLICATION_MAX_RESULT_BYTES,
  McpContentApplicationError,
  type McpContentApplicationRequest,
} from '../mcp-content-application-port.js';

const SERVER_ID = parseConfiguredMcpServerId('linear');

function server(generation: number): McpHostServerSnapshot {
  return {
    configuredProtocol: '2026-07-28',
    configuredServerId: SERVER_ID,
    generation,
    negotiated: { era: 'modern', revision: '2026-07-28' },
    state: 'connected',
    transport: 'streamable-http',
  };
}

class FakeContentHost {
  private readonly listeners = new Set<(event: McpHostWatchEvent) => void>();
  private state: McpHostSnapshot = { revision: 1, servers: [server(7)] };
  readonly invoke = vi.fn<McpHostPort['invoke']>(
    async (operation): Promise<McpHostOperationResult> => resultFor(operation)
  );
  onSnapshot: (() => void) | undefined;
  onWatchRegistered: (() => void) | undefined;

  snapshot(): McpHostSnapshot {
    this.onSnapshot?.();
    return structuredClone(this.state);
  }

  watch(filter: McpHostWatchFilter, listener: (event: McpHostWatchEvent) => void): () => void {
    expect(filter).toEqual({ configuredServerIds: [SERVER_ID] });
    this.listeners.add(listener);
    this.onWatchRegistered?.();
    return () => {
      this.listeners.delete(listener);
    };
  }

  replaceGeneration(generation: number): void {
    this.state = { revision: this.state.revision + 1, servers: [server(generation)] };
    const event = structuredClone(this.state);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  replaceGenerationSilently(generation: number): void {
    this.state = { revision: this.state.revision + 1, servers: [server(generation)] };
  }

  removeServer(): void {
    this.state = { revision: this.state.revision + 1, servers: [] };
    const event = structuredClone(this.state);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

function resultFor(operation: McpHostOperation): McpHostOperationResult {
  switch (operation.type) {
    case 'resources/read':
      return {
        result: { contents: [{ text: '# BST-1578', uri: operation.uri }] },
        type: operation.type,
      };
    case 'prompts/get':
      return {
        result: { messages: [{ content: { text: 'Summarize it', type: 'text' }, role: 'user' }] },
        type: operation.type,
      };
    case 'completion/complete':
      return {
        result: { completion: { hasMore: false, total: 1, values: ['BST-1578'] } },
        type: operation.type,
      };
    default:
      throw new Error(`Unexpected operation: ${operation.type}`);
  }
}

const requests = [
  {
    _meta: { trace: 'resource-read' },
    authority: { configuredServerId: SERVER_ID, generation: 7 },
    type: 'resources/read',
    uri: 'linear://issue/BST-1578',
  },
  {
    _meta: { trace: 'prompt-get' },
    arguments: { identifier: 'BST-1578' },
    authority: { configuredServerId: SERVER_ID, generation: 7 },
    name: 'summarize',
    type: 'prompts/get',
  },
  {
    _meta: { trace: 'completion' },
    argument: { name: 'identifier', value: 'BST' },
    authority: { configuredServerId: SERVER_ID, generation: 7 },
    context: { arguments: { project: 'Brainstrike' } },
    ref: { name: 'summarize', type: 'ref/prompt' },
    type: 'completion/complete',
  },
] as const satisfies readonly McpContentApplicationRequest[];

describe('MCP content application port (BST-1578)', () => {
  it.each(requests)(
    'routes only the closed $type operation through the existing host',
    async (request) => {
      const host = new FakeContentHost();
      const port = createMcpContentApplicationPort(host);

      const response = await port.execute(request);

      expect(response.type).toBe(request.type);
      expect(structuredClone(request)).toEqual(request);
      expect(structuredClone(response)).toEqual(response);
      expect(host.invoke).toHaveBeenCalledOnce();
      const { authority, ...operation } = request;
      expect(host.invoke.mock.calls[0]?.[0]).toEqual({
        ...operation,
        configuredServerId: authority.configuredServerId,
      });
      expect(host.listenerCount()).toBe(0);
    }
  );

  it('rejects stale and unknown authority before invoking the host', async () => {
    const host = new FakeContentHost();
    const port = createMcpContentApplicationPort(host);

    await expect(
      port.execute({
        authority: { configuredServerId: SERVER_ID, generation: 6 },
        type: 'resources/read',
        uri: 'linear://issue/BST-1578',
      })
    ).rejects.toMatchObject({
      category: 'generation-retired',
      code: 'mcp_content_generation_retired',
    });

    host.removeServer();
    await expect(port.execute(requests[0])).rejects.toMatchObject({
      category: 'configuration',
      code: 'mcp_content_server_unknown',
    });
    expect(host.invoke).not.toHaveBeenCalled();
  });

  it('closes the snapshot-to-watch race before invoking', async () => {
    const host = new FakeContentHost();
    host.onWatchRegistered = () => host.replaceGeneration(8);

    await expect(createMcpContentApplicationPort(host).execute(requests[0])).rejects.toMatchObject({
      category: 'generation-retired',
      code: 'mcp_content_generation_retired',
    });
    expect(host.invoke).not.toHaveBeenCalled();
    expect(host.listenerCount()).toBe(0);
  });

  it('closes the caller-abort-to-listener race before invoking', async () => {
    const host = new FakeContentHost();
    const caller = new AbortController();
    host.onSnapshot = () => {
      host.onSnapshot = undefined;
      caller.abort();
    };

    await expect(
      createMcpContentApplicationPort(host).execute(requests[0], { signal: caller.signal })
    ).rejects.toMatchObject({
      category: 'cancelled',
      code: 'mcp_content_cancelled',
    });
    expect(host.invoke).not.toHaveBeenCalled();
    expect(host.listenerCount()).toBe(0);
  });

  it('cancels in-flight host work and rejects a replacement race', async () => {
    const host = new FakeContentHost();
    let invocationSignal: AbortSignal | undefined;
    host.invoke.mockImplementation(async (_operation, options) => {
      invocationSignal = options?.signal;
      await new Promise<void>((resolve) =>
        invocationSignal?.addEventListener('abort', () => resolve())
      );
      throw invocationSignal?.reason;
    });
    const pending = createMcpContentApplicationPort(host).execute(requests[0]);
    await vi.waitFor(() => expect(invocationSignal).toBeDefined());

    host.replaceGeneration(8);

    await expect(pending).rejects.toMatchObject({
      category: 'generation-retired',
      code: 'mcp_content_generation_retired',
    });
    expect(invocationSignal?.aborted).toBe(true);
    expect(host.listenerCount()).toBe(0);
  });

  it('rejects a replacement observed after the host operation resolves', async () => {
    const host = new FakeContentHost();
    host.invoke.mockImplementationOnce(async (operation) => {
      host.replaceGenerationSilently(8);
      return resultFor(operation);
    });

    await expect(createMcpContentApplicationPort(host).execute(requests[0])).rejects.toMatchObject({
      category: 'generation-retired',
      code: 'mcp_content_generation_retired',
    });
    expect(host.listenerCount()).toBe(0);
  });

  it('keeps caller cancellation distinct and releases its watcher', async () => {
    const host = new FakeContentHost();
    const caller = new AbortController();
    let invocationSignal: AbortSignal | undefined;
    host.invoke.mockImplementation(async (_operation, options) => {
      invocationSignal = options?.signal;
      await new Promise<void>((resolve) =>
        invocationSignal?.addEventListener('abort', () => resolve())
      );
      throw invocationSignal?.reason;
    });
    const pending = createMcpContentApplicationPort(host).execute(requests[0], {
      signal: caller.signal,
    });
    await vi.waitFor(() => expect(invocationSignal).toBeDefined());

    caller.abort();

    await expect(pending).rejects.toMatchObject({
      category: 'cancelled',
      code: 'mcp_content_cancelled',
    });
    expect(invocationSignal?.aborted).toBe(true);
    expect(host.listenerCount()).toBe(0);
  });

  it('rejects malformed, mismatched, and oversized results with stable typed errors', async () => {
    const host = new FakeContentHost();
    const port = createMcpContentApplicationPort(host);

    host.invoke.mockResolvedValueOnce({ result: { messages: [] }, type: 'prompts/get' });
    await expect(port.execute(requests[0])).rejects.toMatchObject({
      category: 'protocol',
      code: 'mcp_content_result_type_mismatch',
    });

    const malformedResult: Extract<McpHostOperationResult, { type: 'resources/read' }> = {
      result: {
        _meta: { invalidOpenField: Number.NaN },
        contents: [{ text: 'invalid', uri: 'linear://issue/BST-1578' }],
      },
      type: 'resources/read',
    };
    host.invoke.mockResolvedValueOnce(malformedResult);
    await expect(port.execute(requests[0])).rejects.toMatchObject({
      category: 'protocol',
      code: 'mcp_content_result_invalid',
    });

    host.invoke.mockResolvedValueOnce({
      result: {
        contents: [
          {
            text: '😀'.repeat(Math.ceil(MCP_CONTENT_APPLICATION_MAX_RESULT_BYTES / 4)),
            uri: 'linear://issue/BST-1578',
          },
        ],
      },
      type: 'resources/read',
    });
    await expect(port.execute(requests[0])).rejects.toMatchObject({
      category: 'result-too-large',
      code: 'mcp_content_result_too_large',
    });
  });

  it('maps host failures without leaking untyped causes', async () => {
    const host = new FakeContentHost();
    host.invoke.mockRejectedValueOnce({
      category: 'authorization',
      code: 'mcp-authorization-denied',
      message: 'Authorization denied',
    });

    let thrown: unknown;
    try {
      await createMcpContentApplicationPort(host).execute(requests[0]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpContentApplicationError);
    expect(thrown).toMatchObject({
      category: 'host',
      code: 'mcp_content_host_operation_failed',
      hostError: {
        category: 'authorization',
        code: 'mcp-authorization-denied',
        message: 'Authorization denied',
      },
    });
    expect(thrown).not.toHaveProperty('cause');
  });
});
