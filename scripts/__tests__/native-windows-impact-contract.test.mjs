import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync('.github/workflows/test.yml', 'utf8');

function jobBlock(jobId) {
  const startPattern = new RegExp(`^  ${jobId}:\\s*$`, 'm');
  const start = workflow.search(startPattern);
  assert.notEqual(start, -1, `Expected test.yml to define the "${jobId}" job.`);

  const remainder = workflow.slice(start + 1);
  const nextJob = remainder.search(/^ {2}[a-z][a-z0-9-]*:\s*$/m);
  return nextJob === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + nextJob);
}

test('Native Windows allocates only after a cheap fail-visible impact classification', () => {
  const impact = jobBlock('native-windows-impact');
  assert.match(impact, /^ {4}runs-on: ubuntu-slim$/m);
  assert.match(impact, /^ {4}needs: \[admission\]$/m);
  assert.match(impact, /^ {6}required: \$\{\{ steps\.impact\.outputs\.required \}\}$/m);
  assert.match(impact, /git diff --name-only -z/);
  assert.match(impact, /node scripts\/native-windows-impact\.mjs/);

  const windows = jobBlock('native-windows');
  assert.match(windows, /^ {4}needs: \[admission, native-windows-impact\]$/m);
  assert.match(windows, /always\(\)/);
  assert.match(windows, /needs\.native-windows-impact\.result != 'success'/);
  assert.match(windows, /needs\.native-windows-impact\.outputs\.required == 'true'/);
});
