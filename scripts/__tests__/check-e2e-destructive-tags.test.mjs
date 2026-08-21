import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../check-e2e-destructive-tags.mjs', import.meta.url));

async function withWorkspace(run) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-e2e-destructive-tags-'));
  try {
    await writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
    await run(workspace);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

async function writeE2eTest(workspace, source) {
  const testPath = path.join(workspace, 'apps', 'web', 'e2e', 'factory-reset.test.ts');
  await mkdir(path.dirname(testPath), { recursive: true });
  await mkdir(path.join(workspace, 'apps', 'desktop', 'e2e'), { recursive: true });
  await writeFile(testPath, source);
}

test('allows a factory-reset flow explicitly marked @destructive', async () => {
  await withWorkspace(async (workspace) => {
    await writeE2eTest(
      workspace,
      "test('@destructive Factory Reset clears local state', async () => {});\n"
    );

    const result = spawnSync(process.execPath, [scriptPath], { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /E2E destructive tag check passed/);
  });
});

test('runs when invoked through a symlink', async () => {
  await withWorkspace(async (workspace) => {
    const symlinkPath = path.join(workspace, 'check-e2e-destructive-tags-link.mjs');
    await mkdir(path.join(workspace, 'apps', 'web', 'e2e'), { recursive: true });
    await mkdir(path.join(workspace, 'apps', 'desktop', 'e2e'), { recursive: true });
    await symlink(scriptPath, symlinkPath);

    const result = spawnSync(process.execPath, [symlinkPath], {
      cwd: workspace,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /E2E destructive tag check passed/);
  });
});

test('fails closed when a factory-reset flow is outside an @destructive title range', async () => {
  await withWorkspace(async (workspace) => {
    await writeE2eTest(workspace, "test('Factory Reset clears local state', async () => {});\n");

    const result = spawnSync(process.execPath, [scriptPath], { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /E2E destructive tag check failed/);
    assert.match(result.stderr, /factory-reset\.test\.ts:1: matched factory reset UI text/);
  });
});
