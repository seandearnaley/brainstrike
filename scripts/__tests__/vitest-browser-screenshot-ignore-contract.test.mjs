import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function isIgnored(candidate) {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', candidate], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.ok(
    result.status === 0 || result.status === 1,
    `git check-ignore failed for ${candidate}: ${result.stderr}`
  );
  return result.status === 0;
}

test('Vitest browser failure screenshots are ignored across browser-mode packages', () => {
  for (const candidate of [
    'packages/assistant-ui/src/__tests__/__screenshots__/failure.png',
    'packages/ui/src/__tests__/__screenshots__/failure.png',
    'packages/db/__tests__/__screenshots__/failure.png',
    'packages/storage/src/__tests__/__screenshots__/failure.png',
  ]) {
    assert.equal(isIgnored(candidate), true, `expected ${candidate} to be ignored`);
  }
});

test('intentional screenshot documentation and baseline fixtures remain trackable', () => {
  for (const candidate of [
    'docs/screenshots/bst-1356/01-connect-cta.png',
    'packages/assistant-ui/src/__tests__/fixtures/intentional-baseline.png',
    'packages/assistant-ui/src/__tests__/__image_snapshots__/intentional-baseline.png',
  ]) {
    assert.equal(isIgnored(candidate), false, `expected ${candidate} to remain trackable`);
  }
});
