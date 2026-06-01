import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../run-env.mjs'
);

describe('run-env', () => {
  it('preserves empty environment assignments', () => {
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        'EMPTY_ENV_VALUE=',
        '--',
        process.execPath,
        '-e',
        "process.exit(Object.hasOwn(process.env, 'EMPTY_ENV_VALUE') && process.env.EMPTY_ENV_VALUE === '' ? 0 : 1)",
      ],
      { encoding: 'utf8' }
    );

    assert.equal(result.status, 0, result.stderr);
  });
});
