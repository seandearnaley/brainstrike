import { beforeEach, describe, expect, it, vi } from 'vitest';

const sseClient = {
  name: 'remote',
  transport: 'sse',
  dispose: vi.fn(),
  callTool: vi.fn(async () => 'sse-result'),
};
const fsClient = {
  name: 'filesystem',
  transport: 'stdio',
  dispose: vi.fn(),
  callTool: vi.fn(async () => 'fs-result'),
};

vi.mock('../../mcp/sse-client', () => ({
  createSseClient: vi.fn(() => sseClient),
}));

vi.mock('../../mcp/stdio-client', () => ({
  createFilesystemClientFromStdio: vi.fn(() => fsClient),
}));

import { callTool, disposeClients, getClient, initClients } from '../../mcp';

describe('mcp index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes clients for stdio filesystem, sse, and unsupported transports', async () => {
    initClients({
      servers: [
        { name: 'filesystem', transport: 'stdio', command: 'node', args: ['/tmp'] },
        { name: 'remote', transport: 'sse', url: 'https://example.com/sse' },
        { name: 'custom', transport: 'stdio', command: 'custom', args: [] },
      ],
    });

    expect(getClient('filesystem')).toBe(fsClient);
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

    await expect(callTool('filesystem.list')).resolves.toBe('fs-result');
    await expect(callTool('remote.search')).resolves.toBe('sse-result');
    await expect(callTool('unknown.tool')).rejects.toThrow(
      "No MCP client registered for 'unknown'"
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

    expect(fsClient.dispose).toHaveBeenCalled();
    expect(sseClient.dispose).toHaveBeenCalled();
    expect(getClient('filesystem')).toBeUndefined();
  });
});
