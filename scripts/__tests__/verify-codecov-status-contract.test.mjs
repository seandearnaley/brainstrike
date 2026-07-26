import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODECOV_CONFIG_PATHS,
  findGatingStatuses,
  verifyCodecovStatusContract,
} from '../verify-codecov-status-contract.mjs';

// Guard: no Codecov commit status may claim to be a merge gate, because the
// ruleset requires only Static, Unit, Build, Web E2E and Desktop E2E. A gating
// Codecov status cannot block anything — it only renders a red X and an
// UNSTABLE merge box, which is exactly the contradiction this replaced.
//
// Every "vacuous pass" case below is a REGRESSION TEST: the first version of
// this guard reported OK on all of them, which is the failure mode it was
// written to prevent. The false-positive cases matter just as much — this runs
// in the Static job, a required check, so a wrong red here blocks every merge.

async function writeConfig(yaml, relativePath = 'codecov.yml') {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'codecov-status-guard-'));
  const target = path.join(repoRoot, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, yaml, 'utf8');
  return repoRoot;
}

const yaml = (...lines) => lines.join('\n');

test('real tree: the repository has no gating Codecov statuses', () => {
  const { problems } = verifyCodecovStatusContract();
  assert.deepEqual(problems, [], problems.join('\n\n'));
});

test('accepts the shipped shape: project off, patch informational per context', async () => {
  const repoRoot = await writeConfig(
    yaml(
      'coverage:',
      '  status:',
      '    project: off',
      '    patch:',
      '      default:',
      '        informational: true',
      '        target: 70%'
    )
  );
  assert.deepEqual(verifyCodecovStatusContract(repoRoot).problems, []);
});

test('rejects a patch status that would fail builds', async () => {
  // The exact shape this repo shipped before the contradiction was settled.
  const repoRoot = await writeConfig(
    yaml(
      'coverage:',
      '  status:',
      '    project: off',
      '    patch:',
      '      default:',
      '        target: 70%',
      '        threshold: 0.5%'
    )
  );
  const { problems } = verifyCodecovStatusContract(repoRoot);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /patch\.default/);
  assert.match(problems[0], /informational: true/);
});

test('rejects a gating project status too, not just patch', async () => {
  const repoRoot = await writeConfig(
    yaml(
      'coverage:',
      '  status:',
      '    project:',
      '      default:',
      '        target: auto',
      '    patch:',
      '      default:',
      '        informational: true'
    )
  );
  const { problems } = verifyCodecovStatusContract(repoRoot);
  assert.match(problems[0], /project\.default/);
});

// ---------------------------------------------------------------------------
// Vacuous-pass regressions. Every one of these returned OK from v1.
// ---------------------------------------------------------------------------

test('REGRESSION: status-level `informational` does not wave through a gating context', async () => {
  // v1 treated `informational` at the status level as applying to every
  // context. Codecov reads `status.<type>` as a MAP OF CONTEXTS, so this is a
  // context named "informational" and `default` still gates. The shorthand was
  // an inferred rule with no doc behind it — in a PR about inferred CI claims.
  const repoRoot = await writeConfig(
    yaml(
      'coverage:',
      '  status:',
      '    patch:',
      '      informational: true',
      '      default:',
      '        target: 70%'
    )
  );
  const { problems } = verifyCodecovStatusContract(repoRoot);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /patch\.default/);
});

test('REGRESSION: settings written flat, with no `default:` wrapper', async () => {
  const repoRoot = await writeConfig(
    yaml('coverage:', '  status:', '    patch:', '      target: 70%', '      threshold: 0.5%')
  );
  const { problems } = verifyCodecovStatusContract(repoRoot);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /patch\.target/);
});

test('REGRESSION: a scalar context such as `default: true`', async () => {
  const repoRoot = await writeConfig(
    yaml('coverage:', '  status:', '    patch:', '      default: true')
  );
  const { problems } = verifyCodecovStatusContract(repoRoot);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /patch\.default/);
});

