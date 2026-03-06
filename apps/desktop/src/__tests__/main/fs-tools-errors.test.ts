import { beforeEach, describe, expect, it, vi } from 'vitest';

const readdirMock = vi.fn();
const statMock = vi.fn();
const openMock = vi.fn();
const realpathMock = vi.fn();

vi.mock('node:fs/promises', () => ({
  default: {
    readdir: (...args: unknown[]) => readdirMock(...args),
    stat: (...args: unknown[]) => statMock(...args),
    open: (...args: unknown[]) => openMock(...args),
    realpath: (...args: unknown[]) => realpathMock(...args),
  },
}));

const resolvePathWithinRootMock = vi.fn();
const isPathInsideRootMock = vi.fn(() => true);

vi.mock('../../mcp/paths', () => ({
  resolvePathWithinRoot: (...args: unknown[]) => resolvePathWithinRootMock(...args),
  isPathInsideRoot: (...args: unknown[]) => isPathInsideRootMock(...args),
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
    resolvePathWithinRootMock.mockResolvedValue({ ok: false, error: 'invalid path' });

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
      read: vi.fn(async (buffer: Buffer) => {
        buffer.write('hi', 0, 'utf8');
        return { bytesRead: 2, buffer };
      }),
      close: vi.fn(async () => {}),
    });

    const result = await handleFilesystemRead({ path: 'file.txt', maxBytes: 8 }, '/root');

    expect(result).toEqual({
      path: '/root/file.txt',
      size: 4,
      encoding: 'utf8',
      content: 'hi',
      truncated: true,
    });
  });

  it('returns error when search root is invalid', async () => {
    resolvePathWithinRootMock.mockResolvedValue({ ok: false, error: 'invalid root' });

    const result = await handleFilesystemSearch({ query: 'x' }, '/root');
    expect(result).toEqual({ error: 'invalid root' });
  });

  it('skips unreadable directories during search', async () => {
    resolvePathWithinRootMock.mockResolvedValue({ ok: true, path: '/root' });
    readdirMock.mockRejectedValueOnce(new Error('nope'));

    const result = await handleFilesystemSearch({ query: 'x', maxDepth: 1 }, '/root');
    expect(result).toEqual([]);
  });
});
