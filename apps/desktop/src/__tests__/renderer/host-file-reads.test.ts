// @vitest-environment jsdom
import type { HostClient } from '@brainstrike/agent-host/browser';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopHostConnection } from '../../renderer/desktop-host-connection';
import { createDesktopFileReads } from '../../renderer/host-file-reads';

// The window's real connector loads the browser JSON-RPC transport; each test injects its host.
vi.mock('../../renderer/agent-host-client', () => ({ connectDesktopAgentHost: vi.fn() }));

function readsFrom(answer: (method: string, params: unknown) => unknown) {
  const request = vi.fn(async (method: string, params: unknown) => answer(method, params));
  const host = { closed: new Promise<void>(() => undefined), request } as unknown as HostClient;
  return { reads: createDesktopFileReads(createDesktopHostConnection(async () => host)), request };
}

/** ADR-0029 stage 4: the Explorer's reads go to the agent host over the window's connection. */
describe('desktop file reads', () => {
  it('builds tree nodes from a listing, directories first, under the root that served it', async () => {
    const { reads, request } = readsFrom(() => ({
      entries: [
        { isDirectory: false, isFile: true, isSymbolicLink: false, name: 'b.ts', size: 3 },
        { isDirectory: true, isFile: false, isSymbolicLink: false, name: 'src' },
      ],
      inspected: 2,
      rootId: 'root-1',
      truncated: true,
    }));

    const nodes = await reads.readDirectory({
      kind: 'directory',
      name: 'repo',
      path: '/repo',
      platform: 'electron',
      rootId: 'root-1',
    });

    expect(request).toHaveBeenCalledWith('workspace/files/list', {
      path: '/repo',
      rootId: 'root-1',
    });
    expect(nodes.map((node) => [node.name, node.type, node.path, node.rootFolderId])).toEqual([
      ['src', 'directory', '/repo/src', 'root-1'],
      ['b.ts', 'file', '/repo/b.ts', 'root-1'],
      ['Showing first 2 entries', 'truncated', '/repo/…truncated…', 'root-1'],
    ]);
  });

  it('reads a file by path, by its root, or bound to an exact root', async () => {
    const { reads, request } = readsFrom(() => ({ content: 'text' }));

    await expect(reads.readFile({ path: '/repo/a.ts' })).resolves.toBe('text');
    await expect(reads.readFile({ path: '/repo/a.ts', rootId: 'root-1' })).resolves.toBe('text');
    await expect(
      reads.readFile({ path: '/repo/a.ts', rootId: 'stale' }, { path: '/repo', rootId: 'root-1' })
    ).resolves.toBe('text');

    expect(request.mock.calls).toEqual([
      ['workspace/files/read', { path: '/repo/a.ts' }],
      ['workspace/files/read', { path: '/repo/a.ts', rootId: 'root-1' }],
      ['workspace/files/read', { path: '/repo/a.ts', rootId: 'root-1', rootPath: '/repo' }],
    ]);
  });

  it('keeps the code of a missing or oversized file, which the Explorer shows', async () => {
    const { reads } = readsFrom(() => ({
      code: 'TOO_LARGE',
      message: 'File too large (max: 750KB)',
    }));

    await expect(reads.readFile({ path: '/repo/big.bin' })).rejects.toMatchObject({
      code: 'TOO_LARGE',
      message: 'File too large (max: 750KB)',
    });
  });

  it('answers whether a path exists', async () => {
    const { reads } = readsFrom(() => ({ exists: false }));
    await expect(reads.exists('/repo/gone.ts')).resolves.toBe(false);
  });
});
