import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const AUDIT_PATH = fileURLToPath(new URL('./audit-bolt-readiness.mjs', import.meta.url));

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function createFixtureRepo(root) {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'bolt-test@example.com']);
  git(repo, ['config', 'user.name', 'Bolt Test']);
  git(repo, ['remote', 'add', 'origin', 'git@github.com:seandearnaley/brainstrike.git']);
  writeFileSync(join(repo, 'fixture.txt'), 'fixture\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'fixture']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return repo;
}

function createFakeGh(root) {
  const binDirectory = join(root, 'bin');
  const ghPath = join(binDirectory, 'gh');
  mkdirSync(binDirectory);
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(process.env.FAKE_GH_PR_JSON);
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql') {
  process.stdout.write(JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
    },
  }));
  process.exit(0);
}
if (
  args[0] === 'api' &&
  args[1] === 'repos/seandearnaley/brainstrike/branches/main/protection/required_status_checks/contexts'
) {
  if (process.env.FAKE_GH_CONTEXTS === 'HTTP404') {
    process.stderr.write('gh: Branch not protected (HTTP 404)\\n');
    process.exit(1);
  }
  process.stdout.write(process.env.FAKE_GH_CONTEXTS);
  process.exit(0);
}
process.stderr.write(\`Unexpected gh invocation: \${args.join(' ')}\\n\`);
process.exit(2);
`
  );
  chmodSync(ghPath, 0o755);
  return binDirectory;
}

function pullRequestJson(head, originMain, statusCheckRollup) {
  return JSON.stringify({
    baseRefName: 'main',
    baseRefOid: originMain,
    headRefName: 'night-shift/bolt/fixture-optimization',
    headRefOid: head,
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    number: 42,
    state: 'OPEN',
    statusCheckRollup,
    title: 'perf: fixture',
    url: 'https://github.com/seandearnaley/brainstrike/pull/42',
  });
}

function runAudit(repo, binDirectory, environment, extraArguments = []) {
  const head = git(repo, ['rev-parse', 'HEAD']);
  return spawnSync(
    process.execPath,
    [AUDIT_PATH, '--repo', repo, '--pr', '42', '--head', head, ...extraArguments],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH}`, ...environment },
    }
  );
}

test('fails readiness when an expected required check is absent from the rollup', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bolt-audit-partial-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const repo = createFixtureRepo(root);
  const binDirectory = createFakeGh(root);
  const head = git(repo, ['rev-parse', 'HEAD']);

  const result = runAudit(repo, binDirectory, {
    FAKE_GH_CONTEXTS: JSON.stringify(['unit', 'e2e-web']),
    FAKE_GH_PR_JSON: pullRequestJson(head, head, [
      { conclusion: 'SUCCESS', name: 'unit', status: 'COMPLETED' },
    ]),
  });

  assert.equal(result.status, 2, result.stderr);
  const audit = JSON.parse(result.stdout);
  assert.equal(audit.mechanicalReady, false);
  assert.equal(audit.conditions.allExpectedChecksObserved, false);
  assert.deepEqual(audit.missingExpectedChecks, ['e2e-web']);
  assert.equal(audit.expectedChecksSource, 'branch-protection-api');
});

test('fails readiness when a check concluded SKIPPED or NEUTRAL', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bolt-audit-skipped-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const repo = createFixtureRepo(root);
  const binDirectory = createFakeGh(root);
  const head = git(repo, ['rev-parse', 'HEAD']);

  const result = runAudit(repo, binDirectory, {
    FAKE_GH_CONTEXTS: JSON.stringify(['unit', 'e2e-web']),
    FAKE_GH_PR_JSON: pullRequestJson(head, head, [
      { conclusion: 'SUCCESS', name: 'unit', status: 'COMPLETED' },
      { conclusion: 'SKIPPED', name: 'e2e-web', status: 'COMPLETED' },
    ]),
  });

  assert.equal(result.status, 2, result.stderr);
  const audit = JSON.parse(result.stdout);
  assert.equal(audit.mechanicalReady, false);
  assert.equal(audit.conditions.noSkippedOrNeutralChecks, false);
  assert.equal(audit.conditions.allObservedChecksTerminalGreen, false);
  assert.deepEqual(audit.skippedOrNeutralChecks, ['e2e-web']);
});

test('errors when branch protection is unavailable and --required-checks is missing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bolt-audit-no-source-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const repo = createFixtureRepo(root);
  const binDirectory = createFakeGh(root);
  const head = git(repo, ['rev-parse', 'HEAD']);

  const result = runAudit(repo, binDirectory, {
    FAKE_GH_CONTEXTS: 'HTTP404',
    FAKE_GH_PR_JSON: pullRequestJson(head, head, [
      { conclusion: 'SUCCESS', name: 'unit', status: 'COMPLETED' },
    ]),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--required-checks was not provided/);
});

test('passes with --required-checks when branch protection is unavailable and all checks are green', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bolt-audit-flag-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const repo = createFixtureRepo(root);
  const binDirectory = createFakeGh(root);
  const head = git(repo, ['rev-parse', 'HEAD']);

  const result = runAudit(
    repo,
    binDirectory,
    {
      FAKE_GH_CONTEXTS: 'HTTP404',
      FAKE_GH_PR_JSON: pullRequestJson(head, head, [
        { conclusion: 'SUCCESS', name: 'unit', status: 'COMPLETED' },
        { conclusion: 'SUCCESS', name: 'e2e-web', status: 'COMPLETED' },
      ]),
    },
    ['--required-checks', 'unit,e2e-web']
  );

  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(result.stdout);
  assert.equal(audit.mechanicalReady, true);
  assert.equal(audit.expectedChecksSource, '--required-checks');
  assert.deepEqual(audit.missingExpectedChecks, []);
});
