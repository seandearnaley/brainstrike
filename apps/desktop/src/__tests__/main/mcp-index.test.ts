import { beforeEach, describe, expect, it, vi } from 'vitest';

const sseClient = {
  callTool: vi.fn(async () => 'sse-result'),
  dispose: vi.fn(),
  listTools: vi.fn(async () => ({})),
  name: 'remote',
  supportsTool: vi.fn((toolId: string) => toolId.startsWith('remote.')),
  transport: 'sse',
};
const streamableHttpClient = {
  callTool: vi.fn(async () => 'streamable-http-result'),
  dispose: vi.fn(),
  listTools: vi.fn(async () => ({})),
  name: 'streamable',
  supportsTool: vi.fn((toolId: string) => toolId.startsWith('streamable.')),
  transport: 'streamable-http',
};
const stdioClient = {
  callTool: vi.fn(async () => 'stdio-result'),
  dispose: vi.fn(),
  listTools: vi.fn(async () => ({
    'filesystem.list_directory': { description: 'List files' },
  })),
  name: 'filesystem',
  supportsTool: vi.fn((toolId: string) => toolId === 'filesystem.list_directory'),
  transport: 'stdio',
};

vi.mock('../../mcp/sse-client', () => ({
  createSseClient: vi.fn(() => sseClient),
}));

vi.mock('../../mcp/http-client', () => ({
  createHttpClient: vi.fn((server: { transport: string }) =>
    server.transport === 'streamable-http' ? streamableHttpClient : sseClient
  ),
}));

vi.mock('../../mcp/stdio-client', () => ({
  createStdioClient: vi.fn(() => stdioClient),
}));

import { callTool, disposeClients, getClient, initClients } from '../../mcp';

describe('mcp index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes clients for stdio, Streamable HTTP, and legacy SSE transports', async () => {
    initClients({
      servers: [
        { args: ['/tmp'], command: 'node', name: 'filesystem', transport: 'stdio' },
        {
          name: 'streamable',
          transport: 'streamable-http',
          url: 'https://example.com/sse',
        },
        { name: 'remote', transport: 'sse', url: 'https://example.com/sse' },
        { args: [], command: 'custom', name: 'custom', transport: 'stdio' },
      ],
    });

    expect(getClient('filesystem')).toBe(stdioClient);
    expect(getClient('streamable')).toBe(streamableHttpClient);
    expect(getClient('remote')).toBe(sseClient);
    expect(getClient('custom')).toBeDefined();
  });

  it('routes tool calls to the correct client', async () => {
    initClients({
      servers: [
        { args: ['/tmp'], command: 'node', name: 'filesystem', transport: 'stdio' },
        { name: 'remote', transport: 'sse', url: 'https://example.com/sse' },
      ],
    });

    await expect(callTool('filesystem.list_directory')).resolves.toBe('stdio-result');
    await expect(callTool('remote.search')).resolves.toBe('sse-result');
    await expect(callTool('unknown.tool')).rejects.toThrow(
      "No MCP client registered for tool 'unknown.tool'"
    );
  });

  it('rejects an unsupported transport instead of silently omitting the server', () => {
    expect(() =>
      initClients({
        servers: [
          {
            name: 'unsupported',
            transport: 'custom',
            url: 'https://example.com/mcp',
          } as never,
        ],
      })
    ).toThrow('Unsupported MCP transport: custom');
  });

  it('disposes all clients and clears registry', async () => {
    initClients({
      servers: [
        { args: ['/tmp'], command: 'node', name: 'filesystem', transport: 'stdio' },
        { name: 'remote', transport: 'sse', url: 'https://example.com/sse' },
      ],
    });

    await disposeClients();

    expect(stdioClient.dispose).toHaveBeenCalled();
    expect(sseClient.dispose).toHaveBeenCalled();
    expect(getClient('filesystem')).toBeUndefined();
  });
});
