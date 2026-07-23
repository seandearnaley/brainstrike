import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./collect-vigil-advisories.mjs', import.meta.url));

function command(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o755 });
}

function createFixture(t) {
  const root = mkdtempSync(join(os.tmpdir(), 'vigil-collector-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  mkdirSync(join(repo, '.night-shift'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(repo, '.night-shift/PROTOCOL.md'), 'protocol\n');
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  command(root, ['init', '--initial-branch=main', 'repo']);
  command(repo, ['config', 'user.email', 'test@example.com']);
  command(repo, ['config', 'user.name', 'Test']);
  command(repo, ['add', '.']);
  command(repo, ['commit', '-m', 'fixture']);
  writeExecutable(
    join(bin, 'pnpm'),
    `#!/usr/bin/env node
const advisory = { github_advisory_id: 'GHSA-aaaa-bbbb-cccc', module_name: 'fixture-pkg', severity: 'high', vulnerable_versions: '< 2.0.0', patched_versions: '>= 2.0.0', findings: [{ version: '1.0.0', paths: ['fixture-pkg@1.0.0'] }] };
if (process.argv[2] !== 'audit' || process.argv[3] !== '--json') process.exit(91);
if (process.env.FAKE_PNPM_MODE === 'garbage') { process.stdout.write('not json'); process.stderr.write('audit failed'); process.exit(1); }
if (process.env.FAKE_PNPM_MODE === 'clean') { process.stdout.write(JSON.stringify({ advisories: {} })); process.exit(0); }
process.stdout.write(JSON.stringify({ advisories: { fixture: advisory } })); process.exit(1);
`
  );
  writeExecutable(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.FAKE_GH_FAIL === '1') { process.stderr.write('GitHub unavailable'); process.exit(1); }
if (args.join(' ') === 'repo view --json nameWithOwner') { process.stdout.write(JSON.stringify({ nameWithOwner: 'owner/repo' })); process.exit(0); }
if (args[0] === 'api' && args[1] === '--paginate' && args[2] === '--slurp' && args[3] === 'repos/owner/repo/dependabot/alerts') { process.stdout.write(process.env.FAKE_GH_ALERTS || '[]'); process.exit(0); }
process.stderr.write('unexpected gh arguments: ' + args.join(' ')); process.exit(92);
`
  );
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return { bin, repo };
}

function alert(id = 'GHSA-aaaa-bbbb-cccc', name = 'fixture-pkg') {
  return [
    {
      dependency: { manifest_path: '/pnpm-lock.yaml', package: { name } },
      security_advisory: { ghsa_id: id, severity: 'high' },
      state: 'open',
    },
  ];
}

function run(fixture, environment = {}) {
  return spawnSync(process.execPath, [script, '--repo', fixture.repo, '--revision', 'HEAD'], {
    encoding: 'utf8',
    env: { ...process.env, ...environment, PATH: `${fixture.bin}:${process.env.PATH}` },
  });
}

test('merges pnpm and Dependabot advisories by GHSA and package', (t) => {
  const fixture = createFixture(t);
  const result = run(fixture, {
    FAKE_GH_ALERTS: JSON.stringify([alert()]),
    FAKE_PNPM_MODE: 'vulns',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.counts, { dependabot: 1, merged: 1, pnpmAudit: 1 });
  assert.deepEqual(output.advisories[0].sources, ['dependabot', 'pnpm-audit']);
  assert.equal(output.advisories[0].fingerprint, 'vigil:advisory:GHSA-aaaa-bbbb-cccc:fixture-pkg');
});

test('retains pnpm-only and Dependabot-only advisories', (t) => {
  const fixture = createFixture(t);
  const pnpmOnly = run(fixture, { FAKE_GH_ALERTS: '[]', FAKE_PNPM_MODE: 'vulns' });
  assert.equal(pnpmOnly.status, 0, pnpmOnly.stderr);
  assert.deepEqual(JSON.parse(pnpmOnly.stdout).advisories[0].sources, ['pnpm-audit']);
  const dependabotOnly = run(fixture, {
    FAKE_GH_ALERTS: JSON.stringify([alert('GHSA-dddd-eeee-ffff', 'other-pkg')]),
    FAKE_PNPM_MODE: 'clean',
  });
  assert.equal(dependabotOnly.status, 0, dependabotOnly.stderr);
  assert.deepEqual(JSON.parse(dependabotOnly.stdout).advisories[0].sources, ['dependabot']);
});

test('uses a stable empty-set marker hash distinct from populated sets', (t) => {
  const fixture = createFixture(t);
  const empty = run(fixture, { FAKE_GH_ALERTS: '[]', FAKE_PNPM_MODE: 'clean' });
  const populated = run(fixture, { FAKE_GH_ALERTS: '[]', FAKE_PNPM_MODE: 'vulns' });
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(populated.status, 0, populated.stderr);
  assert.equal(
    JSON.parse(empty.stdout).watchedSetHash,
    createHash('sha256').update('empty').digest('hex')
  );
  assert.notEqual(
    JSON.parse(empty.stdout).watchedSetHash,
    JSON.parse(populated.stdout).watchedSetHash
  );
});

test('fails closed if Dependabot cannot be collected', (t) => {
  const result = run(createFixture(t), { FAKE_GH_FAIL: '1', FAKE_PNPM_MODE: 'vulns' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^collect-vigil-advisories: gh /m);
  assert.equal(result.stdout, '');
});

test('fails closed on an audit failure without JSON', (t) => {
  const result = run(createFixture(t), { FAKE_PNPM_MODE: 'garbage' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^collect-vigil-advisories:/m);
});

test('requires the lockfile at the work-tree root', (t) => {
  const fixture = createFixture(t);
  rmSync(join(fixture.repo, 'pnpm-lock.yaml'));
  const result = run(fixture, { FAKE_PNPM_MODE: 'clean' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pnpm-lock\.yaml/);
});
