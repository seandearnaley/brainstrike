import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsToolsMocks = vi.hoisted(() => ({
  handleFilesystemList: vi.fn(async () => ({ ok: 'list' })),
  handleFilesystemRead: vi.fn(async () => ({ ok: 'read' })),
  handleFilesystemSearch: vi.fn(async () => ({ ok: 'search' })),
}));
const pathMocks = vi.hoisted(() => ({
  resolveBaseDirFromArgs: vi.fn(() => '/root'),
  normalizeRootDir: vi.fn((value: string) => value),
}));

const { handleFilesystemList, handleFilesystemRead, handleFilesystemSearch } = fsToolsMocks;

vi.mock('../../mcp/fs-tools', () => fsToolsMocks);

vi.mock('../../mcp/paths', () => pathMocks);

import { createFilesystemClientFromStdio } from '../../mcp/stdio-client';

describe('stdio client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes filesystem tools to the fs handlers', async () => {
    const client = createFilesystemClientFromStdio({
      name: 'filesystem',
      transport: 'stdio',
      command: 'node',
      args: ['/root'],
    });

    await expect(client.callTool('filesystem.list', { path: '.' })).resolves.toEqual({
      ok: 'list',
    });
    await expect(client.callTool('filesystem.read', { path: 'file.txt' })).resolves.toEqual({
      ok: 'read',
    });
    await expect(client.callTool('filesystem.search', { query: 'q' })).resolves.toEqual({
      ok: 'search',
    });

    expect(handleFilesystemList).toHaveBeenCalledWith({ path: '.' }, '/root');
    expect(handleFilesystemRead).toHaveBeenCalledWith({ path: 'file.txt' }, '/root');
    expect(handleFilesystemSearch).toHaveBeenCalledWith({ query: 'q' }, '/root');
  });

  it('throws for unsupported tools', async () => {
    const client = createFilesystemClientFromStdio({
      name: 'filesystem',
      transport: 'stdio',
      command: 'node',
      args: ['/root'],
    });

    await expect(client.callTool('unknown.tool')).rejects.toThrow('Unsupported tool');
  });

  it('disposes safely without spawning a child process', async () => {
    const client = createFilesystemClientFromStdio({
      name: 'filesystem',
      transport: 'stdio',
      command: 'node',
      args: ['/root'],
    });

    await expect(client.dispose()).resolves.toBeUndefined();
  });
});
