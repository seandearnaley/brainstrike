import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../forbid-no-memo.mjs', import.meta.url));

async function withWorkspace(run) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-no-memo-'));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

test('allows normal React source without a compiler escape directive', async () => {
  await withWorkspace(async (workspace) => {
    const sourcePath = path.join(workspace, 'packages', 'example', 'src', 'component.tsx');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, 'export const Component = () => null;\n');

    const result = spawnSync(process.execPath, [scriptPath], { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No forbidden React compiler escape directives found/);
  });
});

test('runs when invoked through a symlink', async () => {
  await withWorkspace(async (workspace) => {
    const symlinkPath = path.join(workspace, 'forbid-no-memo-link.mjs');
    await symlink(scriptPath, symlinkPath);

    const result = spawnSync(process.execPath, [symlinkPath], {
      cwd: workspace,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No forbidden React compiler escape directives found/);
  });
});

test('fails closed on the forbidden use no memo directive', async () => {
  await withWorkspace(async (workspace) => {
    const sourcePath = path.join(workspace, 'apps', 'web', 'src', 'component.tsx');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "'use no memo';\nexport const Component = () => null;\n");

    const result = spawnSync(process.execPath, [scriptPath], { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Forbidden React compiler escape directive found/);
    assert.match(result.stderr, /apps\/web\/src\/component\.tsx:1/);
  });
});
