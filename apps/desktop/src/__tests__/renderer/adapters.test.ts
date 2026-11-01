// @vitest-environment jsdom
import { UserCancelledError } from '@brainstrike/file-system';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronRendererFileSystemAdapter } from '../../renderer/adapters';

// The adapter's watches reach the agent host; the window's real connector loads the browser transport.
vi.mock('../../renderer/agent-host-client', () => ({ connectDesktopAgentHost: vi.fn() }));
const roots = vi.hoisted(() => ({
  addRootByPath: vi.fn(async () => ({})),
  listRecentRoots: vi.fn(async () => []),
  pickRoot: vi.fn(),
  removeRoot: vi.fn(async () => undefined),
  restoreRoots: vi.fn(),
}));
vi.mock('../../renderer/host-workspace-roots', () => ({
  resolveDesktopWorkspaceRoots: () => roots,
}));

describe('ElectronRendererFileSystemAdapter', () => {
  let adapter: ElectronRendererFileSystemAdapter;

  beforeEach(() => {
    adapter = new ElectronRendererFileSystemAdapter();
    vi.clearAllMocks();
  });

  it('declares platform "electron" (roots registry derives kind "path" from this)', () => {
    expect(adapter.platform).toBe('electron');
  });

  describe('readFileByAbsolutePath', () => {
    it.each([
      { absolutePath: '/workspace/file.txt', rootPath: '' },
      { absolutePath: '/workspace/file.txt', rootPath: '   ' },
      { absolutePath: '/workspace/file.txt', rootPath: 'workspace' },
      { absolutePath: 'file.txt', rootPath: '/workspace' },
      { absolutePath: '\\file.txt', rootPath: '/workspace' },
    ])(
      'rejects malformed explicit read authority root=$rootPath path=$absolutePath',
      async ({ absolutePath, rootPath }) => {
        await expect(
          adapter.readFileByAbsolutePath(absolutePath, rootPath, 'root-project')
        ).rejects.toThrow('absolute path');
      }
    );

    it('rejects missing durable root identity before invoking the bridge', async () => {
      await expect(
        adapter.readFileByAbsolutePath('/workspace/file.txt', '/workspace', '')
      ).rejects.toThrow('durable rootId');
    });
  });

  describe('workspace folders through the agent host', () => {
    const descriptor = (rootId: string, path: string, available = true) => ({
      displayName: path.split('/').at(-1),
      handle: {
        kind: 'directory',
        name: path.split('/').at(-1),
        path,
        platform: 'electron',
        rootId,
      },
      kind: 'path',
      permissionState: available ? 'granted' : 'unknown',
      persisted: true,
      rootId,
    });

    it('answers the picked folder as a granted root descriptor', async () => {
      roots.pickRoot.mockResolvedValueOnce(descriptor('root-a', '/test/project-a'));
      await expect(adapter.addRoot()).resolves.toEqual(descriptor('root-a', '/test/project-a'));
      roots.pickRoot.mockResolvedValueOnce(descriptor('root-a', '/test/project-a'));
      await expect(adapter.requestDirectoryAccess()).resolves.toMatchObject({
        path: '/test/project-a',
        rootId: 'root-a',
      });
    });

    it('keeps a picker cancellation a cancellation', async () => {
      roots.pickRoot.mockRejectedValueOnce(new UserCancelledError());
      await expect(adapter.addRoot()).rejects.toBeInstanceOf(UserCancelledError);
    });

    it('routes restore, recents, path re-add and removal to the host', async () => {
      roots.restoreRoots.mockResolvedValueOnce([descriptor('root-b', '/test/b', false)]);
      await expect(adapter.restoreRoots()).resolves.toEqual([
        descriptor('root-b', '/test/b', false),
      ]);
      await adapter.listRecentRoots();
      await adapter.addRootByPath('/test/b');
      await adapter.removeRoot('root-b');
      expect(roots.listRecentRoots).toHaveBeenCalledOnce();
      expect(roots.addRootByPath).toHaveBeenCalledWith('/test/b');
      expect(roots.removeRoot).toHaveBeenCalledWith('root-b');
    });
  });
});
