import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

test('a read-only task leaves the workspace exactly as committed', () => {
  const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: join(import.meta.dirname, '..'),
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line && !line.includes('.verify/'));
  assert.deepEqual(changes, []);
});
