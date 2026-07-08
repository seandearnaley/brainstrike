import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getRequiredOutputPaths, shouldBuildDesktopDevDeps } from '../ensure-desktop-dev-deps.mjs';

test('resolves desktop dev dependency outputs from the repository root', () => {
  const repoRoot = path.join(tmpdir(), 'brainstrike-root');

  assert.deepEqual(getRequiredOutputPaths(repoRoot), [
    path.join(repoRoot, 'packages/build-utils/dist/index.mjs'),
    path.join(repoRoot, 'packages/agent/dist/index.mjs'),
    path.join(repoRoot, 'packages/ui/dist/index.d.ts'),
  ]);
});

test('does not rebuild when required outputs exist under the repository root', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'brainstrike-dev-deps-'));

  try {
    for (const outputPath of getRequiredOutputPaths(repoRoot)) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, '');
    }

    assert.equal(shouldBuildDesktopDevDeps(repoRoot), false);
  } finally {
    await rm(repoRoot, { force: true, recursive: true });
  }
});
