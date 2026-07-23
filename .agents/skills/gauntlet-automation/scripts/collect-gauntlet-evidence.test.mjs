import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./collect-gauntlet-evidence.mjs', import.meta.url));

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o755 });
}

function createFixture(t) {
  const root = mkdtempSync(join(os.tmpdir(), 'gauntlet-collector-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  mkdirSync(join(repo, '.night-shift'), { recursive: true });
  mkdirSync(join(repo, 'packages/agent/src/__tests__'), { recursive: true });
  mkdirSync(join(repo, 'packages/agent/src/evaluation'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(repo, '.night-shift/PROTOCOL.md'), 'protocol\n');
  writeFileSync(
    join(repo, 'packages/agent/src/__tests__/agent-behavior-eval.spec.ts'),
    "it('first behavior', () => {});\nit(\"second behavior\", () => {});\nconst flow = { name: 'spec-flow' };\n"
  );
  writeFileSync(
    join(repo, 'packages/agent/src/evaluation/agent-behavior-eval-runner.ts'),
    "const flows = [{ name: 'runner-flow' }, { name: 'control-flow' }];\n"
  );
  git(root, ['init', '--initial-branch=main', 'repo']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'watermark']);
  const watermark = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(
    join(repo, 'packages/agent/src/evaluation/agent-behavior-eval-runner.ts'),
    "const flows = [{ name: 'runner-flow' }, { name: 'control-flow' }, { name: 'new-flow' }];\n"
  );
  mkdirSync(join(repo, 'decoy'), { recursive: true });
  writeFileSync(join(repo, 'decoy/ignored.txt'), 'not assistant territory\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'assistant change and decoy']);
  writeExecutable(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.FAKE_GH_FAIL === '1') { process.stderr.write('GitHub unavailable'); process.exit(1); }
if (args[0] === 'pr' && args[1] === 'list') {
  if (process.env.FAKE_GH_LIMIT === '1') { process.stdout.write(JSON.stringify(Array.from({ length: 200 }, (_, index) => ({ number: index + 1, title: 'PR', mergedAt: '2026-01-01T00:00:00Z' })))); process.exit(0); }
  process.stdout.write(process.env.FAKE_GH_PRS || '[]'); process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view' && args[3] === '--json' && args[4] === 'files') {
  const files = JSON.parse(process.env.FAKE_GH_FILES || '{}');
  process.stdout.write(JSON.stringify({ files: files[args[2]] || [] })); process.exit(0);
}
process.stderr.write('unexpected gh arguments: ' + args.join(' ')); process.exit(92);
`
  );
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return { bin, repo, watermark };
}

function run(fixture, environment = {}, watermark = fixture.watermark, revision = 'HEAD') {
  return spawnSync(
    process.execPath,
    [script, '--repo', fixture.repo, '--watermark', watermark, '--revision', revision],
    {
      encoding: 'utf8',
      env: { ...process.env, ...environment, PATH: `${fixture.bin}:${process.env.PATH}` },
    }
  );
}

const pullRequests = JSON.stringify([
  { mergedAt: '2026-01-02T00:00:00Z', number: 7, title: 'assistant fix' },
  { mergedAt: '2026-01-03T00:00:00Z', number: 8, title: 'unrelated fix' },
]);
const pullRequestFiles = JSON.stringify({
  7: [{ path: 'packages/agent/src/tool.ts' }],
  8: [{ path: 'docs/readme.md' }],
});

test('collects the eval inventory, assistant delta, and matching merged PRs', (t) => {
  const fixture = createFixture(t);
  const result = run(fixture, { FAKE_GH_FILES: pullRequestFiles, FAKE_GH_PRS: pullRequests });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.evalSuite.specTitles, ['first behavior', 'second behavior']);
  assert.deepEqual(output.evalSuite.flowNames, [
    'control-flow',
    'new-flow',
    'runner-flow',
    'spec-flow',
  ]);
  assert.deepEqual(output.assistantDelta, [
    { path: 'packages/agent/src/evaluation/agent-behavior-eval-runner.ts', status: 'M' },
  ]);
  assert.deepEqual(output.mergedAssistantPrs, [
    { mergedAt: '2026-01-02T00:00:00Z', number: 7, title: 'assistant fix' },
  ]);
});

test('produces a stable suite hash for unchanged revision contents', (t) => {
  const fixture = createFixture(t);
  const environment = { FAKE_GH_FILES: pullRequestFiles, FAKE_GH_PRS: pullRequests };
  const first = run(fixture, environment);
  const second = run(fixture, environment);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(
    JSON.parse(first.stdout).evalSuite.suiteHash,
    JSON.parse(second.stdout).evalSuite.suiteHash
  );
});

test('fails visibly when the eval spec is absent at the selected revision', (t) => {
  const fixture = createFixture(t);
  rmSync(join(fixture.repo, 'packages/agent/src/__tests__/agent-behavior-eval.spec.ts'));
  git(fixture.repo, ['add', '-u']);
  git(fixture.repo, ['commit', '-m', 'remove spec']);
  const result = run(fixture, {}, fixture.watermark, 'HEAD');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /agent-behavior-eval\.spec\.ts/);
});

test('rejects a watermark that is not an ancestor of the revision', (t) => {
  const fixture = createFixture(t);
  git(fixture.repo, ['checkout', '--orphan', 'unrelated']);
  git(fixture.repo, ['rm', '-rf', '.']);
  writeFileSync(join(fixture.repo, 'unrelated.txt'), 'unrelated\n');
  git(fixture.repo, ['add', '.']);
  git(fixture.repo, ['commit', '-m', 'unrelated root']);
  const unrelated = git(fixture.repo, ['rev-parse', 'HEAD']);
  git(fixture.repo, ['checkout', 'main']);
  const result = run(fixture, {}, unrelated, 'HEAD');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not an ancestor/);
});

test('fails closed when GitHub queries fail', (t) => {
  const result = run(createFixture(t), { FAKE_GH_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^collect-gauntlet-evidence: gh /m);
});

test('fails closed when the merged PR listing hits its limit', (t) => {
  const result = run(createFixture(t), { FAKE_GH_LIMIT: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /200-result limit/);
});
