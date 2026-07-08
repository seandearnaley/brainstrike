import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSpawnInvocation, quoteWindowsShellArg } from '../spawn-command.mjs';

describe('spawn command helpers', () => {
  it('keeps POSIX command arguments separate', () => {
    assert.deepEqual(createSpawnInvocation('pnpm', ['exec', 'playwright test'], 'linux'), {
      args: ['exec', 'playwright test'],
      command: 'pnpm',
      shell: false,
    });
  });

  it('quotes Windows shell arguments that contain spaces', () => {
    assert.equal(
      quoteWindowsShellArg('--grep=Database Persistence'),
      '"--grep=Database Persistence"'
    );
    assert.deepEqual(
      createSpawnInvocation(
        'pnpm',
        ['exec', 'playwright', 'test', '--grep=Database Persistence'],
        'win32'
      ),
      {
        args: [],
        command: 'pnpm exec playwright test "--grep=Database Persistence"',
        shell: true,
      }
    );
  });

  it('quotes Windows shell arguments that contain cmd expansion markers', () => {
    assert.equal(quoteWindowsShellArg('%PATH%'), '"%PATH%"');
    assert.equal(quoteWindowsShellArg('value!'), '"value!"');
  });
});
