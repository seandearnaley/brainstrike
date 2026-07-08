import { beforeEach, describe, expect, it, vi } from 'vitest';

const readdirMock = vi.fn();
const statMock = vi.fn();
const openMock = vi.fn();
const realpathMock = vi.fn();

vi.mock('node:fs/promises', () => ({
  default: {
    open: (...args: unknown[]) => openMock(...args),
    readdir: (...args: unknown[]) => readdirMock(...args),
    realpath: (...args: unknown[]) => realpathMock(...args),
    stat: (...args: unknown[]) => statMock(...args),
  },
}));

const resolvePathWithinRootMock = vi.fn();
const isPathInsideRootMock = vi.fn(() => true);

vi.mock('../../mcp/paths', () => ({
  isPathInsideRoot: (...args: unknown[]) => isPathInsideRootMock(...args),
  resolvePathWithinRoot: (...args: unknown[]) => resolvePathWithinRootMock(...args),
}));

import {
  handleFilesystemList,
  handleFilesystemRead,
  handleFilesystemSearch,
} from '../../mcp/fs-tools';

describe('mcp fs-tools error branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolvePathWithinRootMock.mockResolvedValue({ ok: true, path: '/root' });
    realpathMock.mockResolvedValue('/root');
  });

  it('returns error when list path is invalid', async () => {
    resolvePathWithinRootMock.mockResolvedValue({ error: 'invalid path', ok: false });

    const result = await handleFilesystemList({ path: '../bad' }, '/root');
    expect(result).toEqual({ error: 'invalid path' });
    expect(readdirMock).not.toHaveBeenCalled();
  });

  it('returns error when reading fails', async () => {
    resolvePathWithinRootMock.mockResolvedValue({ ok: true, path: '/root/file.txt' });
    statMock.mockRejectedValue(new Error('missing'));

    const result = await handleFilesystemRead({ path: 'file.txt' }, '/root');
    expect(result).toEqual({ error: 'missing' });
  });

  it('marks reads as truncated when the file changes mid-read', async () => {
    resolvePathWithinRootMock.mockResolvedValue({ ok: true, path: '/root/file.txt' });
    statMock.mockResolvedValue({ isDirectory: () => false, size: 4 });
    openMock.mockResolvedValue({
      close: vi.fn(async () => {}),
      read: vi.fn(async (buffer: Buffer) => {
        buffer.write('hi', 0, 'utf8');
        return { buffer, bytesRead: 2 };
      }),
    });

    const result = await handleFilesystemRead({ maxBytes: 8, path: 'file.txt' }, '/root');

    expect(result).toEqual({
      content: 'hi',
      encoding: 'utf8',
      path: '/root/file.txt',
      size: 4,
      truncated: true,
    });
  });

  it('returns error when search root is invalid', async () => {
    resolvePathWithinRootMock.mockResolvedValue({ error: 'invalid root', ok: false });

    const result = await handleFilesystemSearch({ query: 'x' }, '/root');
    expect(result).toEqual({ error: 'invalid root' });
  });

  it('skips unreadable directories during search', async () => {
    resolvePathWithinRootMock.mockResolvedValue({ ok: true, path: '/root' });
    readdirMock.mockRejectedValueOnce(new Error('nope'));

    const result = await handleFilesystemSearch({ maxDepth: 1, query: 'x' }, '/root');
    expect(result).toEqual([]);
  });
});
