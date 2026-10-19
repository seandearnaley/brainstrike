import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runExecuteCommand,
  runReadWorkspaceFile,
} from '@brainstrike/host-capabilities/native-tools';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { singleRootRuntime } from './_tool-test-helpers';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-error-cause-')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { force: true, recursive: true });
});

it('retains the exact missing-cwd exception without changing the correctable message', async () => {
  const cause = Object.assign(new Error('PRIVATE filesystem detail'), { code: 'ENOENT' });
  const realpath = fs.realpath;
  vi.spyOn(fs, 'realpath').mockImplementation(async (input, options) => {
    if (input === path.join(root, 'missing')) {
      throw cause;
    }
    return realpath(input, options);
  });
  const pending = runExecuteCommand(
    { command: 'never-spawned', cwd: 'missing' },
    singleRootRuntime(root),
    {
      windowsCommandEntry: () => {
        throw new Error('must not spawn');
      },
    }
  );
  await expect(pending).rejects.toMatchObject({
    code: 'tool_input_invalid',
    message: 'cwd "missing" does not exist.',
  });
  await expect(pending).rejects.toSatisfy((error: Error) => error.cause === cause);
});

it('retains the exact fatal decoder exception through the real read path', async () => {
  await fs.writeFile(path.join(root, 'data.txt'), 'text');
  const cause = new TypeError('PRIVATE malformed bytes');
  vi.spyOn(TextDecoder.prototype, 'decode').mockImplementationOnce(() => {
    throw cause;
  });
  const pending = runReadWorkspaceFile({ path: '/data.txt' }, singleRootRuntime(root), null);
  await expect(pending).rejects.toMatchObject({
    code: 'tool_input_invalid',
    message: 'Path "/data.txt" contains malformed UTF-8 and cannot be read as text.',
  });
  await expect(pending).rejects.toSatisfy((error: Error) => error.cause === cause);
});

it('propagates an unclassified original filesystem error by identity', async () => {
  const cause = new Error('PRIVATE unchanged failure');
  vi.spyOn(fs, 'realpath').mockRejectedValueOnce(cause);
  await expect(
    runExecuteCommand({ command: 'never-spawned', cwd: 'missing' }, singleRootRuntime(root), {
      windowsCommandEntry: () => {
        throw new Error('must not spawn');
      },
    })
  ).rejects.toBe(cause);
});
