/**
 * ADR-0040: which project's memory a run has. The project of the folder it
 * works in, while that folder is trusted; none for a folder with no project,
 * such as a scratch folder, and none when the run has no one folder to work in.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { readRunProjectMemory } from '../../src/project-memory/memory-admission.ts';

let base: string;
let store: StateStore;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'bs-project-memory-admission-')));
  store = await StateStore.open(path.join(base, 'profile'));
});

afterEach(async () => {
  await store.close();
  rmSync(base, { force: true, recursive: true });
});

/** A folder on disk, recorded with a project when `recorded`, as the registry records one. */
async function folder(name: string, recorded: boolean) {
  const at = path.join(base, name);
  mkdirSync(at);
  const root = { displayName: name, path: at, rootId: `root-${name}` };
  if (recorded) {
    await store.workspaceRoots({
      operation: 'register',
      root: { canonicalPath: at, displayName: name, path: at, preferredId: root.rootId },
    });
  }
  return root;
}

test("a run in a trusted folder has its project's memory, with no notes yet", async () => {
  const beaker = await folder('beaker', true);

  const memory = await readRunProjectMemory({
    configurationRoots: [beaker],
    operatingRootId: beaker.rootId,
    roots: [beaker],
    store,
  });

  const { roots } = await store.workspaceRoots({ operation: 'list' });
  expect(memory?.projectId).toBe(roots[0]?.projectId);
  expect(memory?.section).toContain('# Project memory');
  expect(memory?.section).toContain('No notes yet.');
  expect(memory?.childSection).not.toContain('memory tool');
});

test('a folder with no project, as a scratch folder has none, has no memory', async () => {
  const scratch = await folder('scratch', false);

  await expect(
    readRunProjectMemory({
      configurationRoots: [scratch],
      operatingRootId: scratch.rootId,
      roots: [scratch],
      store,
    })
  ).resolves.toBeUndefined();
});

test('an untrusted folder, or several folders and no binding, has no memory', async () => {
  const [alpha, bravo] = [await folder('alpha', true), await folder('bravo', true)];

  await expect(
    readRunProjectMemory({ configurationRoots: [], roots: [alpha], store })
  ).resolves.toBeUndefined();
  await expect(
    readRunProjectMemory({ configurationRoots: [alpha, bravo], roots: [alpha, bravo], store })
  ).resolves.toBeUndefined();
  // The binding names the folder the run works in.
  await expect(
    readRunProjectMemory({
      configurationRoots: [alpha, bravo],
      operatingRootId: bravo.rootId,
      roots: [alpha, bravo],
      store,
    })
  ).resolves.toMatchObject({ projectId: expect.any(String) });
});
