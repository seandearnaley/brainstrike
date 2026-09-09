/**
 * Contract for the retried `pnpm install` in setup-workspace (BST-1712).
 *
 * BST-1375 cached node-gyp's header dir so the Native Windows lane stops
 * downloading `node-vX-headers.tar.gz` on every run. That fixes the WARM path
 * and says so in its own comment: "a cold cache still downloads twice and keeps
 * today's exposure". Run 34353973428 was a cold run — `Cache not found for
 * input keys` — and it died exactly there: both native packages GET the tarball
 * 0.9s apart, both get HTTP 200, and 240s later one body is aborted in undici's
 * `client-h2.js`. Cold caches are not rare: every Node patch bump changes the
 * key, and the repo's cache storage runs at its ceiling, so entries get evicted.
 *
 * node-gyp's own undici `RetryHandler` is IN that stack trace, so the attempt
 * has to be restarted from outside node-gyp. The download happens inside the
 * composite's `pnpm install` (pnpm runs both packages' `install` lifecycle
 * scripts), and node-gyp is not on disk before that step — so the install step
 * is the only seam there is.
 *
 * The dangerous failure mode of ANY retry is that it converts a real failure
 * into a green run. A regex over the YAML cannot see that. So the assertions
 * below EXECUTE the composite's actual `run:` script against a stubbed `pnpm`
 * and check true exit codes and true attempt counts. Every one has a CONTROL
 * that breaks the mechanism and requires the check to fail.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const readWorkflow = () =>
  parseYaml(readFileSync(path.join(repoRoot, '.github/workflows/test.yml'), 'utf8'));

const readComposite = () =>
  parseYaml(
    readFileSync(path.join(repoRoot, '.github/actions/setup-workspace/action.yml'), 'utf8')
  );

/** @returns the composite step that runs `pnpm install` */
function installStep(composite) {
  const step = (composite?.runs?.steps ?? []).find(
    (candidate) => typeof candidate.run === 'string' && candidate.run.includes('pnpm install')
  );
  assert.ok(step, 'setup-workspace must still have a step that runs `pnpm install`');
  return step;
}

/**
 * Runs the composite's real `run:` script with `pnpm` and `sleep` stubbed.
 *
 * @returns {{ status: number, attempts: number, stdout: string, stderr: string }}
 */
