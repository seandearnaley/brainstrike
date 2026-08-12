import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccessError } from '@brainstrike/file-system';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceFileCapabilities } from '../../ipc-domains/workspace-file-capabilities';

const temporaryDirectories: string[] = [];

async function createFixture(): Promise<{ outside: string; root: string }> {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-workspace-capability-'));
  temporaryDirectories.push(fixture);
  const root = path.join(fixture, 'workspace');
  const outside = path.join(fixture, 'outside');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, 'src', 'inside.txt'), 'inside workspace');
  await writeFile(path.join(outside, 'secret.txt'), 'outside workspace');
  return { outside, root };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe('workspace file capabilities on a real filesystem', () => {
  it('reads regular in-root files and rejects absolute, relative, dangling, and chained symlinks', async () => {
    const { outside, root } = await createFixture();
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'absolute-link.txt'), 'file');
    await symlink(
      path.relative(root, path.join(outside, 'secret.txt')),
      path.join(root, 'relative-link.txt'),
      'file'
    );
    await symlink('missing.txt', path.join(root, 'dangling-link.txt'), 'file');
    await symlink('absolute-link.txt', path.join(root, 'chained-link.txt'), 'file');
    const capabilities = createWorkspaceFileCapabilities();
    const canonicalRoot = await capabilities.mountRoot({ path: root, rootId: 'root-1' });

    const nodes = await capabilities.readDirectory({
      kind: 'directory',
      name: 'workspace',
      path: canonicalRoot,
      platform: 'electron',
      rootId: 'root-1',
    });
    expect(nodes.map((node) => node.name)).toEqual(['src']);

    await expect(capabilities.readFile('src/inside.txt', { rootId: 'root-1' })).resolves.toBe(
      'inside workspace'
    );
    for (const linkedPath of [
      'absolute-link.txt',
      'relative-link.txt',
      'dangling-link.txt',
      'chained-link.txt',
    ]) {
      await expect(capabilities.readFile(linkedPath, { rootId: 'root-1' })).rejects.toBeInstanceOf(
        AccessError
      );
    }
    capabilities.dispose();
  });

  it('rejects parent and leaf replacements without exposing outside bytes', async () => {
    const { outside, root } = await createFixture();
    const capabilities = createWorkspaceFileCapabilities();
    await capabilities.mountRoot({ path: root, rootId: 'root-1' });

    const parkedSource = path.join(root, 'src-parked');
    await rename(path.join(root, 'src'), parkedSource);
    await symlink(outside, path.join(root, 'src'), 'dir');
    await expect(
      capabilities.readFile('src/secret.txt', { rootId: 'root-1' })
    ).rejects.toBeInstanceOf(AccessError);

    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'leaf-link.txt'), 'file');
    await expect(
      capabilities.readFile('leaf-link.txt', { rootId: 'root-1' })
    ).rejects.toBeInstanceOf(AccessError);
    capabilities.dispose();
  });

  it('never reads outside content when a mounted root path is replaced', async () => {
    const { outside, root } = await createFixture();
    const capabilities = createWorkspaceFileCapabilities();
    await capabilities.mountRoot({ path: root, rootId: 'root-1' });

    const parked = `${root}-parked`;
    await rename(root, parked);
    await symlink(outside, root, 'dir');

    const result = await capabilities
      .readFile('secret.txt', { rootId: 'root-1' })
      .catch((error: unknown) => error);
    expect(result).not.toBe('outside workspace');
    await expect(readFile(path.join(root, 'secret.txt'), 'utf8')).resolves.toBe(
      'outside workspace'
    );
    capabilities.dispose();
  });

  it('rejects a sensitive user target after symlink canonicalization', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-sensitive-capability-'));
    temporaryDirectories.push(fixture);
    const fakeHome = path.join(fixture, 'home');
    const sensitiveDirectory = path.join(fakeHome, '.ssh');
    await mkdir(sensitiveDirectory, { recursive: true });
    await writeFile(path.join(sensitiveDirectory, 'id_ed25519'), 'sensitive key');
    await symlink(
      path.join(sensitiveDirectory, 'id_ed25519'),
      path.join(fakeHome, 'linked-sensitive-file'),
      'file'
    );
    vi.stubEnv('HOME', fakeHome);
    const capabilities = createWorkspaceFileCapabilities();
    await capabilities.mountRoot({ path: fakeHome, rootId: 'root-1' });

    await expect(
      capabilities.readFile('linked-sensitive-file', { rootId: 'root-1' })
    ).rejects.toBeInstanceOf(AccessError);
    capabilities.dispose();
  });
});
