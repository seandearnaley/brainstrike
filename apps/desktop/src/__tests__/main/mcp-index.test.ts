import { beforeEach, describe, expect, it, vi } from 'vitest';

const sseClient = {
  name: 'remote',
  transport: 'sse',
  dispose: vi.fn(),
  listTools: vi.fn(async () => ({})),
  supportsTool: vi.fn((toolId: string) => toolId.startsWith('remote.')),
  callTool: vi.fn(async () => 'sse-result'),
};
const stdioClient = {
  name: 'filesystem',
  transport: 'stdio',
  dispose: vi.fn(),
  listTools: vi.fn(async () => ({
    'filesystem.list_directory': { description: 'List files' },
  })),
  supportsTool: vi.fn((toolId: string) => toolId === 'filesystem.list_directory'),
  callTool: vi.fn(async () => 'stdio-result'),
};

vi.mock('../../mcp/sse-client', () => ({
  createSseClient: vi.fn(() => sseClient),
}));

vi.mock('../../mcp/stdio-client', () => ({
  createStdioClient: vi.fn(() => stdioClient),
}));

import { callTool, disposeClients, getClient, initClients } from '../../mcp';

describe('mcp index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes clients for stdio, sse, and unsupported transports', async () => {
    initClients({
      servers: [
        { name: 'filesystem', transport: 'stdio', command: 'node', args: ['/tmp'] },
        { name: 'remote', transport: 'sse', url: 'https://example.com/sse' },
        { name: 'custom', transport: 'stdio', command: 'custom', args: [] },
      ],
    });

    expect(getClient('filesystem')).toBe(stdioClient);
    expect(getClient('remote')).toBe(sseClient);
    expect(getClient('custom')).toBeDefined();
  });

  it('routes tool calls to the correct client', async () => {
    initClients({
      servers: [
        { name: 'filesystem', transport: 'stdio', command: 'node', args: ['/tmp'] },
        { name: 'remote', transport: 'sse', url: 'https://example.com/sse' },
      ],
    });

    await expect(callTool('filesystem.list_directory')).resolves.toBe('stdio-result');
    await expect(callTool('remote.search')).resolves.toBe('sse-result');
    await expect(callTool('unknown.tool')).rejects.toThrow(
      "No MCP client registered for tool 'unknown.tool'"
    );
  });

  it('disposes all clients and clears registry', async () => {
    initClients({
      servers: [
        { name: 'filesystem', transport: 'stdio', command: 'node', args: ['/tmp'] },
        { name: 'remote', transport: 'sse', url: 'https://example.com/sse' },
      ],
    });

    await disposeClients();

    expect(stdioClient.dispose).toHaveBeenCalled();
    expect(sseClient.dispose).toHaveBeenCalled();
    expect(getClient('filesystem')).toBeUndefined();
  });
});
