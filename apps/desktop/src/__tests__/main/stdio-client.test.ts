import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));
const fsToolsMocks = vi.hoisted(() => ({
  handleFilesystemList: vi.fn(async () => ({ ok: 'list' })),
  handleFilesystemRead: vi.fn(async () => ({ ok: 'read' })),
  handleFilesystemSearch: vi.fn(async () => ({ ok: 'search' })),
}));
const pathMocks = vi.hoisted(() => ({
  resolveBaseDirFromArgs: vi.fn(() => '/root'),
  normalizeRootDir: vi.fn((value: string) => value),
}));

const { spawnMock } = childProcessMocks;
const { handleFilesystemList, handleFilesystemRead, handleFilesystemSearch } = fsToolsMocks;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
    default: actual,
  };
});

vi.mock('../../mcp/fs-tools', () => fsToolsMocks);

vi.mock('../../mcp/paths', () => pathMocks);

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
