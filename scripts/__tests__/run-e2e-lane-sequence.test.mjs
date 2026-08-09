import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import {
  laneCommandArguments,
  laneSpawnInvocation,
  runE2eLaneSequence,
} from '../run-e2e-lane-sequence.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED_LANES = [
  'test:e2e:lane:broad-regression',
  'test:e2e:lane:assistant-state',
  'test:e2e:lane:settings-state',
  'test:e2e:lane:import-indexing',
  'test:e2e:lane:db-startup',
  'test:e2e:lane:file-explorer-persistence',
  'test:e2e:lane:collection-browser-state',
  'test:e2e:lane:clear-database',
  'test:e2e:lane:destructive-reset',
  'test:e2e:lane:indexing',
  'test:e2e:lane:production-csp',
];

test('MONEY TEST: one failed lane does not prevent every later lane from running', () => {
  const lanes = ['test:e2e:lane:broad', 'test:e2e:lane:middle', 'test:e2e:lane:tail'];
  const calls = [];
  const errors = [];
  const logs = [];
  const status = runE2eLaneSequence(lanes, {
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
    runLane: (lane) => {
      calls.push(lane);
      return { status: lane.endsWith(':broad') ? 7 : 0 };
    },
  });

  assert.equal(status, 1);
  assert.deepEqual(calls, lanes);
  assert.match(errors.join('\n'), /broad.*status 7/);
  assert.match(logs.join('\n'), /tail.*PASS/);
});

test('all successful lanes produce a zero aggregate status', () => {
  const status = runE2eLaneSequence(['test:e2e:lane:first', 'test:e2e:lane:second'], {
    log: () => {},
    logError: () => {},
    runLane: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
});

test('a spawn error is reported and later lanes still run', () => {
  const lanes = ['test:e2e:lane:broken', 'test:e2e:lane:later'];
  const calls = [];
  const errors = [];
  const status = runE2eLaneSequence(lanes, {
    log: () => {},
    logError: (message) => errors.push(message),
    runLane: (lane) => {
      calls.push(lane);
      return lane.endsWith(':broken') ? { error: new Error('spawn failed') } : { status: 0 };
    },
  });

  assert.equal(status, 1);
  assert.deepEqual(calls, lanes);
  assert.match(errors.join('\n'), /broken.*spawn failed/);
});

test('each lane gets an isolated Playwright output directory', () => {
  assert.deepEqual(laneCommandArguments('test:e2e:lane:assistant-state'), [
    'run',
    'test:e2e:lane:assistant-state',
    '--output=test-results/assistant-state',
  ]);
  assert.equal(
    new Set(EXPECTED_LANES.map((lane) => laneCommandArguments(lane).at(-1))).size,
    EXPECTED_LANES.length
  );
  assert.throws(
    () => laneCommandArguments('test:e2e:lane:../../escape'),
    /Invalid E2E lane script name/
  );
});

test('MONEY TEST: pnpm forwards the output flag without a literal delimiter', () => {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), 'e2e-lane-arguments-'));
  try {
    writeFileSync(
      path.join(tempDirectory, 'package.json'),
      JSON.stringify({ scripts: { 'test:e2e:lane:capture': 'node capture.mjs' } })
    );
    writeFileSync(
      path.join(tempDirectory, 'capture.mjs'),
      'console.log(JSON.stringify(process.argv.slice(2)));\n'
    );
    const invocation = laneSpawnInvocation('test:e2e:lane:capture');
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: tempDirectory,
      encoding: 'utf8',
      shell: invocation.shell,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\["--output=test-results\/capture"\]/);
  } finally {
    rmSync(tempDirectory, { force: true, recursive: true });
  }
});

test('Windows launches the trusted pnpm shim through the shared shell adapter', () => {
  assert.deepEqual(laneSpawnInvocation('test:e2e:lane:assistant-state', 'win32'), {
    args: [],
    command: 'pnpm run test:e2e:lane:assistant-state --output=test-results/assistant-state',
    shell: true,
  });
});

test('MONEY TEST: invoking the runner through a symlink fails loud instead of doing nothing', () => {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), 'e2e-lane-runner-'));
  try {
    const linkPath = path.join(tempDirectory, 'run-lanes.mjs');
    symlinkSync(path.join(REPO_ROOT, 'scripts/run-e2e-lane-sequence.mjs'), linkPath);
    const result = spawnSync(process.execPath, [linkPath, 'invalid-lane'], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid E2E lane script name: invalid-lane/);
  } finally {
    rmSync(tempDirectory, { force: true, recursive: true });
  }
});

test('the real web full-regression script delegates every lane to the aggregate runner', () => {
  const webPackage = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'apps/web/package.json'), 'utf8')
  );
  const command = webPackage.scripts['test:e2e:lane:full-regression'];

  assert.doesNotMatch(command, /&&/);
  assert.match(command, /^node \.\.\/\.\.\/scripts\/run-e2e-lane-sequence\.mjs /);
  assert.deepEqual(command.split(' ').slice(2), EXPECTED_LANES);
});

test('the nightly timeout covers every lane budget plus setup and build overhead', () => {
  const webPackage = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'apps/web/package.json'), 'utf8')
  );
  const laneBudgetMinutes = EXPECTED_LANES.reduce((total, lane) => {
    const match = /--global-timeout=(\d+)/.exec(webPackage.scripts[lane]);
    assert.ok(match, `${lane} must declare an explicit --global-timeout`);
    return total + Number(match[1]) / 60_000;
  }, 0);
  const workflow = parseYaml(
    readFileSync(path.join(REPO_ROOT, '.github/workflows/web-e2e.yml'), 'utf8')
  );
  const playwrightConfig = readFileSync(
    path.join(REPO_ROOT, 'apps/web/playwright.config.ts'),
    'utf8'
  );
  assert.match(playwrightConfig, /webServer:\s*\{[\s\S]*?timeout:\s*60_000/);
  const jobTimeoutMinutes = workflow.jobs['web-full-regression']['timeout-minutes'];
  const traceUpload = workflow.jobs['web-full-regression'].steps.find(
    (step) => step.name === 'Upload web traces'
  );
  assert.equal(traceUpload.with.path, 'apps/web/test-results/');
  const webServerStartupMinutes = EXPECTED_LANES.length;
  const setupAndBuildMinutes = 24;

  assert.ok(
    jobTimeoutMinutes >= laneBudgetMinutes + webServerStartupMinutes + setupAndBuildMinutes,
    `${jobTimeoutMinutes}m job timeout must cover ${laneBudgetMinutes}m of lane budgets, ` +
      `${webServerStartupMinutes}m of web-server starts, and ${setupAndBuildMinutes}m of setup/build`
  );
});
