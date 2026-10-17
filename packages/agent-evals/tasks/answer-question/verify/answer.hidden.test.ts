import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const workspace = join(import.meta.dirname, '..');

test('answer.txt holds the default port alone', async () => {
  assert.equal((await readFile(join(workspace, 'answer.txt'), 'utf8')).trim(), '8417');
});

test('answer.txt is the only change to the workspace', () => {
  const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: workspace,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line && !line.includes('.verify/'));
  assert.deepEqual(changes, ['?? answer.txt']);
});
