import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runE2eLaneSequence } from '../run-e2e-lane-sequence.mjs';

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
  const calls = [];
  const errors = [];
  const logs = [];
  const status = runE2eLaneSequence(['broad', 'middle', 'tail'], {
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
    runLane: (lane) => {
      calls.push(lane);
      return { status: lane === 'broad' ? 7 : 0 };
    },
  });

  assert.equal(status, 1);
  assert.deepEqual(calls, ['broad', 'middle', 'tail']);
  assert.match(errors.join('\n'), /broad.*status 7/);
  assert.match(logs.join('\n'), /tail.*PASS/);
});

test('all successful lanes produce a zero aggregate status', () => {
  const status = runE2eLaneSequence(['first', 'second'], {
    log: () => {},
    logError: () => {},
    runLane: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
});

test('a spawn error is reported and later lanes still run', () => {
  const calls = [];
  const errors = [];
  const status = runE2eLaneSequence(['broken', 'later'], {
    log: () => {},
    logError: (message) => errors.push(message),
    runLane: (lane) => {
      calls.push(lane);
      return lane === 'broken' ? { error: new Error('spawn failed') } : { status: 0 };
    },
  });

  assert.equal(status, 1);
  assert.deepEqual(calls, ['broken', 'later']);
  assert.match(errors.join('\n'), /broken.*spawn failed/);
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
  const workflow = readFileSync(path.join(REPO_ROOT, '.github/workflows/web-e2e.yml'), 'utf8');
  assert.match(workflow, /timeout-minutes: 150/);
});
