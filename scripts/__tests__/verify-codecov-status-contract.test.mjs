import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODECOV_CONFIG_PATH,
  findGatingStatuses,
  verifyCodecovStatusContract,
} from '../verify-codecov-status-contract.mjs';

// Guard: no Codecov commit status may claim to be a merge gate, because the
// ruleset requires only Static, Unit, Build, Web E2E and Desktop E2E. A gating
// Codecov status cannot block anything — it only renders a red X and an
// UNSTABLE merge box, which is exactly the contradiction this replaced.

test('real tree: the repository has no gating Codecov statuses', () => {
  const problems = verifyCodecovStatusContract();
  assert.deepEqual(problems, [], problems.join('\n\n'));
});

async function writeConfig(yaml) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'codecov-status-guard-'));
  await writeFile(path.join(repoRoot, CODECOV_CONFIG_PATH), yaml, 'utf8');
  return repoRoot;
}

test('accepts an informational patch status', async () => {
  const repoRoot = await writeConfig(
    [
      'coverage:',
      '  status:',
      '    project: off',
      '    patch:',
      '      default:',
      '        informational: true',
      '        target: 70%',
    ].join('\n')
  );
  assert.deepEqual(verifyCodecovStatusContract(repoRoot), []);
});

test('accepts informational declared once for the whole status', async () => {
  const repoRoot = await writeConfig(
    [
      'coverage:',
      '  status:',
      '    patch:',
      '      informational: true',
      '      default:',
      '        target: 70%',
    ].join('\n')
  );
  assert.deepEqual(verifyCodecovStatusContract(repoRoot), []);
});

test('rejects a patch status that would fail builds', async () => {
  // The exact shape this repo shipped before the contradiction was settled.
  const repoRoot = await writeConfig(
    [
      'coverage:',
      '  status:',
      '    project: off',
      '    patch:',
      '      default:',
      '        target: 70%',
      '        threshold: 0.5%',
    ].join('\n')
  );
  const problems = verifyCodecovStatusContract(repoRoot);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /patch\.default/);
  assert.match(problems[0], /informational: true/);
});

test('rejects a gating project status too, not just patch', async () => {
  const repoRoot = await writeConfig(
    [
      'coverage:',
      '  status:',
      '    project:',
      '      default:',
      '        target: auto',
      '    patch:',
      '      default:',
      '        informational: true',
    ].join('\n')
  );
  const problems = verifyCodecovStatusContract(repoRoot);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /project\.default/);
});

test('treats `off` and `false` as disabled rather than gating', async () => {
  const repoRoot = await writeConfig(
    ['coverage:', '  status:', '    project: off', '    patch: false'].join('\n')
  );
  assert.deepEqual(verifyCodecovStatusContract(repoRoot), []);
});

test('reports an unrecognised status key instead of skipping it', async () => {
  // A new Codecov status type must be an explicit decision — silently ignoring
  // an unknown key is how a gating status would sneak back in.
  const repoRoot = await writeConfig(
    [
      'coverage:',
      '  status:',
      '    patch:',
      '      default:',
      '        informational: true',
      '    somethingNew:',
      '      default:',
      '        target: 90%',
    ].join('\n')
  );
  const problems = verifyCodecovStatusContract(repoRoot);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /somethingNew/);
});

test('does NOT pass vacuously when the status block is removed', async () => {
  // The failure mode every guard in this repo is written against: finding zero
  // violations because there is nothing left to check.
  const repoRoot = await writeConfig(['coverage:', '  precision: 2'].join('\n'));
  assert.throws(() => verifyCodecovStatusContract(repoRoot), /no `coverage.status` block/);
});

test('fails loudly when codecov.yml is missing entirely', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'codecov-status-guard-missing-'));
  assert.throws(() => verifyCodecovStatusContract(repoRoot), /could not be read/);
});

test('findGatingStatuses throws rather than returning empty on a malformed config', () => {
  assert.throws(() => findGatingStatuses({}), /no `coverage.status` block/);
  assert.throws(() => findGatingStatuses({ coverage: {} }), /no `coverage.status` block/);
});
