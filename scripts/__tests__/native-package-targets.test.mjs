import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { selectNativePackageTargets } from '../native-package-targets.mjs';

const actions = (body) => `${'$'}{{ ${body} }}`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/native-package-targets.mjs');

test('the scheduled/default package proof preserves every existing release target', () => {
  assert.deepEqual(selectNativePackageTargets().include, [
    { arch: 'arm64', desktopSmoke: true, os: 'macos-15', platform: 'darwin' },
    { arch: 'x64', desktopSmoke: false, os: 'macos-15-intel', platform: 'darwin' },
    { arch: 'x64', desktopSmoke: false, os: 'ubuntu-24.04', platform: 'linux' },
    { arch: 'arm64', desktopSmoke: false, os: 'ubuntu-24.04-arm', platform: 'linux' },
    { arch: 'x64', desktopSmoke: false, os: 'windows-2025', platform: 'win32' },
  ]);
});

test('manual Linux and Windows proof selects only the requested real platform', () => {
  assert.deepEqual(
    selectNativePackageTargets('linux').include.map((target) => target.os),
    ['ubuntu-24.04', 'ubuntu-24.04-arm']
  );
  assert.deepEqual(selectNativePackageTargets('windows').include, [
    { arch: 'x64', desktopSmoke: false, os: 'windows-2025', platform: 'win32' },
  ]);
  assert.throws(() => selectNativePackageTargets('darwin'), /Unsupported native package platform/);
});

test('the CLI emits a complete matrix output and rejects an invalid selector before emitting output', () => {
  const output = execFileSync(process.execPath, [script, 'windows'], { encoding: 'utf8' });
  assert.deepEqual(
    JSON.parse(output.trim().slice('matrix='.length)),
    selectNativePackageTargets('windows')
  );
  const invalid = spawnSync(process.execPath, [script, 'arbitrary-runner'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, '');
});

test('the workflow uses the selector for its actual matrix and keeps full scheduled proof', () => {
  const workflow = parse(
    readFileSync(path.join(root, '.github/workflows/native-package-matrix.yml'), 'utf8')
  );
  assert.equal(workflow.on.workflow_dispatch.inputs.platform.default, 'all');
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.platform.options, [
    'all',
    'linux',
    'windows',
  ]);
  assert.equal(workflow.jobs.smoke.needs, 'select-targets');
  assert.equal(
    workflow.jobs.smoke.strategy.matrix,
    actions('fromJSON(needs.select-targets.outputs.matrix)')
  );
  assert.equal(workflow.jobs.smoke.strategy['fail-fast'], false);
  assert.equal(workflow.jobs.smoke['timeout-minutes'], 45);
  const selection = workflow.jobs['select-targets'].steps.find((step) => step.id === 'select');
  assert.equal(selection.env.TARGET_PLATFORM, actions("inputs.platform || 'all'"));
  assert.match(selection.run, /node scripts\/native-package-targets\.mjs "\$TARGET_PLATFORM"/);
  // BST-2233: the scheduled nightly.yml calls this workflow with no platform,
  // so `inputs.platform` is empty and the night covers every target.
  assert.equal(workflow.on.schedule, undefined);
  assert.equal(workflow.on.workflow_call?.inputs?.platform, undefined);
  const nightly = parse(readFileSync(path.join(root, '.github/workflows/nightly.yml'), 'utf8'));
  const calls = Object.values(nightly.jobs).filter(
    (job) => job.uses === './.github/workflows/native-package-matrix.yml'
  );
  assert.equal(calls.length, 1, 'nightly.yml calls the matrix once');
  assert.equal(calls[0].with, undefined, 'the nightly call passes no platform');
  assert.ok(nightly.on.schedule, 'nightly.yml runs on a schedule');
});
