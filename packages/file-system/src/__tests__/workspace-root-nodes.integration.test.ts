// @vitest-environment node
import { execFile } from 'node:child_process';
import { URL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);

it('loads the built pure root projection in Node with retained metadata, symlink shape and visible truncation', async () => {
  const { stdout } = await execute(process.execPath, ['test/workspace-root-nodes-smoke.mjs'], {
    cwd: new URL('../..', import.meta.url),
    timeout: 15_000,
  });
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as unknown;
  expect(result).toEqual({
    metadata: true,
    nodeEntry: true,
    noFollowShape: true,
    retainedRootIdentity: true,
    truncationVisible: true,
  });
});
