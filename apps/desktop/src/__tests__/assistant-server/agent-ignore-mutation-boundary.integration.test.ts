/**
 * The agent-ignore and credential boundaries bind on every MUTATION tool, not
 * only on the read paths (BST-1433). An agent that may not look at a file must
 * not overwrite, edit, delete or move it either: the blind write was the one
 * path left open, since the staleness guard only binds a file the agent read.
 *
 * Rename refuses in BOTH directions. Moving a file out of an ignored path would
 * let the agent read it under its new name; moving one in could clobber or hide
 * a protected file.
 */
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { resetToolCallLoopGuards } from '@brainstrike/host-capabilities/native-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHostNativeTools } from './_host-native-tools';
import { requireToolExecute, singleRootRuntime } from './_tool-test-helpers';
import { createWorkspaceFixture } from './_workspace-fixture';

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: vi.fn(() => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
  };
});

const IGNORED =
  'excluded by an agent ignore file (.llmignore/.brainstrikeignore) and cannot be changed';
const CREDENTIAL =
  'is a credential file (an environment file or private key), which agent tools never read or change';
const SECRET = 'export const apiKey = "do-not-touch";\n';

let root: string;

async function contents(relative: string): Promise<string> {
  return await fsPromises.readFile(path.join(root, relative), 'utf8');
}

async function exists(relative: string): Promise<boolean> {
  return await fsPromises.access(path.join(root, relative)).then(
    () => true,
    () => false
  );
}

function tool(name: string) {
  return requireToolExecute(buildHostNativeTools(singleRootRuntime(root)), name);
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetToolCallLoopGuards();
  root = await createWorkspaceFixture();
  await fsPromises.writeFile(path.join(root, '.llmignore'), 'secrets/\n', 'utf8');
  await fsPromises.mkdir(path.join(root, 'secrets'));
  await fsPromises.writeFile(path.join(root, 'secrets', 'key.ts'), SECRET, 'utf8');
  await fsPromises.writeFile(path.join(root, '.env'), 'TOKEN=do-not-touch\n', 'utf8');
});

afterEach(async () => {
  await fsPromises.rm(root, { force: true, recursive: true });
});

describe('writeWorkspaceFile', () => {
  it('refuses to overwrite an agent-ignored file and leaves it intact', async () => {
    await expect(
      tool('brainstrike.writeWorkspaceFile')({ content: 'clobbered', path: '/secrets/key.ts' })
    ).rejects.toThrow(IGNORED);
    expect(await contents('secrets/key.ts')).toBe(SECRET);
  });

  it('refuses to create a file at an agent-ignored path', async () => {
    await expect(
      tool('brainstrike.writeWorkspaceFile')({ content: 'new', path: '/secrets/new.ts' })
    ).rejects.toThrow(IGNORED);
    expect(await exists('secrets/new.ts')).toBe(false);
  });

  it('refuses a write through an in-root alias of an agent-ignored file', async () => {
    await fsPromises.symlink(
      path.join(root, 'secrets', 'key.ts'),
      path.join(root, 'src', 'alias.ts')
    );
    await expect(
      tool('brainstrike.writeWorkspaceFile')({ content: 'clobbered', path: '/src/alias.ts' })
    ).rejects.toThrow(IGNORED);
    expect(await contents('secrets/key.ts')).toBe(SECRET);
  });

  it('refuses to overwrite a credential file', async () => {
    await expect(
      tool('brainstrike.writeWorkspaceFile')({ content: 'TOKEN=', path: '/.env' })
    ).rejects.toThrow(CREDENTIAL);
    expect(await contents('.env')).toBe('TOKEN=do-not-touch\n');
  });

  it('still writes an ordinary file', async () => {
    await tool('brainstrike.writeWorkspaceFile')({ content: 'ok', path: '/src/ok.ts' });
    expect(await contents('src/ok.ts')).toBe('ok');
  });
});

describe('stringReplaceWorkspaceFile', () => {
  it('refuses to edit an agent-ignored file, whose match would reveal its contents', async () => {
    await expect(
      tool('brainstrike.stringReplaceWorkspaceFile')({
        newStr: 'leaked',
        oldStr: 'do-not-touch',
        path: '/secrets/key.ts',
      })
    ).rejects.toThrow(IGNORED);
    expect(await contents('secrets/key.ts')).toBe(SECRET);
  });

  it('refuses to edit a credential file', async () => {
    await expect(
      tool('brainstrike.stringReplaceWorkspaceFile')({
        newStr: 'TOKEN=x',
        oldStr: 'TOKEN=do-not-touch',
        path: '/.env',
      })
    ).rejects.toThrow(CREDENTIAL);
    expect(await contents('.env')).toBe('TOKEN=do-not-touch\n');
  });
});

describe('deleteWorkspaceFile', () => {
  it('refuses to delete an agent-ignored file', async () => {
    await expect(
      tool('brainstrike.deleteWorkspaceFile')({ path: '/secrets/key.ts' })
    ).rejects.toThrow(IGNORED);
    expect(await contents('secrets/key.ts')).toBe(SECRET);
  });

  it('refuses to delete a credential file', async () => {
    await expect(tool('brainstrike.deleteWorkspaceFile')({ path: '/.env' })).rejects.toThrow(
      CREDENTIAL
    );
    expect(await exists('.env')).toBe(true);
  });
});

describe('renameWorkspaceFile', () => {
  it('refuses to move an agent-ignored file OUT to a readable path', async () => {
    await expect(
      tool('brainstrike.renameWorkspaceFile')({
        fromPath: '/secrets/key.ts',
        toPath: '/src/key.ts',
      })
    ).rejects.toThrow(IGNORED);
    expect(await contents('secrets/key.ts')).toBe(SECRET);
    expect(await exists('src/key.ts')).toBe(false);
  });

  it('refuses to move a file IN to an agent-ignored path', async () => {
    await expect(
      tool('brainstrike.renameWorkspaceFile')({
        fromPath: '/src/lib/math.ts',
        toPath: '/secrets/key.ts',
      })
    ).rejects.toThrow(IGNORED);
    expect(await contents('secrets/key.ts')).toBe(SECRET);
    expect(await exists('src/lib/math.ts')).toBe(true);
  });

  it('refuses to move a credential file', async () => {
    await expect(
      tool('brainstrike.renameWorkspaceFile')({ fromPath: '/.env', toPath: '/env.txt' })
    ).rejects.toThrow(CREDENTIAL);
    expect(await exists('.env')).toBe(true);
  });

  it('still renames between ordinary paths', async () => {
    await tool('brainstrike.renameWorkspaceFile')({
      fromPath: '/src/lib/math.ts',
      toPath: '/src/lib/sum.ts',
    });
    expect(await exists('src/lib/sum.ts')).toBe(true);
  });
});
