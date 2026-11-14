/**
 * BST-2534: a project's Memory panel, through the host's root registry and a real store. The
 * person lists, writes and deletes the project's notes through the one writer, whether or not
 * the project's folder is trusted (none is here); a path outside the project's folder, another
 * project's note and a deleted project's memory are refused.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  StateStore,
  StateStoreReadOnlyError,
  type WorkspaceRootRequest,
} from '@brainstrike/state-store';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ProjectMemoryNotes } from '../../src/project-memory/memory-notes.ts';
import {
  createHostRootRegistry,
  type HostRootRegistryOwner,
  type HostRootRegistryStore,
} from '../../src/workspace-roots/index.ts';

let base: string;
let store: StateStore;
let owner: HostRootRegistryOwner;
let alpha: string;
let beta: string;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'bs-project-memory-panel-')));
  store = await StateStore.open(path.join(base, 'profile'));
  const picks = ['alpha', 'beta'].map((name) => {
    const folder = path.join(base, name);
    mkdirSync(folder);
    return folder;
  });
  owner = createHostRootRegistry({
    disposeCommandSessionsForRoot: async () => 0,
    e2e: false,
    evictLspServersForRoot: async () => undefined,
    managedWorktreeAuthorizer: async () => 'unmanaged',
    pickFolder: async () => picks.shift() ?? null,
    publishRootsChanged: async () => undefined,
    store,
  });
  await owner.service['workspace/roots/pick']({});
  await owner.service['workspace/roots/pick']({});
  const [alphaRoot, betaRoot] = (await store.workspaceRoots({ operation: 'list' })).roots;
  alpha = alphaRoot?.projectId ?? '';
  beta = betaRoot?.projectId ?? '';
});

afterEach(async () => {
  await owner.close();
  await store.close();
  rmSync(base, { force: true, recursive: true });
});

const list = (projectId: string) => owner.service['projects/memory/list']({ projectId });
const write = (projectId: string, text: string, notePath?: string) =>
  owner.service['projects/memory/write']({
    projectId,
    text,
    ...(notePath === undefined ? {} : { path: notePath }),
  });
const index = (projectId: string) =>
  readFileSync(path.join(base, 'profile', 'project-memory', projectId, 'MEMORY.md'), 'utf8');

test("a person writes, lists and deletes a project's notes, and the index follows each change", async () => {
  await expect(list(alpha)).resolves.toEqual({ notes: [] });

  const made = await write(alpha, '# Test runtime\nThe tests need Node 26.\n');
  expect(made).toMatchObject({ path: '/memories/test-runtime.md', title: 'Test runtime' });
  expect(index(alpha)).toBe('- [Test runtime](test-runtime.md) — The tests need Node 26.\n');

  await write(alpha, '# Test runtime\nThe tests need Node 27.\n', made.path);
  expect(index(alpha)).toBe('- [Test runtime](test-runtime.md) — The tests need Node 27.\n');
  expect((await list(alpha)).notes).toEqual([
    {
      modifiedAt: expect.any(Number),
      path: '/memories/test-runtime.md',
      text: '# Test runtime\nThe tests need Node 27.\n',
      title: 'Test runtime',
      untrusted: false,
    },
  ]);
  // Another project's memory is its own.
  await expect(list(beta)).resolves.toEqual({ notes: [] });

  await expect(
    owner.service['projects/memory/delete']({ path: made.path, projectId: alpha })
  ).resolves.toBeNull();
  await expect(list(alpha)).resolves.toEqual({ notes: [] });
  expect(existsSync(path.join(base, 'profile', 'project-memory', alpha, 'MEMORY.md'))).toBe(false);
});

test("a person's write clears the mark untrusted context left on the note and its index line", async () => {
  const notes = await ProjectMemoryNotes.open(store.root, alpha);
  await notes.execute(
    { command: 'create', file_text: '# API base\nIt is /v2.\n', path: '/memories/api.md' },
    { untrusted: true }
  );
  expect((await list(alpha)).notes[0]?.untrusted).toBe(true);
  expect(index(alpha)).toBe('- [API base](api.md) — It is /v2. (untrusted)\n');

  await expect(write(alpha, '# API base\nIt is /v3.\n', '/memories/api.md')).resolves.toMatchObject(
    { untrusted: false }
  );
  expect((await list(alpha)).notes[0]?.untrusted).toBe(false);
  expect(index(alpha)).toBe('- [API base](api.md) — It is /v3.\n');
});

test("a path outside the project's folder, another project's note, and a secret are refused", async () => {
  await write(beta, '# Beta\nkept\n', '/memories/beta.md');

  for (const target of [`/memories/../${beta}/beta.md`, '/memories/%2e%2e/x.md']) {
    await expect(write(alpha, 'overwritten', target)).rejects.toMatchObject({
      failure: { code: 'memory.refused', kind: 'refusal' },
    });
    await expect(
      owner.service['projects/memory/delete']({ path: target, projectId: alpha })
    ).rejects.toMatchObject({ failure: { code: 'memory.refused', kind: 'refusal' } });
  }
  await expect(write(alpha, '- [Fake](f.md)', '/memories/MEMORY.md')).rejects.toMatchObject({
    failure: { code: 'memory.refused' },
  });
  await expect(write(alpha, `# Token\nUse ghp_${'a'.repeat(36)}.\n`)).rejects.toMatchObject({
    failure: { code: 'memory.secret', message: 'Not saved: holds a secret (github-token).' },
  });
  expect((await list(beta)).notes.map((note) => note.text)).toEqual(['# Beta\nkept\n']);
  await expect(list(alpha)).resolves.toEqual({ notes: [] });
});

test("a deleted project's memory is refused, and its folder is not made again", async () => {
  await write(beta, '# Beta\nkept\n');
  const [, betaRoot] = (await store.workspaceRoots({ operation: 'list' })).roots;
  await owner.service['projects/join']({ projectId: alpha, rootId: betaRoot?.id ?? '' });
  const folder = path.join(base, 'profile', 'project-memory', beta);
  expect(existsSync(folder)).toBe(false);

  const gone = { failure: { code: 'memory.project-gone', kind: 'refusal' } };
  await expect(list(beta)).rejects.toMatchObject(gone);
  await expect(write(beta, '# Late\nwritten after\n')).rejects.toMatchObject(gone);
  await expect(
    owner.service['projects/memory/delete']({ path: '/memories/beta.md', projectId: beta })
  ).rejects.toMatchObject(gone);
  expect(existsSync(folder)).toBe(false);
});

test('a read-only host lists the notes and refuses a write or a delete, as it refuses other project changes', async () => {
  const made = await write(alpha, '# Test runtime\nThe tests need Node 26.\n');
  // BST-2144: a store that opened damaged is read-only.
  const damaged: HostRootRegistryStore = {
    deleteSetting: (key) => store.deleteSetting(key),
    getSetting: (key) => store.getSetting(key),
    root: store.root,
    setSetting: (key, value) => store.setSetting(key, value),
    stateDamage: 'fixture damage',
    workspaceRoots: (request: WorkspaceRootRequest) => store.workspaceRoots(request),
  };
  const readOnly = createHostRootRegistry({
    disposeCommandSessionsForRoot: async () => 0,
    e2e: false,
    evictLspServersForRoot: async () => undefined,
    managedWorktreeAuthorizer: async () => 'unmanaged',
    pickFolder: async () => null,
    publishRootsChanged: async () => undefined,
    store: damaged,
  });
  try {
    await expect(
      readOnly.service['projects/memory/list']({ projectId: alpha })
    ).resolves.toMatchObject({ notes: [{ path: made.path }] });
    for (const change of [
      readOnly.service['projects/rename']({ name: 'Renamed', projectId: alpha }),
      readOnly.service['projects/memory/write']({ path: made.path, projectId: alpha, text: 'x' }),
      readOnly.service['projects/memory/write']({ projectId: alpha, text: '# New\nnote\n' }),
      readOnly.service['projects/memory/delete']({ path: made.path, projectId: alpha }),
    ]) {
      await expect(change).rejects.toBeInstanceOf(StateStoreReadOnlyError);
    }
    expect((await list(alpha)).notes.map((note) => note.text)).toEqual([
      '# Test runtime\nThe tests need Node 26.\n',
    ]);
  } finally {
    await readOnly.close();
  }
});