test('REGRESSION: an empty status mapping still gets Codecov defaults', async () => {
  const repoRoot = await writeConfig(yaml('coverage:', '  status:', '    patch: {}'));
  const { problems } = verifyCodecovStatusContract(repoRoot);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /empty mapping/);
});

test('REGRESSION: array shapes are surfaced, never silently accepted', () => {
  // `status: []` has nothing inspectable at all, so it throws. `patch: []` is a
  // status that exists but is not a context map, so it is reported as gating.
  // Either way it is surfaced — v1 returned zero problems for both.
  assert.throws(() => findGatingStatuses({ coverage: { status: [] } }), /no `coverage.status`/);

  const { gating } = findGatingStatuses({ coverage: { status: { patch: [] } } });
  assert.equal(gating.length, 1);
  assert.match(gating[0], /not a context map/);
});

test('does NOT pass vacuously when the status block is removed or empty', async () => {
  const removed = await writeConfig(yaml('coverage:', '  precision: 2'));
  assert.throws(() => verifyCodecovStatusContract(removed), /no `coverage.status`/);
  assert.throws(() => findGatingStatuses({ coverage: { status: {} } }), /no `coverage.status`/);
});

// ---------------------------------------------------------------------------
// False positives. These would fail the REQUIRED Static check on a valid file.
// ---------------------------------------------------------------------------

test('FALSE POSITIVE: `off` in any capitalisation is disabled, not gating', async () => {
  // `yaml` v2 uses the YAML 1.2 core schema: bare `off` is the STRING 'off', so
  // v1's `=== false` check never fired and `Off`/`OFF` were reported as gating.
  for (const off of ['off', 'Off', 'OFF']) {
    const repoRoot = await writeConfig(
      yaml(
        'coverage:',
        '  status:',
        `    project: ${off}`,
        '    patch:',
        '      default:',
        '        informational: true'
      )
    );
    assert.deepEqual(
      verifyCodecovStatusContract(repoRoot).problems,
      [],
      `\`project: ${off}\` should be treated as disabled`
    );
  }
});

test('FALSE POSITIVE: a non-status key is reported, never fatal', async () => {
  // v1 threw on any unrecognised key. `coverage.status` legitimately carries
  // configuration alongside the three status types, and only
  // project/patch/changes produce a commit status — so an unknown key cannot
  // gate, and failing on it would block merges on a valid config.
  const repoRoot = await writeConfig(
    yaml(
      'coverage:',
      '  status:',
      '    default_rules:',
      '      flag_coverage_not_uploaded_behavior: exclude',
      '    patch:',
      '      default:',
      '        informational: true'
    )
  );
  const { ignored, problems } = verifyCodecovStatusContract(repoRoot);
  assert.deepEqual(problems, []);
  assert.deepEqual(ignored, ['default_rules']);
});

// ---------------------------------------------------------------------------
// Config discovery.
// ---------------------------------------------------------------------------

test('finds a config in .github/ and dev/, not just the root', async () => {
  for (const location of ['.github/codecov.yml', 'dev/codecov.yml', '.codecov.yml']) {
    const repoRoot = await writeConfig(
      yaml('coverage:', '  status:', '    patch:', '      default:', '        target: 70%'),
      location
    );
    const { problems } = verifyCodecovStatusContract(repoRoot);
    assert.equal(problems.length, 1, `gating config at ${location} should still be caught`);
  }
});

test('fails on TWO configs, because which one wins is undocumented', async () => {
  const repoRoot = await writeConfig(yaml('coverage:', '  status:', '    patch: off'));
  await mkdir(path.join(repoRoot, '.github'), { recursive: true });
  await writeFile(
    path.join(repoRoot, '.github/codecov.yml'),
    yaml('coverage:', '  status:', '    patch:', '      default:', '        target: 70%'),
    'utf8'
  );
  assert.throws(() => verifyCodecovStatusContract(repoRoot), /multiple Codecov configs/);
});

test('fails loudly when no config exists anywhere', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'codecov-status-guard-missing-'));
  assert.throws(() => verifyCodecovStatusContract(repoRoot), /no Codecov config found/);
  assert.ok(CODECOV_CONFIG_PATHS.includes('codecov.yml'));
});
