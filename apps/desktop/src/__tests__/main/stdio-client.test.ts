import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const handleFilesystemList = vi.fn(async () => ({ ok: 'list' }));
const handleFilesystemRead = vi.fn(async () => ({ ok: 'read' }));
const handleFilesystemSearch = vi.fn(async () => ({ ok: 'search' }));
const resolveBaseDirFromArgs = vi.fn(() => '/root');
const normalizeRootDir = vi.fn((value: string) => value);

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock('../../mcp/fs-tools', () => ({
  handleFilesystemList,
  handleFilesystemRead,
  handleFilesystemSearch,
}));

vi.mock('../../mcp/paths', () => ({
  resolveBaseDirFromArgs,
  normalizeRootDir,
}));

import { createFilesystemClientFromStdio } from '../../mcp/stdio-client';

describe('stdio client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes filesystem tools to the fs handlers', async () => {
    spawnMock.mockReturnValue({
      unref: vi.fn(),
      kill: vi.fn(),
    });

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
    spawnMock.mockReturnValue({
      unref: vi.fn(),
      kill: vi.fn(),
    });

    const client = createFilesystemClientFromStdio({
      name: 'filesystem',
      transport: 'stdio',
      command: 'node',
      args: ['/root'],
    });

    await expect(client.callTool('unknown.tool')).rejects.toThrow('Unsupported tool');
  });

  it('disposes safely when spawn fails', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const client = createFilesystemClientFromStdio({
      name: 'filesystem',
      transport: 'stdio',
      command: 'node',
      args: ['/root'],
    });

    await expect(client.dispose()).resolves.toBeUndefined();
  });
});
