import { afterEach, expect, test } from 'vitest';
import { StateStoreRefusalError } from '../src/errors.js';
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

async function nameOf(store: StateStore, rootId: string): Promise<string | null | undefined> {
  const { roots } = await store.workspaceRoots({ operation: 'list' });
  return roots.find((root) => root.id === rootId)?.projectName;
}

async function rename(store: StateStore, projectId: string | null | undefined, name: string) {
  return (
    await store.workspaceRoots({ name, operation: 'rename-project', projectId: projectId ?? '' })
  ).roots;
}

async function join(store: StateStore, rootId: string, projectId: string | null | undefined) {
  return (
    await store.workspaceRoots({ operation: 'join-project', projectId: projectId ?? '', rootId })
  ).roots;
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
        baseCommit: 'a'.repeat(40),
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

// ADR-0034 build decisions: a project can be named, and the person can join a folder (a second
// clone, or a folder picked again elsewhere) to another project.
const charlie = folder('Charlie', '3f6b2d18-9c4e-4a71-b5d0-8e2c7a1f9b43');

test('a project is named, its name trimmed and kept across a restart, and an empty name clears it', async () => {
  const root = freshDir('projects-name');
  let store = await StateStore.open(root);
  try {
    const project = await open(store, alpha);
    expect(await nameOf(store, alpha.preferredId)).toBeNull();

    expect(await rename(store, project, '  Brainstrike app \n')).toEqual([
      expect.objectContaining({
        id: alpha.preferredId,
        projectId: project,
        projectName: 'Brainstrike app',
      }),
    ]);
    await store.close();
    store = await StateStore.open(root);
    expect(await nameOf(store, alpha.preferredId)).toBe('Brainstrike app');
    // Opening the folder again keeps its project's name.
    const { roots } = await store.workspaceRoots({ operation: 'register', root: alpha });
    expect(roots).toEqual([expect.objectContaining({ projectName: 'Brainstrike app' })]);

    expect(await rename(store, project, '   ')).toEqual([
      expect.objectContaining({ id: alpha.preferredId, projectName: null }),
    ]);
    expect(await nameOf(store, alpha.preferredId)).toBeNull();
  } finally {
    await store.close();
  }
});

test('a name longer than 80 characters is refused and the name stays as it was', async () => {
  const store = await StateStore.open(freshDir('projects-name-cap'));
  try {
    const project = await open(store, alpha);
    await rename(store, project, 'Kept');

    await expect(rename(store, project, 'x'.repeat(81))).rejects.toThrow(/at most 80 characters/u);
    expect(await nameOf(store, alpha.preferredId)).toBe('Kept');
    // The cap counts characters, so 80 emoji, 160 UTF-16 code units, is a name.
    await rename(store, project, '🙂'.repeat(80));
    expect(await nameOf(store, alpha.preferredId)).toBe('🙂'.repeat(80));
  } finally {
    await store.close();
  }
});

test('a folder joined to another project lists with it, and the project it left with no folder is deleted', async () => {
  const store = await StateStore.open(freshDir('projects-join'));
  try {
    const alphaProject = await open(store, alpha);
    const bravoProject = await open(store, bravo);
    await rename(store, alphaProject, 'Shared');
    await rename(store, bravoProject, 'Bravo alone');

    expect(await join(store, bravo.preferredId, alphaProject)).toEqual([
      expect.objectContaining({
        id: bravo.preferredId,
        projectId: alphaProject,
        projectName: 'Shared',
      }),
    ]);
    expect(await projectOf(store, bravo.preferredId)).toBe(alphaProject);
    expect(await projectOf(store, alpha.preferredId)).toBe(alphaProject);
    // Bravo's own project had no other folder: it went with the join.
    await expect(rename(store, bravoProject, 'Back')).rejects.toThrow(/no project/u);
    // Opening the joined folder again keeps the project it joined.
    expect(await open(store, bravo)).toBe(alphaProject);
  } finally {
    await store.close();
  }
});

test('a project keeps its id and name while another folder is still in it', async () => {
  const store = await StateStore.open(freshDir('projects-join-kept'));
  try {
    const alphaProject = await open(store, alpha);
    await open(store, bravo);
    const charlieProject = await open(store, charlie);
    await rename(store, alphaProject, 'Alpha');
    await join(store, bravo.preferredId, alphaProject);

    // Bravo moves on to Charlie's project; Alpha's keeps Alpha.
    await join(store, bravo.preferredId, charlieProject);
    expect(await projectOf(store, bravo.preferredId)).toBe(charlieProject);
    expect(await projectOf(store, alpha.preferredId)).toBe(alphaProject);
    expect(await nameOf(store, alpha.preferredId)).toBe('Alpha');
    // Joining the project a folder is already in changes nothing.
    expect(await join(store, alpha.preferredId, alphaProject)).toEqual([
      expect.objectContaining({ id: alpha.preferredId, projectId: alphaProject }),
    ]);
  } finally {
    await store.close();
  }
});

test('a managed worktree, a scratch folder, an unknown folder and an unknown project are refused, and nothing changes', async () => {
  const store = await StateStore.open(freshDir('projects-join-refused'));
  const linked = folder('linked', '7c1e5a90-3b2d-4f68-8a17-6d0c9e4b2f35');
  const adopted = folder('adopted', '1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f');
  const ledgerRow = (id: string, path: string) => ({
    archivedAt: null,
    archiveSnapshotRef: null,
    baseCommit: 'a'.repeat(40),
    baseRef: 'a'.repeat(40),
    branch: id,
    createdAt: '2026-11-12T00:00:00.000Z',
    createdBy: 'user' as const,
    id,
    path,
    repoCommonDir: `${alpha.path}/.git`,
    runId: null,
    setupOutput: null,
    setupReason: null,
    setupStatus: 'none' as const,
    threadId: null,
  });
  try {
    const alphaProject = await open(store, alpha);
    await store.worktreeLedger({
      operation: 'insert',
      row: ledgerRow('worktree-linked', linked.path),
    });
    await open(store, linked);
    // A folder opened first and adopted as a managed worktree afterwards keeps its project, and
    // is still a worktree: it cannot join another.
    const adoptedProject = await open(store, adopted);
    await store.worktreeLedger({
      operation: 'insert',
      row: ledgerRow('worktree-adopted', adopted.path),
    });
    const scratch = folder('scratch-quiet-otter', '8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c2d');
    await store.workspaceRoots({ operation: 'register-scratch', root: scratch, threadId: 't1' });

    // Each is a refusal the host can pass on with its code, not a failure.
    const refused = (code: string, message: RegExp) =>
      expect.objectContaining({ code, message: expect.stringMatching(message) });
    const threadFolder = refused('project.thread-folder', /managed worktree or a scratch folder/u);
    await expect(join(store, linked.preferredId, alphaProject)).rejects.toEqual(threadFolder);
    await expect(join(store, adopted.preferredId, alphaProject)).rejects.toEqual(threadFolder);
    await expect(join(store, scratch.preferredId, alphaProject)).rejects.toEqual(threadFolder);
    await expect(join(store, 'no-such-folder', alphaProject)).rejects.toEqual(
      refused('project.folder-unknown', /no folder/u)
    );
    await expect(join(store, alpha.preferredId, 'no-such-project')).rejects.toBeInstanceOf(
      StateStoreRefusalError
    );
    await expect(rename(store, 'no-such-project', 'Name')).rejects.toEqual(
      refused('project.unknown', /no project/u)
    );

    expect(await projectOf(store, linked.preferredId)).toBeNull();
    expect(await projectOf(store, adopted.preferredId)).toBe(adoptedProject);
    expect(await projectOf(store, scratch.preferredId)).toBeNull();
    expect(await projectOf(store, alpha.preferredId)).toBe(alphaProject);
  } finally {
    await store.close();
  }
});

// ADR-0034 relink: a folder opened first and adopted as a managed worktree keeps kind `path`, but
// the worktree ledger names it at its path. Moving its record to another folder would part the
// thread's root from the checkout the ledger records.
test("a managed worktree's record is never re-pinned to another folder, even one opened before it was adopted", async () => {
  const store = await StateStore.open(freshDir('projects-relink-worktree'));
  const adopted = folder('adopted', '1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f');
  const elsewhere = { ...folder('elsewhere', adopted.preferredId) };
  try {
    await open(store, adopted);
    await store.worktreeLedger({
      operation: 'insert',
      row: {
        archivedAt: null,
        archiveSnapshotRef: null,
        baseCommit: 'a'.repeat(40),
        baseRef: 'a'.repeat(40),
        branch: 'adopted',
        createdAt: '2026-11-12T00:00:00.000Z',
        createdBy: 'user',
        id: 'worktree-adopted',
        path: adopted.path,
        repoCommonDir: `${alpha.path}/.git`,
        runId: null,
        setupOutput: null,
        setupReason: null,
        setupStatus: 'none',
        threadId: null,
      },
    });

    await expect(open(store, elsewhere, true)).rejects.toEqual(
      expect.objectContaining({
        code: 'workspace.locate-unknown',
        message: expect.stringMatching(/worktree or a scratch folder goes with its thread/u),
      })
    );
    const { roots } = await store.workspaceRoots({ operation: 'list' });
    expect(roots).toEqual([
      expect.objectContaining({ id: adopted.preferredId, path: adopted.path }),
    ]);
  } finally {
    await store.close();
  }
});

test("joining a project writes no trust or hook-approval record: the folder keeps its own answers and takes none of the project's", async () => {
  const store = await StateStore.open(freshDir('projects-join-trust'));
  // The host keys a folder's trust and its approved hooks by the folder's canonical path.
  const keys = (canonicalPath: string) => [
    `workspace.trust/${canonicalPath}`,
    `hooks.approved/${canonicalPath}`,
  ];
  const answers = async () =>
    Promise.all(
      [...keys(alpha.canonicalPath), ...keys(bravo.canonicalPath)].map((key) =>
        store.getSetting(key)
      )
    );
  try {
    const alphaProject = await open(store, alpha);
    await open(store, bravo);
    await store.setSetting(`workspace.trust/${alpha.canonicalPath}`, 'trusted');
    await store.setSetting(`hooks.approved/${alpha.canonicalPath}`, 'b'.repeat(64));
    await store.setSetting(`workspace.trust/${bravo.canonicalPath}`, 'restricted');
    const before = await answers();

    await join(store, bravo.preferredId, alphaProject);

    expect(await answers()).toEqual(before);
    expect(await store.getSetting(`workspace.trust/${bravo.canonicalPath}`)).toBe('restricted');
    expect(await store.getSetting(`hooks.approved/${bravo.canonicalPath}`)).toBeUndefined();
  } finally {
    await store.close();
  }
});

// ADR-0034 build decisions (BST-2511, BST-2520): a repository found inside an open folder has no
// root of its own. Its project is read by its checkout's canonical path, which never writes one;
// the person's first Rename project… or Move to project… on its section makes it, in that commit.
const nestedRepository = `${alpha.canonicalPath}/vendor/inner`;

async function repositoryProjects(store: StateStore, ...canonicalPaths: string[]) {
  return (await store.workspaceRoots({ canonicalPaths, operation: 'repository-projects' }))
    .projects;
}

function renameRepository(store: StateStore, canonicalPath: string, name: string) {
  return store.workspaceRoots({ canonicalPath, name, operation: 'rename-project' });
}

function joinRepository(
  store: StateStore,
  canonicalPath: string,
  projectId: string | null | undefined
) {
  return store.workspaceRoots({
    canonicalPath,
    operation: 'join-project',
    projectId: projectId ?? '',
  });
}

test("reading a repository's project writes none; its first rename makes one, and a second keeps its id", async () => {
  const root = freshDir('projects-repository');
  let store = await StateStore.open(root);
  try {
    const alphaProject = await open(store, alpha);
    expect(await repositoryProjects(store, nestedRepository)).toEqual([]);
    // A name cleared, or one too long, before there is a project writes nothing either.
    await renameRepository(store, nestedRepository, '  ');
    await expect(renameRepository(store, nestedRepository, 'x'.repeat(81))).rejects.toThrow(
      /at most 80 characters/u
    );
    expect(await repositoryProjects(store, nestedRepository)).toEqual([]);

    await renameRepository(store, nestedRepository, ' Inner ');
    const [made] = (await repositoryProjects(store, nestedRepository)) ?? [];
    expect(made).toEqual({
      canonicalPath: nestedRepository,
      id: expect.stringMatching(/\S/u),
      name: 'Inner',
    });
    expect(made?.id).not.toBe(alphaProject);
    await renameRepository(store, nestedRepository, 'Inner library');
    const named = { ...made, name: 'Inner library' };
    expect(await repositoryProjects(store, nestedRepository)).toEqual([named]);
    // It is not an open folder: no root is recorded for it.
    expect((await store.workspaceRoots({ operation: 'list' })).roots).toEqual([
      expect.objectContaining({ id: alpha.preferredId, projectId: alphaProject }),
    ]);

    // Closing the folder that holds it, and a restart, leave it to be read.
    await store.workspaceRoots({
      closeRootIds: [alpha.preferredId],
      mountedPaths: [],
      operation: 'disconnect-except',
    });
    await store.close();
    store = await StateStore.open(root);
    expect(await repositoryProjects(store, '/disposable/elsewhere', nestedRepository)).toEqual([
      named,
    ]);
    // Opened by itself, the repository's folder is the same project.
    const inner = {
      ...folder('inner', '6e2b1c4d-8f0a-4b3e-9d71-5a2c8e4f0b16'),
      canonicalPath: nestedRepository,
      path: nestedRepository,
    };
    expect(await open(store, inner)).toBe(made?.id);
  } finally {
    await store.close();
  }
});

test('a repository moved into another project by its path joins it, writing no trust, and a project it leaves empty is deleted', async () => {
  const store = await StateStore.open(freshDir('projects-repository-join'));
  try {
    const alphaProject = await open(store, alpha);
    const bravoProject = await open(store, bravo);
    // With no project of its own yet, the move makes its folder row in the chosen project.
    await joinRepository(store, nestedRepository, alphaProject);
    expect(await repositoryProjects(store, nestedRepository)).toEqual([
      { canonicalPath: nestedRepository, id: alphaProject, name: null },
    ]);

    // Named first, it leaves its own project, which goes with no folder left in it.
    const library = `${bravo.canonicalPath}/lib`;
    await renameRepository(store, library, 'Library');
    const [own] = (await repositoryProjects(store, library)) ?? [];
    await joinRepository(store, library, bravoProject);
    expect(await repositoryProjects(store, library)).toEqual([
      { canonicalPath: library, id: bravoProject, name: null },
    ]);
    await expect(rename(store, own?.id, 'Gone')).rejects.toThrow(/no project/u);
    expect(await store.getSetting(`workspace.trust/${nestedRepository}`)).toBeUndefined();
    expect(await store.getSetting(`hooks.approved/${nestedRepository}`)).toBeUndefined();

    // An unknown project is refused, and nothing is written.
    const other = `${alpha.canonicalPath}/other`;
    await expect(joinRepository(store, other, 'no-such-project')).rejects.toEqual(
      expect.objectContaining({ code: 'project.unknown' })
    );
    expect(await repositoryProjects(store, other)).toEqual([]);
  } finally {
    await store.close();
  }
});

test('no project is made for a path inside a .git folder, a scratch folder or a managed worktree', async () => {
  const store = await StateStore.open(freshDir('projects-repository-refused'));
  const linked = folder('linked', '7c1e5a90-3b2d-4f68-8a17-6d0c9e4b2f35');
  const scratch = folder('scratch-quiet-otter', '8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c2d');
  try {
    const alphaProject = await open(store, alpha);
    await store.worktreeLedger({
      operation: 'insert',
      row: {
        archivedAt: null,
        archiveSnapshotRef: null,
        baseCommit: 'a'.repeat(40),
        baseRef: 'a'.repeat(40),
        branch: 'feature',
        createdAt: '2026-11-13T00:00:00.000Z',
        createdBy: 'user',
        id: 'worktree-linked',
        path: linked.canonicalPath,
        repoCommonDir: `${alpha.path}/.git`,
        runId: null,
        setupOutput: null,
        setupReason: null,
        setupStatus: 'none',
        threadId: null,
      },
    });
    await store.workspaceRoots({ operation: 'register-scratch', root: scratch, threadId: 't1' });
    const refused = (code: string) => expect.objectContaining({ code });
    const cases = [
      // A submodule, as git names its main worktree: a folder inside the repository's .git.
      [`${alpha.canonicalPath}/.git/modules/vendor/inner`, 'project.not-a-checkout'],
      [scratch.canonicalPath, 'project.thread-folder'],
      [`${scratch.canonicalPath}/repository`, 'project.thread-folder'],
      [linked.canonicalPath, 'project.thread-folder'],
      [`${linked.canonicalPath}/vendor/inner`, 'project.thread-folder'],
    ] as const;
    for (const [canonicalPath, code] of cases) {
      await expect(renameRepository(store, canonicalPath, 'Named')).rejects.toEqual(refused(code));
      await expect(joinRepository(store, canonicalPath, alphaProject)).rejects.toEqual(
        refused(code)
      );
    }
    expect(
      await repositoryProjects(store, ...cases.map(([canonicalPath]) => canonicalPath))
    ).toEqual([]);
    await expect(renameRepository(store, '', 'Named')).rejects.toThrow(/canonical path/u);
    await expect(renameRepository(store, 'vendor/inner', 'Named')).rejects.toThrow(
      /canonical path/u
    );
  } finally {
    await store.close();
  }
});
