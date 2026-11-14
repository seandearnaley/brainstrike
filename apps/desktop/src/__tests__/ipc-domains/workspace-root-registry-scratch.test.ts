import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createRegistry,
  createRegistryCatalogRequest,
  registryRoot,
  secureRoot,
} from './workspace-root-registry-test-helpers';

const FOLDER = path.resolve('/workspace/app');
const WORKTREE = path.resolve('/managed/app/bright-fox');
const SCRATCH = ['quiet-otter', 'brave-wren', 'calm-heron'].map((name) =>
  path.resolve('/userData/scratch', name)
);

/** An open folder, a managed worktree and three scratch folders, as a launch finds them. */
function launchCatalog() {
  return createRegistryCatalogRequest([
    registryRoot('folder', FOLDER),
    registryRoot('checkout', WORKTREE, 'worktree'),
    ...SCRATCH.map((folder, index) => registryRoot(`scratch-${index}`, folder, 'scratch')),
  ]);
}

async function statusById(catalog: ReturnType<typeof launchCatalog>) {
  const { roots } = await catalog({ operation: 'list' });
  return Object.fromEntries(roots.map((root) => [root.id, root.status]));
}

// ADR-0034 (BST-2512): a scratch folder mounts when its thread needs it, never at launch.
describe('WorkspaceRootRegistry scratch folders', () => {
  it('mounts the open folder and the worktree at launch, and none of the scratch folders', async () => {
    const catalog = launchCatalog();
    const opened: string[] = [];
    const registry = createRegistry(
      {
        createSecureRoot: async (rootPath) => {
          opened.push(rootPath);
          return secureRoot(rootPath);
        },
      },
      catalog
    );

    const restored = await registry.restoreRoots();

    expect(opened).toEqual([FOLDER, WORKTREE]);
    expect(registry.mountedRoots().map((root) => root.rootId)).toEqual(['folder', 'checkout']);
    expect(restored.map((root) => [root.rootId, root.handle.worktree === true])).toEqual([
      ['folder', false],
      ['checkout', true],
    ]);
    // Their records stay, saying they are not mounted now.
    expect(await statusById(catalog)).toEqual({
      checkout: 'live',
      folder: 'live',
      'scratch-0': 'disconnected',
      'scratch-1': 'disconnected',
      'scratch-2': 'disconnected',
    });
    // A window opening reads the launch's mounts: nothing is restored again.
    await expect(registry.currentRoots()).resolves.toEqual(restored);
    await registry.dispose();
  });

  it('mounts the scratch folder a thread needs, and keeps it mounted through a restore', async () => {
    const catalog = launchCatalog();
    const createSecureRoot = vi.fn(async (rootPath: string) => secureRoot(rootPath));
    const registry = createRegistry({ createSecureRoot }, catalog);
    await registry.restoreRoots();
    createSecureRoot.mockClear();

    // A binding names the folder, another thread's scratch folder and a folder no record has.
    await registry.mountScratchRoots(['folder', 'scratch-1', 'unrecorded']);

    expect(createSecureRoot.mock.calls).toEqual([[SCRATCH[1]]]);
    expect(registry.mountedRoots().map((root) => root.rootId)).toEqual([
      'folder',
      'checkout',
      'scratch-1',
    ]);
    expect((await statusById(catalog))['scratch-1']).toBe('live');
    // Asked again, nothing is opened twice.
    await registry.mountScratchRoots(['scratch-1']);
    expect(createSecureRoot).toHaveBeenCalledTimes(1);

    // It stays mounted for the session, and is answered as the thread's scratch folder.
    const restored = await registry.restoreRoots();
    expect(restored.map((root) => [root.rootId, root.handle.scratch === true])).toEqual([
      ['folder', false],
      ['checkout', false],
      ['scratch-1', true],
    ]);
    expect(registry.mountedRoots().map((root) => root.rootId)).toContain('scratch-1');
    await expect(registry.currentRoots()).resolves.toEqual(restored);
    expect(await statusById(catalog)).toMatchObject({
      'scratch-0': 'disconnected',
      'scratch-1': 'live',
      'scratch-2': 'disconnected',
    });
    await registry.dispose();
  });

  it('refuses, by name and place, a scratch folder that is gone when its thread needs it', async () => {
    const catalog = launchCatalog();
    const registry = createRegistry(
      {
        createSecureRoot: async (rootPath) => {
          if (rootPath === SCRATCH[0]) {
            throw Object.assign(new Error(`ENOENT: no such file or directory '${rootPath}'`), {
              code: 'ENOENT',
            });
          }
          return secureRoot(rootPath);
        },
      },
      catalog
    );
    await registry.restoreRoots();

    await expect(registry.mountScratchRoots(['scratch-0'])).rejects.toMatchObject({
      failure: {
        code: 'workspace.root-missing',
        message: `The scratch folder quiet-otter is no longer at ${SCRATCH[0]}.`,
      },
    });
    expect(registry.mountedRoots().map((root) => root.rootId)).toEqual(['folder', 'checkout']);
    expect((await statusById(catalog))['scratch-0']).toBe('disconnected');
    await registry.dispose();
  });
});
