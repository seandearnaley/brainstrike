import { type McpHostPort, parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { createMcpRuntimeClient } from '../mcp/mcp-runtime-client';
import { collectCombinedTools } from '../mcp/mcp-tool-loader';

describe('MCP host runtime adapter core', () => {
  it('does not let an empty serialized config suppress host authority', async () => {
    const host = {
      close: vi.fn(),
      invoke: vi.fn(async () => ({
        result: {
          tools: [{ inputSchema: { type: 'object' }, name: 'authoritative' }],
        },
        type: 'tools/list' as const,
      })),
      replaceConfig: vi.fn(),
      snapshot: () => ({
        revision: 1,
        servers: [
          {
            configuredProtocol: 'legacy' as const,
            configuredServerId: parseConfiguredMcpServerId('host-server'),
            generation: 1,
            state: 'disconnected' as const,
            transport: 'stdio' as const,
          },
        ],
      }),
      watch: vi.fn(() => vi.fn()),
    } satisfies McpHostPort;

    const client = await createMcpRuntimeClient({ config: { servers: [] }, host });
    const { tools } = await collectCombinedTools({
      mcpClient: client,
      mcpConfig: undefined,
      sanitizedLocalTools: undefined,
      scaledDefaultTokens: 1000,
      timeoutOverrideMs: undefined,
      toolNameMap: new Map(),
    });

    expect(Object.keys(tools)).toEqual(['host-server_authoritative']);
    await client?.disconnect();
  });

  it('rejects a competing non-empty serialized config beside host authority', async () => {
    const host = {
      close: vi.fn(),
      invoke: vi.fn(),
      replaceConfig: vi.fn(),
      snapshot: vi.fn(() => ({ revision: 0, servers: [] })),
      watch: vi.fn(),
    } satisfies McpHostPort;

    await expect(
      createMcpRuntimeClient({
        config: {
          servers: [{ command: 'node', name: 'stale-config-server', transport: 'stdio' }],
        },
        host,
      })
    ).rejects.toThrow('cannot compete with MCP host authority');
    expect(host.snapshot).not.toHaveBeenCalled();
  });

  it('leases the injected host without closing it', async () => {
    const release = vi.fn();
    const host = {
      close: vi.fn(),
      invoke: vi.fn(async () => ({
        result: {
          tools: [
            { inputSchema: { type: 'object' }, name: 'allowed' },
            { inputSchema: { type: 'object' }, name: 'blocked' },
          ],
        },
        type: 'tools/list' as const,
      })),
      replaceConfig: vi.fn(),
      snapshot: () => ({
        revision: 1,
        servers: [
          {
            configuredProtocol: 'legacy' as const,
            configuredServerId: parseConfiguredMcpServerId('linear'),
            enabledTools: ['allowed'],
            generation: 1,
            state: 'disconnected' as const,
            transport: 'stdio' as const,
          },
        ],
      }),
      watch: vi.fn(() => release),
    } satisfies McpHostPort;

    const client = await createMcpRuntimeClient({ config: undefined, host });
    const { tools } = await collectCombinedTools({
      mcpClient: client,
      mcpConfig: undefined,
      sanitizedLocalTools: undefined,
      scaledDefaultTokens: 1000,
      timeoutOverrideMs: undefined,
      toolNameMap: new Map(),
    });
    expect(Object.keys(tools)).toEqual(['linear_allowed']);
    expect(host.invoke).toHaveBeenCalledOnce();
    await client?.disconnect();
    expect(release).toHaveBeenCalledOnce();
    expect(host.close).not.toHaveBeenCalled();
  });

  it('releases earlier watchers when adapter construction fails', async () => {
    const release = vi.fn();
    const host = {
      close: vi.fn(),
      invoke: vi.fn(),
      replaceConfig: vi.fn(),
      snapshot: () => ({
        revision: 1,
        servers: ['first', 'second'].map((name) => ({
          configuredProtocol: 'legacy' as const,
          configuredServerId: parseConfiguredMcpServerId(name),
          generation: 1,
          state: 'disconnected' as const,
          transport: 'stdio' as const,
        })),
      }),
      watch: vi
        .fn()
        .mockReturnValueOnce(release)
        .mockImplementationOnce(() => {
          throw new Error('watch failed');
        }),
    } satisfies McpHostPort;

    await expect(createMcpRuntimeClient({ config: undefined, host })).rejects.toThrow(
      'watch failed'
    );
    expect(release).toHaveBeenCalledOnce();
    expect(host.close).not.toHaveBeenCalled();
  });

  it('retires an in-flight discovery when the host generation changes', async () => {
    let generation = 1;
    let markInvokeStarted: (() => void) | undefined;
    let publishSnapshot: (() => void) | undefined;
    let discoverySignal: AbortSignal | undefined;
    const invokeStarted = new Promise<void>((resolve) => {
      markInvokeStarted = resolve;
    });
    const release = vi.fn();
    const host = {
      close: vi.fn(),
      invoke: vi.fn(async (_operation, options) => {
        discoverySignal = options?.signal;
        markInvokeStarted?.();
        if (!discoverySignal) {
          throw new Error('expected invoke to receive an AbortSignal');
        }
        return await new Promise<never>((_resolve, reject) => {
          if (discoverySignal?.aborted) {
            reject(discoverySignal.reason);
            return;
          }
          discoverySignal.addEventListener('abort', () => reject(discoverySignal?.reason), {
            once: true,
          });
        });
      }),
      replaceConfig: vi.fn(),
      snapshot: () => ({
        revision: generation,
        servers: [
          {
            configuredProtocol: 'legacy' as const,
            configuredServerId: parseConfiguredMcpServerId('linear'),
            generation,
            state: 'disconnected' as const,
            transport: 'stdio' as const,
          },
        ],
      }),
      watch: vi.fn((_filter, listener) => {
        publishSnapshot = listener;
        return release;
      }),
    } satisfies McpHostPort;
    const client = await createMcpRuntimeClient({ config: undefined, host });
    if (!client) {
      throw new Error('expected host authority to create an MCP runtime client');
    }

    const retireGeneration = async (): Promise<void> => {
      await invokeStarted;
      expect(host.invoke).toHaveBeenCalledOnce();
      expect(discoverySignal).toBeInstanceOf(AbortSignal);
      expect(discoverySignal?.aborted).toBe(false);
      generation = 2;
      expect(publishSnapshot).toBeTypeOf('function');
      publishSnapshot?.();
    };
    const [discoveryResult] = await Promise.all([
      client.listToolsetsWithErrors(),
      retireGeneration(),
    ]);

    expect(discoveryResult).toEqual({
      errors: { linear: 'MCP host authority generation retired' },
      toolsets: {},
    });
    expect(discoverySignal?.aborted).toBe(true);
    await client.disconnect();
    expect(release).toHaveBeenCalledOnce();
    expect(host.close).not.toHaveBeenCalled();
  });

  it('forwards an already-retired generation signal to a later discovery', async () => {
    let generation = 1;
    let publishSnapshot: (() => void) | undefined;
    let discoverySignal: AbortSignal | undefined;
    const release = vi.fn();
    const host = {
      close: vi.fn(),
      invoke: vi.fn(async (_operation, options) => {
        discoverySignal = options?.signal;
        if (!discoverySignal) {
          throw new Error('expected invoke to receive an AbortSignal');
        }
        if (!discoverySignal.aborted) {
          throw new Error('expected invoke to receive an already-aborted signal');
        }
        throw discoverySignal.reason;
      }),
      replaceConfig: vi.fn(),
      snapshot: () => ({
        revision: generation,
        servers: [
          {
            configuredProtocol: 'legacy' as const,
            configuredServerId: parseConfiguredMcpServerId('linear'),
            generation,
            state: 'disconnected' as const,
            transport: 'stdio' as const,
          },
        ],
      }),
      watch: vi.fn((_filter, listener) => {
        publishSnapshot = listener;
        return release;
      }),
    } satisfies McpHostPort;
    const client = await createMcpRuntimeClient({ config: undefined, host });
    if (!client) {
      throw new Error('expected host authority to create an MCP runtime client');
    }

    generation = 2;
    expect(publishSnapshot).toBeTypeOf('function');
    publishSnapshot?.();
    expect(discoverySignal).toBeUndefined();

    await expect(client.listToolsetsWithErrors()).resolves.toEqual({
      errors: { linear: 'MCP host authority generation retired' },
      toolsets: {},
    });
    expect(host.invoke).toHaveBeenCalledOnce();
    expect(discoverySignal).toBeInstanceOf(AbortSignal);
    expect(discoverySignal?.aborted).toBe(true);
    await client.disconnect();
    expect(release).toHaveBeenCalledOnce();
    expect(host.close).not.toHaveBeenCalled();
  });
});
