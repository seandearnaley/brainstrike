// @vitest-environment node
import { execFile } from 'node:child_process';
import { URL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);

it('runs the built public traversal in plain Node and bundles its browser entry without source aliases', async () => {
  const { stdout } = await execute(process.execPath, ['test/directory-tree-smoke.mjs'], {
    cwd: new URL('../..', import.meta.url),
    timeout: 15_000,
  });
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as unknown;
  expect(result).toEqual({
    browserBundle: true,
    nativeReads: 2,
    nodeEntry: true,
    retainedRootIdentity: true,
  });
});
