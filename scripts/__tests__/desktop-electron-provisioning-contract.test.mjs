import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPaths = ['.github/workflows/test.yml', '.github/workflows/desktop-e2e.yml'];
const desktopSetupJobs = [
  { job: 'desktop-e2e', relativePath: '.github/workflows/test.yml', turboCache: 'false' },
  {
    job: 'desktop-full-regression',
    relativePath: '.github/workflows/desktop-e2e.yml',
    turboCache: 'true',
  },
  {
    job: 'desktop-embedding-e2e',
    relativePath: '.github/workflows/desktop-e2e.yml',
    turboCache: 'true',
  },
];

function loadWorkflow(relativePath) {
  return parseYaml(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function allSteps(workflow) {
  return Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
}

test('all desktop jobs use the shared workspace setup action', () => {
  for (const { job, relativePath, turboCache } of desktopSetupJobs) {
    const steps = loadWorkflow(relativePath).jobs[job]?.steps;
    assert.ok(Array.isArray(steps), `${relativePath} has no steps for ${job}`);
    const setupStep = steps.find(({ uses }) => uses === './.github/actions/setup-workspace');
    assert.ok(setupStep, `${relativePath} ${job} bypasses the shared workspace setup action`);
    assert.equal(setupStep.with?.['turbo-cache'] ?? 'false', turboCache);
    assert.equal(setupStep.with?.['electron-download-cache'], 'true');
  }
});

test('shared setup can route Electron install downloads to runner temp without changing other jobs', () => {
  const action = loadWorkflow('.github/actions/setup-workspace/action.yml');
  assert.equal(action.inputs?.['electron-download-cache']?.default, 'false');
  const installStep = action.runs?.steps?.find(({ run }) => run?.includes('pnpm install'));
  assert.equal(typeof installStep?.run, 'string');
  assert.match(installStep.run, /ELECTRON_CACHE_ROOT="\$\{RUNNER_TEMP:-\/tmp\}\/electron-cache"/);
  assert.match(installStep.run, /export electron_config_cache="\$ELECTRON_CACHE_ROOT"/);
});

test('desktop workflows do not cache an Electron location provisioning never populates', () => {
  for (const relativePath of workflowPaths) {
    const steps = allSteps(loadWorkflow(relativePath));
    assert.equal(
      steps.some(({ name }) => name === 'Get Electron version'),
      false,
      `${relativePath} still computes a key for the unused Electron cache`
    );
    const electronCacheSteps = steps.filter((step) => {
      if (!step.uses?.startsWith('actions/cache') || typeof step.with?.path !== 'string') {
        return false;
      }

      return step.with.path
        .split('\n')
        .some((cachePath) => cachePath.trim().includes('.cache/electron'));
    });

    assert.deepEqual(
      electronCacheSteps,
      [],
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
    assert.match(run, /ELECTRON_CACHE_ROOT="\$\{RUNNER_TEMP:-\/tmp\}\/electron-cache"/);
    assert.match(run, /find "\$ELECTRON_CACHE_ROOT"[^\n]+electron-v\$\{VER\}-linux-x64\.zip/);
    assert.match(run, /unzip[^\n]+"\$ELECTRON_ZIP"/);
    assert.doesNotMatch(run, /curl/);
    assert.doesNotMatch(run, /\$\{RUNNER_TEMP\}\/electron-cache/);
  }
});
