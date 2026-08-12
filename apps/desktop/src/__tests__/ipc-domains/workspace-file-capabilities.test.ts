import path from 'node:path';
import { AccessError } from '@brainstrike/file-system';
import { describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceFileCapabilities,
  type SecureWorkspaceRoot,
} from '../../ipc-domains/workspace-file-capabilities';

async function resolveTestPath(requestedPath: string, rootPath?: string): Promise<string> {
  return path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(rootPath ?? '', requestedPath);
}

function createFakeSecureRoot(): SecureWorkspaceRoot {
  return {
    close: vi.fn(),
    listDir: vi.fn(() => ({
      entries: [
        { isDirectory: true, isFile: false, name: 'src' },
        { isDirectory: false, isFile: true, name: 'README.md' },
        { isDirectory: false, isFile: false, name: 'outside-link' },
      ],
      inspected: 3,
      truncated: false,
    })),
    readFile: vi.fn(() => ({ content: Buffer.from('inside workspace'), status: 'ok' as const })),
  };
}

describe('workspace file capabilities', () => {
  it('binds absolute and root-relative reads to a mounted root', async () => {
    const secureRoot = createFakeSecureRoot();
    const capabilities = createWorkspaceFileCapabilities({
      createSecureRoot: () => secureRoot,
      resolveCanonicalPath: resolveTestPath,
    });
    const canonicalRoot = path.resolve('/workspace/project');
    await capabilities.mountRoot({ path: canonicalRoot, rootId: 'root-1' });

    await expect(
      capabilities.readFile(path.join(canonicalRoot, 'README.md'), { rootId: 'root-1' })
    ).resolves.toBe('inside workspace');
    await expect(capabilities.readFile('src/index.ts', { rootId: 'root-1' })).resolves.toBe(
      'inside workspace'
    );

    expect(secureRoot.readFile).toHaveBeenNthCalledWith(1, 'README.md', 768_000);
    expect(secureRoot.readFile).toHaveBeenNthCalledWith(2, path.join('src', 'index.ts'), 768_000);
  });

  it('rejects rootless relative paths and paths outside every mounted root', async () => {
    const capabilities = createWorkspaceFileCapabilities({
      createSecureRoot: createFakeSecureRoot,
      resolveCanonicalPath: resolveTestPath,
    });
    await capabilities.mountRoot({ path: path.resolve('/workspace/project'), rootId: 'root-1' });

    await expect(capabilities.readFile('README.md')).rejects.toBeInstanceOf(AccessError);
    await expect(capabilities.readFile(path.resolve('/outside/secret.txt'))).rejects.toBeInstanceOf(
      AccessError
    );
  });

  it('omits symlink-like entries and stamps child handles with durable root identity', async () => {
    const secureRoot = createFakeSecureRoot();
    const capabilities = createWorkspaceFileCapabilities({
      createSecureRoot: () => secureRoot,
      resolveCanonicalPath: resolveTestPath,
    });
    const canonicalRoot = path.resolve('/workspace/project');
    await capabilities.mountRoot({ path: canonicalRoot, rootId: 'root-1' });

    await expect(
      capabilities.readDirectory({
        kind: 'directory',
        name: 'project',
        path: canonicalRoot,
        platform: 'electron',
        rootId: 'root-1',
      })
    ).resolves.toEqual([
      expect.objectContaining({
        handle: expect.objectContaining({ rootId: 'root-1' }),
        name: 'src',
        type: 'directory',
      }),
      expect.objectContaining({
        handle: expect.objectContaining({ rootId: 'root-1' }),
        name: 'README.md',
        type: 'file',
      }),
    ]);
  });

  it('closes replaced, removed, and disposed root capabilities', async () => {
    const first = createFakeSecureRoot();
    const second = createFakeSecureRoot();
    const third = createFakeSecureRoot();
    const createSecureRoot = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(third);
    const capabilities = createWorkspaceFileCapabilities({
      createSecureRoot,
      resolveCanonicalPath: resolveTestPath,
    });
    const canonicalRoot = path.resolve('/workspace/project');

    await capabilities.mountRoot({ path: canonicalRoot, rootId: 'root-1' });
    await capabilities.mountRoot({ path: canonicalRoot, rootId: 'root-1' });
    expect(first.close).toHaveBeenCalledOnce();

    await capabilities.mountRoot({ path: path.resolve('/workspace/other'), rootId: 'root-2' });
    capabilities.retainRoots(new Set(['root-1']));
    expect(third.close).toHaveBeenCalledOnce();

    capabilities.unmountRoot('root-1');
    expect(second.close).toHaveBeenCalledOnce();
    capabilities.dispose();
    expect(second.close).toHaveBeenCalledOnce();
  });
});
