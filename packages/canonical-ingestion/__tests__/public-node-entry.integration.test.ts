import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);

it('loads the built public host and canonical parser in plain Node without source aliases', async () => {
  const { stdout } = await execute(process.execPath, ['test/retained-source-smoke.mjs'], {
    cwd: new URL('..', import.meta.url),
    timeout: 15_000,
  });
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as unknown;
  expect(result).toEqual({
    builtNodeEntry: true,
    canonicalParity: true,
    chunks: 2,
    rootlessCollection: true,
  });
});

it('loads built discovery preparation in plain Node before canonical publication', async () => {
  const { stdout } = await execute(process.execPath, ['test/discovered-source-smoke.mjs'], {
    cwd: new URL('..', import.meta.url),
    timeout: 15_000,
  });
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as unknown;
  expect(result).toEqual({
    canonicalIdentity: true,
    canonicalParity: true,
    discoveredSource: true,
    joinedClose: true,
    originalSource: true,
  });
});
