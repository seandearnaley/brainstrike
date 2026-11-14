// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { trashEveryScratchFolder } from '../scratch-folder-trash';
import { scratchTrashDestination } from '../scratch-trash-destination';

// ADR-0034: desktop E2E moves a trashed scratch folder into the folder the harness names, so no
// test run puts a folder in the machine's Trash, and test mode never falls back to it.
let base: string;
let userData: string;
let testTrash: string;
let folder: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'bs-scratch-trash-destination-')));
  userData = path.join(base, 'profile');
  testTrash = path.join(base, 'test-trash');
  folder = path.join(userData, 'scratch', 'quiet-otter');
  mkdirSync(folder, { recursive: true });
  mkdirSync(testTrash);
  writeFileSync(path.join(folder, 'notes.txt'), 'scratch notes\n');
});

afterEach(() => {
  rmSync(base, { force: true, recursive: true });
});

test('desktop E2E moves a trashed folder into the folder BRAINSTRIKE_E2E_TRASH_DIR names, never the system Trash', async () => {
  const systemTrash = vi.fn(async () => undefined);
  const trash = scratchTrashDestination({
    e2e: true,
    env: { BRAINSTRIKE_E2E_TRASH_DIR: testTrash },
    systemTrash,
  });

  await expect(trashEveryScratchFolder(userData, trash)).resolves.toEqual({
    retained: [],
    trashed: [folder],
  });

  expect(existsSync(folder)).toBe(false);
  expect(await readFile(path.join(testTrash, 'quiet-otter', 'notes.txt'), 'utf8')).toBe(
    'scratch notes\n'
  );
  expect(systemTrash).not.toHaveBeenCalled();
});

test.each([
  ['names no folder', {}],
  ['names an empty one', { BRAINSTRIKE_E2E_TRASH_DIR: '' }],
  ['names a relative one', { BRAINSTRIKE_E2E_TRASH_DIR: 'relative/trash' }],
])(
  'desktop E2E keeps the folder in place and names why when BRAINSTRIKE_E2E_TRASH_DIR %s',
  async (_name, env) => {
    const systemTrash = vi.fn(async () => undefined);
    const trash = scratchTrashDestination({ e2e: true, env, systemTrash });

    await expect(trash(folder)).rejects.toMatchObject({
      message: expect.stringContaining('BRAINSTRIKE_E2E_TRASH_DIR'),
      name: 'E2eTrashDirectoryError',
    });
    const outcome = await trashEveryScratchFolder(userData, trash);

    expect(outcome.trashed).toEqual([]);
    expect(outcome.retained).toEqual([
      { path: folder, reason: expect.stringContaining('BRAINSTRIKE_E2E_TRASH_DIR') },
    ]);
    expect(existsSync(path.join(folder, 'notes.txt'))).toBe(true);
    expect(systemTrash).not.toHaveBeenCalled();
  }
);

test('a shipped build moves the folder to the system Trash, whatever the variable names', async () => {
  const systemTrash = vi.fn(async () => undefined);
  const trash = scratchTrashDestination({
    e2e: false,
    env: { BRAINSTRIKE_E2E_TRASH_DIR: testTrash },
    systemTrash,
  });

  await trash(folder);

  expect(systemTrash).toHaveBeenCalledWith(folder);
  expect(existsSync(folder)).toBe(true);
});
