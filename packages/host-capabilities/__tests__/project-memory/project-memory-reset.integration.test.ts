/**
 * ADR-0040: project memory joins the reset lifecycle (ADR-0015). Clear
 * Database, Factory Reset and deleting a project each remove its folder.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireProfileResetLease } from '@brainstrike/host-lease';
import { PROJECT_MEMORY_DIR, StateStore } from '@brainstrike/state-store';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ProjectMemoryNotes } from '../../src/project-memory/memory-notes.ts';
import { createHostRootRegistry } from '../../src/workspace-roots/index.ts';

let base: string;
let dataRoot: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'bs-project-memory-reset-')));
  dataRoot = path.join(base, 'profile');
});

afterEach(() => {
  rmSync(base, { force: true, recursive: true });
});

async function saveNote(projectId: string): Promise<ProjectMemoryNotes> {
  const notes = new ProjectMemoryNotes(dataRoot, projectId);
  await notes.execute(
    { command: 'create', file_text: '# Fact\nkept\n', path: '/memories/fact.md' },
    { untrusted: false }
  );
  expect(existsSync(path.join(notes.folder, 'MEMORY.md'))).toBe(true);
  return notes;
}

test('Clear Database removes every project memory folder with the content', async () => {
  const store = await StateStore.open(dataRoot);
  await saveNote('project-1');
  await saveNote('project-2');

  await store.clearContent();

  expect(existsSync(path.join(dataRoot, PROJECT_MEMORY_DIR))).toBe(false);
});

test('Factory Reset clears project memory with the rest of the data root', async () => {
  const store = await StateStore.open(dataRoot);
  await store.close();
  await saveNote('project-1');
  const lease = await acquireProfileResetLease(dataRoot);
  try {
    await lease.clearRootContents();
  } finally {
    lease.release();
  }

  expect(existsSync(path.join(dataRoot, PROJECT_MEMORY_DIR))).toBe(false);
});

test("deleting a project, when its last folder joins another, removes that project's memory", async () => {
  const store = await StateStore.open(dataRoot);
  const [alpha, beta] = ['alpha', 'beta'].map((name) => {
    const folder = path.join(base, name);
    mkdirSync(folder);
    return folder;
  });
  const picks = [alpha ?? '', beta ?? ''];
  const owner = createHostRootRegistry({
    disposeCommandSessionsForRoot: async () => 0,
    e2e: false,
    evictLspServersForRoot: async () => undefined,
    managedWorktreeAuthorizer: async () => 'unmanaged',
    pickFolder: async () => picks.shift() ?? null,
    publishRootsChanged: async () => undefined,
    store,
  });
  try {
    await owner.service['workspace/roots/pick']({});
    const { root: betaRoot } = await owner.service['workspace/roots/pick']({});
    const [alphaRecord, betaRecord] = (await store.workspaceRoots({ operation: 'list' })).roots;
    const kept = await saveNote(alphaRecord?.projectId ?? '');
    const deleted = await saveNote(betaRecord?.projectId ?? '');

    await owner.service['projects/join']({
      projectId: alphaRecord?.projectId ?? '',
      rootId: betaRoot?.rootId ?? '',
    });

    expect(existsSync(deleted.folder)).toBe(false);
    expect(existsSync(path.join(kept.folder, 'fact.md'))).toBe(true);
  } finally {
    await owner.close();
    await store.close();
  }
});
