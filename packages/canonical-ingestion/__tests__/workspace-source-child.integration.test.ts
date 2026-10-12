import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);

it('runs built discovery/read/watch ingestion in a joined child over the same pinned native root', async () => {
  const { stdout } = await execute(process.execPath, ['test/workspace-source-child.mjs'], {
    cwd: new URL('..', import.meta.url),
    timeout: 30_000,
  });
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as unknown;
  expect(result).toEqual({
    builtChildEntry: true,
    canonicalParity: true,
    changedAndDeleted: true,
    childExitCode: 0,
    childPid: expect.any(Number),
    heldReadJoined: true,
    ignorePrunedBeforeListing: true,
    nativeTruncation: true,
    nestedIgnoreNegation: true,
    pinnedRootSurvivedBorrow: true,
    rootIgnorePrunedBeforeListing: true,
    symlinkAndBinaryRefused: true,
    unchangedSurvivorNotRead: true,
    watchJoined: true,
  });
}, 35_000);
