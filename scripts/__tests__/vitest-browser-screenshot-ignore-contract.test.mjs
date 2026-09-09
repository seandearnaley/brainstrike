import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
    `git check-ignore failed for ${candidate}: ${result.error?.message ?? result.stderr}`
  );
  return result.status === 0;
}

test('Vitest browser failure screenshots are ignored across browser-mode packages', () => {
  for (const candidate of [
    'packages/assistant-ui/.vitest/attachments/failure-screenshots/failure.png',
    'packages/ui/.vitest/attachments/failure-screenshots/failure.png',
    'packages/db/.vitest/attachments/failure-screenshots/failure.png',
    'packages/storage/.vitest/attachments/failure-screenshots/failure.png',
    'packages/config/.vitest/attachments/failure-screenshots/failure.png',
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

test('every package browser project reroutes intentional baselines', () => {
  const contract = readFileSync(path.join(repoRoot, 'docs/agents/ci-quality.md'), 'utf8');
  assert.match(
    contract,
    /generated failure captures.*`\.vitest\/attachments\/failure-screenshots`.*intentional `toMatchScreenshot` references.*`__image_snapshots__`/is
  );

  const sharedConfig = readFileSync(
    path.join(repoRoot, 'packages/config/src/vitest-browser.ts'),
    'utf8'
  );
  assert.match(
    sharedConfig,
    /expect:\s*\{\s*toMatchScreenshot:\s*\{\s*resolveScreenshotPath: resolveVisualBaselinePath/s
  );

  for (const configPath of [
    'packages/db/vitest.config.mts',
    'packages/storage/vitest.config.mts',
  ]) {
    const config = readFileSync(path.join(repoRoot, configPath), 'utf8');
    assert.match(
      config,
      /expect:\s*\{\s*toMatchScreenshot:\s*\{\s*resolveScreenshotPath: resolveVisualBaselinePath/s,
      `expected ${configPath} to reroute intentional baselines`
    );
  }
});
