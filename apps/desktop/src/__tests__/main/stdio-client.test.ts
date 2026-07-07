import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  clientConnectMock,
  clientListToolsMock,
  clientCallToolMock,
  clientCloseMock,
  transportCloseMock,
  clientCtorMock,
  transportCtorMock,
} = vi.hoisted(() => {
  const connect = vi.fn(async () => {});
  const listTools = vi.fn(async () => ({
    tools: [
      {
        description: 'Read a file',
        inputSchema: { type: 'object' },
        name: 'read_file',
      },
      {
        description: 'List a directory',
        inputSchema: { type: 'object' },
        name: 'list_directory',
      },
    ],
  }));
  const callTool = vi.fn(async () => ({ content: [{ text: 'ok', type: 'text' }] }));
  const closeClient = vi.fn(async () => {});
  const closeTransport = vi.fn(async () => {});
  function MockClient(this: Record<string, unknown>) {
    this.connect = connect;
    this.listTools = listTools;
    this.callTool = callTool;
    this.close = closeClient;
  }
  function MockTransport(this: Record<string, unknown>) {
    this.close = closeTransport;
  }

  return {
    clientCallToolMock: callTool,
    clientCloseMock: closeClient,
    clientConnectMock: connect,
    clientCtorMock: vi.fn(MockClient),
    clientListToolsMock: listTools,
    transportCloseMock: closeTransport,
    transportCtorMock: vi.fn(MockTransport),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: clientCtorMock,
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: transportCtorMock,
}));

import { createStdioClient } from '../../mcp/stdio-client';

describe('stdio client', () => {
  const originalConnectFailureCooldown = process.env['MCP_STDIO_CONNECT_FAILURE_COOLDOWN_MS'];

  const restoreConnectFailureCooldownEnv = (): void => {
    if (originalConnectFailureCooldown === undefined) {
      Reflect.deleteProperty(process.env, 'MCP_STDIO_CONNECT_FAILURE_COOLDOWN_MS');
      return;
    }

    process.env['MCP_STDIO_CONNECT_FAILURE_COOLDOWN_MS'] = originalConnectFailureCooldown;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    restoreConnectFailureCooldownEnv();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreConnectFailureCooldownEnv();
  });

  it('discovers real MCP tools and namespaces them by server', async () => {
    const client = createStdioClient({
      args: ['/root'],
      command: 'node',
      name: 'filesystem',
      transport: 'stdio',
    });

    await expect(client.listTools()).resolves.toEqual({
      'filesystem.list_directory': {
        description: 'List a directory',
        inputSchema: { type: 'object' },
      },
      'filesystem.read_file': {
        description: 'Read a file',
        inputSchema: { type: 'object' },
      },
    });
    expect(clientConnectMock).toHaveBeenCalledTimes(1);
    expect(clientListToolsMock).toHaveBeenCalledTimes(1);
  });

  it('calls tools using the raw MCP tool name discovered from tools/list', async () => {
    const client = createStdioClient({
      args: ['/root'],
      command: 'node',
      name: 'filesystem',
      transport: 'stdio',
    });

    await expect(client.callTool('filesystem.list_directory', { path: '/root' })).resolves.toEqual({
      content: [{ text: 'ok', type: 'text' }],
    });
    expect(clientCallToolMock).toHaveBeenCalledWith(
      {
        arguments: { path: '/root' },
        name: 'list_directory',
      },
      undefined,
      expect.objectContaining({
        resetTimeoutOnProgress: true,
      })
    );
  });

  it('throws for unsupported tools', async () => {
    const client = createStdioClient({
      args: ['/root'],
      command: 'node',
      name: 'filesystem',
      transport: 'stdio',
    });

    await expect(client.callTool('unknown.tool')).rejects.toThrow('Unsupported MCP tool');
  });

  it('disposes the SDK client and transport safely', async () => {
    const client = createStdioClient({
      args: ['/root'],
      command: 'node',
      name: 'filesystem',
      transport: 'stdio',
    });

    await client.listTools();
    await expect(client.dispose()).resolves.toBeUndefined();
    expect(clientCloseMock).toHaveBeenCalledTimes(1);
    expect(transportCloseMock).toHaveBeenCalledTimes(1);
  });

  it('briefly caches connect failures before retrying the stdio spawn path', async () => {
    vi.useFakeTimers();
    process.env['MCP_STDIO_CONNECT_FAILURE_COOLDOWN_MS'] = '1000';
    clientConnectMock
      .mockRejectedValueOnce(new Error('connect failed'))
      .mockResolvedValueOnce(undefined);

    const client = createStdioClient({
      args: ['/root'],
      command: 'node',
      name: 'filesystem',
      transport: 'stdio',
    });

    await expect(client.listTools()).rejects.toThrow('connect failed');
    expect(clientConnectMock).toHaveBeenCalledTimes(1);
    expect(transportCloseMock).toHaveBeenCalledTimes(1);

    await expect(client.listTools()).rejects.toThrow('connect failed');
    expect(clientConnectMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);

    await expect(client.listTools()).resolves.toEqual({
      'filesystem.list_directory': {
        description: 'List a directory',
        inputSchema: { type: 'object' },
      },
      'filesystem.read_file': {
        description: 'Read a file',
        inputSchema: { type: 'object' },
      },
    });
    expect(clientConnectMock).toHaveBeenCalledTimes(2);
  });
});
