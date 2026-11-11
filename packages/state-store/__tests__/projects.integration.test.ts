import { afterEach, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(cleanupDirs);

// ADR-0034, owner decisions 2026-11-10: a project is a record with an id of its own. The store
// gives a folder its project in the commit that records the folder, so no folder is without one.
function folder(name: string, preferredId: string) {
  return {
    canonicalPath: `/disposable/${name}`,
    displayName: name,
    path: `/disposable/${name}`,
    preferredId,
  };
}
const alpha = folder('Alpha', 'ae303e9c-29a4-4ec4-a1cc-835d655dcb70');
const bravo = folder('Bravo', '5be9d0f1-a3ba-4b44-b7e7-7280906bdc78');

async function open(
  store: StateStore,
  root: ReturnType<typeof folder>,
  repin = false
): Promise<string | null | undefined> {
  const { roots } = await store.workspaceRoots({
    operation: 'register',
    ...(repin ? { repin } : {}),
    root,
  });
  return roots[0]?.projectId;
}

async function projectOf(store: StateStore, rootId: string): Promise<string | null | undefined> {
  const { roots } = await store.workspaceRoots({ operation: 'list' });
  return roots.find((root) => root.id === rootId)?.projectId;
}

test('each opened folder gets a project of its own, and keeps it when it is closed, the app restarts and it is opened again', async () => {
  const root = freshDir('projects');
  let store = await StateStore.open(root);
  try {
    const alphaProject = await open(store, alpha);
    const bravoProject = await open(store, bravo);
    expect(alphaProject).toEqual(expect.stringMatching(/\S/u));
    expect(bravoProject).toEqual(expect.stringMatching(/\S/u));
    expect(bravoProject).not.toBe(alphaProject);

    // The person removes Alpha: it leaves the open folders, and its threads still name it.
    await store.workspaceRoots({
      closeRootIds: [alpha.preferredId],
      mountedPaths: [bravo.path],
      operation: 'disconnect-except',
    });
    await store.close();
    store = await StateStore.open(root);

    expect(await projectOf(store, alpha.preferredId)).toBe(alphaProject);
    expect(await projectOf(store, bravo.preferredId)).toBe(bravoProject);
    expect(await open(store, alpha)).toBe(alphaProject);
    expect(
      (await store.workspaceRoots({ operation: 'list-open' })).roots.map((entry) => entry.projectId)
    ).toEqual([bravoProject, alphaProject]);
  } finally {
    await store.close();
  }
});

test('two paths that lead to one folder are one project', async () => {
  const store = await StateStore.open(freshDir('projects-alias'));
  try {
    const project = await open(store, alpha);
    expect(project).toEqual(expect.stringMatching(/\S/u));
    const alias = {
      ...folder('AlphaLink', '9d4f2a51-6b0e-4c7f-a7a2-3f1e0c2b8d64'),
      canonicalPath: alpha.canonicalPath,
    };

    expect(await open(store, alias)).toBe(project);
  } finally {
    await store.close();
  }
});

test('a folder the person picks again after its path began to lead elsewhere keeps its project', async () => {
  const store = await StateStore.open(freshDir('projects-repin'));
  try {
    const project = await open(store, alpha);

    expect(await open(store, { ...alpha, canonicalPath: '/disposable/Elsewhere' }, true)).toBe(
      project
    );
    expect(await projectOf(store, alpha.preferredId)).toBe(project);
    // The place it left is no longer that project's: a folder opened there is another project.
    const leftBehind = folder('Alpha2', '0b8f3d2e-7c41-4a5e-9d36-2f1e8a4c6b90');
    expect(await open(store, { ...leftBehind, canonicalPath: alpha.canonicalPath })).not.toBe(
      project
    );
  } finally {
    await store.close();
  }
});

test('a second path to a folder keeps the project when the first path is picked again elsewhere', async () => {
  const store = await StateStore.open(freshDir('projects-repin-alias'));
  try {
    const project = await open(store, alpha);
    const alias = {
      ...folder('AlphaLink', '9d4f2a51-6b0e-4c7f-a7a2-3f1e0c2b8d64'),
      canonicalPath: alpha.canonicalPath,
    };
    await open(store, alias);

    expect(await open(store, { ...alpha, canonicalPath: '/disposable/Elsewhere' }, true)).toBe(
      project
    );
    expect(await projectOf(store, alias.preferredId)).toBe(project);
  } finally {
    await store.close();
  }
});

test('a folder picked again where another project already is joins that project', async () => {
  const store = await StateStore.open(freshDir('projects-repin-join'));
  try {
    const alphaProject = await open(store, alpha);
    const bravoProject = await open(store, bravo);

    expect(await open(store, { ...alpha, canonicalPath: bravo.canonicalPath }, true)).toBe(
      bravoProject
    );
    expect(await projectOf(store, bravo.preferredId)).toBe(bravoProject);
    expect(bravoProject).not.toBe(alphaProject);
  } finally {
    await store.close();
  }
});

test('a managed worktree has no project of its own: it is a checkout of its repository', async () => {
  const store = await StateStore.open(freshDir('projects-worktree'));
  const linked = folder('linked', '7c1e5a90-3b2d-4f68-8a17-6d0c9e4b2f35');
  try {
    await store.worktreeLedger({
      operation: 'insert',
      row: {
        archivedAt: null,
        archiveSnapshotRef: null,
        baseRef: 'a'.repeat(40),
        branch: 'feature',
        createdAt: '2026-11-10T00:00:00.000Z',
        createdBy: 'user',
        id: 'worktree-linked',
        path: linked.path,
        repoCommonDir: `${alpha.path}/.git`,
        runId: null,
        setupOutput: null,
        setupReason: null,
        setupStatus: 'none',
        threadId: 'thread-linked',
      },
    });
    expect(await open(store, alpha)).toEqual(expect.stringMatching(/\S/u));

    expect(await open(store, linked)).toBeNull();
    expect(await projectOf(store, linked.preferredId)).toBeNull();
    // Mounting it again at the next launch gives it none either.
    expect(await open(store, linked)).toBeNull();
  } finally {
    await store.close();
  }
});
