import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPaths = [
  '.github/workflows/test.yml',
  '.github/workflows/desktop-e2e.yml',
  '.github/workflows/mcp-verification.yml',
];
// mcp-verification.yml is deliberately included: its provisioning steps must
// also never reintroduce the unused ~/.cache/electron cache location.
const electronCacheConfigPaths = [...workflowPaths, '.github/actions/setup-workspace/action.yml'];
const desktopSetupJobs = [
  { job: 'desktop-e2e-smoke', relativePath: '.github/workflows/test.yml', turboCache: 'false' },
  {
    job: 'desktop-e2e-delegated',
    relativePath: '.github/workflows/test.yml',
    turboCache: 'false',
  },
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

function allSteps(configuration) {
  if (Array.isArray(configuration.runs?.steps)) {
    return configuration.runs.steps;
  }
  if (typeof configuration.jobs === 'object' && configuration.jobs !== null) {
    return Object.values(configuration.jobs).flatMap((job) => job.steps ?? []);
  }
  throw new TypeError('Expected a GitHub workflow or composite action.');
}

test('all desktop jobs use the shared workspace setup action', () => {
  for (const { job, relativePath, turboCache } of desktopSetupJobs) {
    const steps = loadWorkflow(relativePath).jobs[job]?.steps;
    assert.ok(Array.isArray(steps), `${relativePath} has no steps for ${job}`);
    const setupStep = steps.find(({ uses }) => uses === './.github/actions/setup-workspace');
    assert.ok(setupStep, `${relativePath} ${job} bypasses the shared workspace setup action`);
    assert.equal(setupStep.with?.['turbo-cache'] ?? 'false', turboCache);
    assert.equal('electron-download-cache' in (setupStep.with ?? {}), false);
  }
});

test('Electron has no install lifecycle for shared setup to use as provisioning', () => {
  const electronManifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'apps/desktop/node_modules/electron/package.json'), 'utf8')
  );
  assert.equal(electronManifest.scripts, undefined);
  assert.equal(electronManifest.bin?.['install-electron'], 'install.js');

  const action = loadWorkflow('.github/actions/setup-workspace/action.yml');
  assert.equal(action.inputs?.['electron-download-cache'], undefined);
});

test('desktop workflows and their shared action do not cache the unused Electron location', () => {
  for (const relativePath of electronCacheConfigPaths) {
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

test('every provisioning step uses the container-safe runner temp fallback', () => {
  const provisioningSteps = workflowPaths.flatMap((relativePath) =>
    allSteps(loadWorkflow(relativePath))
      .filter(({ name }) => name === 'Provision Electron binary')
      .map((step) => ({ relativePath, run: step.run }))
  );

  assert.equal(
    provisioningSteps.length,
    8,
    'expected native packaging, two smoke lanes, two regression, and three official-conformance provisioning sites'
  );
  for (const { relativePath, run } of provisioningSteps) {
    assert.equal(typeof run, 'string', `${relativePath} provisioning must remain a shell step`);
    assert.match(run, /ELECTRON_ZIP="\$\{RUNNER_TEMP:-\/tmp\}\/electron\.zip"/);
    assert.match(run, /electron\/releases\/download\/v\$\{VER\}/);
    assert.match(run, /curl[^\n]+-o "\$ELECTRON_ZIP"/);
    assert.match(run, /unzip[^\n]+"\$ELECTRON_ZIP"/);
    assert.doesNotMatch(run, /\$\{RUNNER_TEMP\}\/electron\.zip/);
  }
});

test('native packaging provisions one retrying Electron archive and reuses it', () => {
  const steps = loadWorkflow('.github/workflows/test.yml').jobs['native-electron']?.steps;
  assert.ok(Array.isArray(steps), 'test.yml has no steps for native-electron');

  const provisionIndex = steps.findIndex(({ name }) => name === 'Provision Electron binary');
  const nativeTestIndex = steps.findIndex(
    ({ name }) => name === 'Load the native capability in Electron'
  );
  const packageIndex = steps.findIndex(({ name }) => name === 'Package the desktop application');
  assert.ok(provisionIndex > -1, 'native-electron has no explicit Electron provisioning step');
  assert.ok(
    provisionIndex < nativeTestIndex,
    'Electron must be provisioned before the native smoke'
  );
  assert.ok(provisionIndex < packageIndex, 'Electron must be provisioned before packaging');

  const provisionRun = steps[provisionIndex].run;
  assert.equal(typeof provisionRun, 'string');
  assert.match(provisionRun, /ELECTRON_ZIP="\$\{RUNNER_TEMP:-\/tmp\}\/electron\.zip"/);
  assert.match(
    provisionRun,
    /curl[^\n]+--connect-timeout 20[^\n]+--max-time 180[^\n]+--retry 3[^\n]+--retry-all-errors[^\n]+"\$URL"/
  );
  assert.match(provisionRun, /unzip[^\n]+"\$ELECTRON_ZIP"/);
  assert.match(provisionRun, /fs\.constants\.X_OK/);
  assert.match(provisionRun, /statSync\(p\)\.size===0/);
  assert.match(provisionRun, /ELECTRON_DIST=\$ELECTRON_ZIP/);

  const packageRun = steps[packageIndex].run;
  assert.equal(typeof packageRun, 'string');
  assert.match(packageRun, /set -euo pipefail/);
  assert.match(packageRun, /test -n "\$\{ELECTRON_DIST:-\}"/);
  assert.match(packageRun, /--config\.electronDist="\$ELECTRON_DIST"/);
});