function runInstallScript({ script, attempts, failFirst }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bst1712-'));
  try {
    const counter = path.join(dir, 'attempts');
    writeFileSync(counter, '0');
    // The stub records every invocation and fails the first `failFirst` of
    // them with exit 1 — pnpm's `[ELIFECYCLE] Command failed with exit code 1`.
    const pnpm = path.join(dir, 'pnpm');
    writeFileSync(
      pnpm,
      [
        '#!/usr/bin/env bash',
        `n=$(cat "${counter}")`,
        'n=$((n + 1))',
        `echo "$n" > "${counter}"`,
        `if [ "$n" -le "${failFirst}" ]; then`,
        '  echo "[ELIFECYCLE] Command failed with exit code 1." >&2',
        '  exit 1',
        'fi',
        'exit 0',
      ].join('\n')
    );
    chmodSync(pnpm, 0o755);
    // Stubbed so the loop's backoff does not make this test sleep for real.
    const sleep = path.join(dir, 'sleep');
    writeFileSync(sleep, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(sleep, 0o755);

    let status = 0;
    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync('bash', ['-eo', 'pipefail', '-c', script], {
        encoding: 'utf8',
        env: { ...process.env, INSTALL_ATTEMPTS: attempts, PATH: `${dir}:${process.env.PATH}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      status = error.status ?? -1;
      stdout = String(error.stdout ?? '');
      stderr = String(error.stderr ?? '');
    }
    return { attempts: Number(readFileSync(counter, 'utf8')), status, stderr, stdout };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test('the composite defaults to a single attempt, so no existing caller changes', () => {
  const composite = readComposite();
  assert.equal(
    composite?.inputs?.['install-attempts']?.default,
    '1',
    'the default must be 1: coverage.yml, web-e2e.yml and the other callers must keep exactly one attempt'
  );
  const script = installStep(composite).run;
  const result = runInstallScript({ attempts: '1', failFirst: 1, script });
  assert.equal(result.status, 1, 'with one attempt a failed install must still fail the step');
  assert.equal(result.attempts, 1, 'with one attempt `pnpm install` must run exactly once');
});

test('MONEY TEST: a retried install cannot swallow a persistent failure', () => {
  const script = installStep(readComposite()).run;
  const result = runInstallScript({ attempts: '3', failFirst: 99, script });
  assert.equal(
    result.status,
    1,
    'an install that fails every attempt must exit non-zero — a retry that greens a real failure is worse than the flake'
  );
  assert.equal(result.attempts, 3, 'the loop must stop at install-attempts, not run forever');
});

test('the retry actually fires: a first-attempt failure recovers', () => {
  const script = installStep(readComposite()).run;
  const result = runInstallScript({ attempts: '3', failFirst: 1, script });
  assert.equal(result.status, 0, 'a transient first-attempt failure must be recovered, not fatal');
  assert.equal(result.attempts, 2, 'recovery must take exactly the attempts it needed, no more');
  assert.match(
    result.stdout + result.stderr,
    /::warning/,
    'a retried attempt must be announced, or the flake becomes invisible and stops being tracked'
  );
});

test('a successful first attempt costs nothing extra', () => {
  const script = installStep(readComposite()).run;
  const result = runInstallScript({ attempts: '3', failFirst: 0, script });
  assert.equal(result.status, 0);
  assert.equal(result.attempts, 1, 'a healthy run must not pay for the retry');
});

test('a non-numeric or zero attempt count is rejected, never coerced', () => {
  const script = installStep(readComposite()).run;
  for (const bad of ['0', 'three', '', '-1']) {
    const result = runInstallScript({ attempts: bad, failFirst: 0, script });
    assert.equal(result.status, 1, `install-attempts '${bad}' must fail loudly`);
    assert.equal(result.attempts, 0, `install-attempts '${bad}' must not reach pnpm at all`);
  }
});

test('the attempt count reaches bash as data, not as shell source', () => {
  const step = installStep(readComposite());
  assert.match(
    String(step.env?.INSTALL_ATTEMPTS ?? ''),
    /\$\{\{\s*inputs\.install-attempts\s*\}\}/,
    'the input must be read through `env:`'
  );
  assert.ok(
    !String(step.run).includes('${{'),
    'the script body must not interpolate any GitHub expression directly'
  );
});

test('the Native Windows lane opts into the retry', () => {
  const workflow = readWorkflow();
  const job = workflow?.jobs?.['native-windows'];
  assert.ok(job, 'test.yml must define the native-windows job');
  const setup = (job.steps ?? []).find(
    (step) => typeof step.uses === 'string' && step.uses.includes('setup-workspace')
  );
  assert.ok(setup, 'the native-windows job must still use the setup-workspace action');
  const configured = Number(setup.with?.['install-attempts']);
  assert.ok(
    configured >= 2,
    'the lane whose cold-cache header download aborts mid-body must ask for more than one attempt'
  );
  // A retry the job timeout kills is not a retry. The aborted download burned
  // 240s of dead wait on top of an install that was already ~5m in.
  assert.ok(
    Number(job['timeout-minutes']) >= 30,
    'the retry needs headroom: keep the native-windows timeout at or above 30 minutes'
  );
});

test('CONTROL: a loop that ignores the install exit code FAILS the money test', () => {
  const script = `
    attempt=1
    while [ "$attempt" -le "$INSTALL_ATTEMPTS" ]; do
      pnpm install --frozen-lockfile || true
      attempt=$((attempt + 1))
    done
    exit 0
  `;
  const result = runInstallScript({ attempts: '3', failFirst: 99, script });
  assert.equal(result.status, 0, 'sanity: this deliberately broken loop does swallow the failure');
  assert.throws(
    () => assert.equal(result.status, 1),
    'the money test above must be able to catch a swallowing loop'
  );
});

test('CONTROL: a script with no loop FAILS the retry-fires test', () => {
  const script = 'pnpm install --frozen-lockfile';
  const result = runInstallScript({ attempts: '3', failFirst: 1, script });
  assert.equal(result.status, 1, 'sanity: without a loop a first-attempt failure is fatal');
  assert.equal(result.attempts, 1, 'sanity: without a loop pnpm runs once');
});

test('CONTROL: dropping the opt-in FAILS the native-windows contract', () => {
  const workflow = structuredClone(readWorkflow());
  const setup = workflow.jobs['native-windows'].steps.find(
    (step) => typeof step.uses === 'string' && step.uses.includes('setup-workspace')
  );
  setup.with = undefined;
  const configured = Number(setup.with?.['install-attempts']);
  assert.ok(
    !(configured >= 2),
    'a lane that silently drops back to one attempt must not satisfy the contract'
  );
});
