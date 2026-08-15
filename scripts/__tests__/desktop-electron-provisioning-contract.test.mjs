import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPaths = ['.github/workflows/test.yml', '.github/workflows/desktop-e2e.yml'];

function loadWorkflow(relativePath) {
  return parseYaml(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function allSteps(workflow) {
  return Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
}

test('desktop workflows do not cache an Electron location provisioning never populates', () => {
  for (const relativePath of workflowPaths) {
    const steps = allSteps(loadWorkflow(relativePath));
    assert.equal(
      steps.some(({ name }) => name === 'Get Electron version'),
      false,
      `${relativePath} still computes a key for the unused Electron cache`
    );
    assert.equal(
      steps.some(({ name }) => name === 'Cache Electron binaries'),
      false,
      `${relativePath} still caches ~/.cache/electron even though provisioning bypasses it`
    );
  }
});

test('all three provisioning steps use the container-safe runner temp fallback', () => {
  const provisioningSteps = workflowPaths.flatMap((relativePath) =>
    allSteps(loadWorkflow(relativePath))
      .filter(({ name }) => name === 'Provision Electron binary')
      .map((step) => ({ relativePath, run: step.run }))
  );

  assert.equal(
    provisioningSteps.length,
    3,
    'expected smoke plus two regression provisioning sites'
  );
  for (const { relativePath, run } of provisioningSteps) {
    assert.equal(typeof run, 'string', `${relativePath} provisioning must remain a shell step`);
    assert.match(run, /ELECTRON_ZIP="\$\{RUNNER_TEMP:-\/tmp\}\/electron\.zip"/);
    assert.match(run, /curl[^\n]+-o "\$ELECTRON_ZIP"/);
    assert.match(run, /unzip[^\n]+"\$ELECTRON_ZIP"/);
    assert.doesNotMatch(run, /\$\{RUNNER_TEMP\}\/electron\.zip/);
  }
});
