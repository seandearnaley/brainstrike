import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { requiresNativeWindows } from '../native-windows-impact.mjs';

test('native package changes require the Windows job while unrelated application source does not', () => {
  assert.equal(requiresNativeWindows(['packages/secure-fs-native/src/secure_fs.cc']), true);
  assert.equal(requiresNativeWindows(['apps/web/src/main.tsx']), false);
});

test('workspace install and Windows workflow changes require the Windows job', () => {
  for (const path of [
    '.nvmrc',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'packages/ui/package.json',
    '.github/actions/setup-workspace/action.yml',
    '.github/workflows/test.yml',
    'apps/desktop/scripts/chmod-pty-spawn-helper.mjs',
    'scripts/native-windows-impact.mjs',
    'scripts/postinstall.js',
  ]) {
    assert.equal(requiresNativeWindows([path]), true, path);
  }
});

test('malformed changed paths fail visibly instead of skipping Windows', () => {
  assert.throws(() => requiresNativeWindows(['../outside-workspace']), /repository-relative/);
  assert.throws(() => requiresNativeWindows(['']), /non-empty/);
});

test('the CLI classifies NUL-delimited git diff output', () => {
  const result = spawnSync(process.execPath, ['scripts/native-windows-impact.mjs'], {
    encoding: 'utf8',
    input: 'apps/web/src/main.tsx\0packages/windows-job-native/src/windows_job.cc\0',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'true\n');
});
