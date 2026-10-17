/**
 * BST-1715: every Linux lane that runs apt must first drop the runner image's
 * unused Google Chrome apt source — and must NOT do so by relaxing apt.
 *
 * WHY THIS GUARD EXISTS. `apt-get update` exits non-zero when ANY configured
 * repository's index fails verification, even when every other repository
 * updated fine. On 2026-09-09 Google's CDN served a `Release` manifest
 * inconsistent with `Packages.gz` on some edges:
 *
 *     E: Failed to fetch https://dl.google.com/linux/chrome-stable/deb/dists/stable/main/binary-amd64/Packages.gz
 *        Hash Sum mismatch
 *
 * Ten checks on one PR died in system-dependency install steps without running
 * a single test, across four run attempts. Every package those steps install
 * comes from Ubuntu's archives; the repository that broke belongs to Google and
 * nothing here installs from it.
 *
 * Two halves have to hold together, and each fails differently:
 *
 *   1. Every apt site is preceded, IN THE SAME JOB, by the guard step. Miss one
 *      and that lane stays a coin flip on Google's CDN — silently, because a
 *      green run proves nothing about an intermittent, edge-dependent index.
 *      This is asserted by SCANNING every workflow rather than against a list
 *      of today's sites, so a NEW apt step added tomorrow fails here instead of
 *      quietly reopening the hole.
 *   2. No workflow relaxes apt's exit status (`apt-get update || true`, an
 *      `APT::Update::Error-Mode` override, `-o Acquire::AllowInsecure`...).
 *      That would also swallow a genuine failure to reach Ubuntu's archives and
 *      turn a clear provisioning error into a baffling install error several
 *      steps later — the AGENTS.md no-silent-fallbacks rule applied to CI. The
 *      fix narrows the exposure; it must never widen the tolerance.
 *
 * Per the BST-836 discipline every assertion is control-tested against a
 * mutated copy of the source: a guard never observed failing is not evidence.
 */
import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const actionDir = path.join(repoRoot, '.github', 'actions', 'apt-drop-unused-sources');
const actionPath = path.join(actionDir, 'action.yml');
const scriptPath = path.join(actionDir, 'drop-unused-sources.sh');

const GUARD_USES = './.github/actions/apt-drop-unused-sources';

/**
 * Workflow files that contain a Linux apt site today. Listed so the scan below
 * cannot go dark by reading zero files, NOT as the definition of where the
 * guard is required — that is derived from the steps themselves.
 */
const WORKFLOWS_WITH_APT_SITES = ['test.yml', 'desktop-e2e.yml', 'local-desktop-e2e.yml'];

/** The floor that keeps the detector honest: today's six apt steps. */
const KNOWN_APT_STEP_COUNT = 6;

/**
 * A step that reaches apt. `playwright install-deps` counts: it shells out to
 * `apt-get update` internally, which is exactly how the Desktop E2E lanes died.
 */
const APT_STEP = /\bapt-get\b|\bplaywright\s+install-deps\b/;

/** Ways to make apt stop reporting a failed index. All of them are forbidden. */
const APT_RELAXATIONS = [
  /apt-get[^\n]*\|\|\s*(true|:)/,
  /APT::Update::Error-Mode/,
  /Acquire::AllowInsecureRepositories/,
  /apt-get[^\n]*--allow-unauthenticated/,
];

/**
 * Full-line comments are prose, not behaviour — this file's own explanation of
 * why `apt-get update || true` is forbidden must not read as an instance of it.
 * Stripped from both YAML and the shell inside `run:` blocks, which share `#`.
 */
function withoutComments(source) {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

function readWorkflow(file) {
  return readFileSync(path.join(workflowsDir, file), 'utf8');
}

function workflowSources() {
  return new Map(WORKFLOWS_WITH_APT_SITES.map((file) => [file, readWorkflow(file)]));
}

function stepUsesGuard(step) {
  return typeof step?.uses === 'string' && step.uses.trim() === GUARD_USES;
}

/** Every (file, job, step) whose `run` reaches apt, with its position. */
function aptSteps(sources) {
  const found = [];
  for (const [file, source] of sources) {
    const jobs = parseYaml(source)?.jobs ?? {};
    for (const [jobName, job] of Object.entries(jobs)) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      steps.forEach((step, index) => {
        if (APT_STEP.test(step?.run ?? '')) {
          found.push({ file, index, jobName, name: step?.name ?? `step ${index}`, steps });
        }
      });
    }
  }
  return found;
}

function assertEveryAptSiteIsGuarded(sources = workflowSources()) {
  const sites = aptSteps(sources);
  assert.ok(
    sites.length >= KNOWN_APT_STEP_COUNT,
    `expected at least ${KNOWN_APT_STEP_COUNT} apt steps across ${WORKFLOWS_WITH_APT_SITES.join(', ')}, found ${sites.length}; if apt sites really were removed, lower the floor deliberately rather than letting this detector go dark`
  );
  for (const site of sites) {
    const guarded = site.steps.slice(0, site.index).some(stepUsesGuard);
    assert.ok(
      guarded,
      `${site.file} job "${site.jobName}" step "${site.name}" runs apt with no earlier \`uses: ${GUARD_USES}\` step in the same job; one unused third-party source with a bad index then fails this lane before a single test runs`
    );
  }
}

function assertAptFailuresAreNotSwallowed(sources = workflowSources()) {
  for (const [file, source] of sources) {
    for (const relaxation of APT_RELAXATIONS) {
      assert.doesNotMatch(
        withoutComments(source),
        relaxation,
        `${file} relaxes apt's exit status (${relaxation}); that also swallows a genuine failure to reach Ubuntu's archives. Drop the unused source instead — narrow the exposure, never widen the tolerance`
      );
    }
  }
}

function assertGuardActionIsLinuxOnlyAndRunsTheScript(source = readFileSync(actionPath, 'utf8')) {
  const action = parseYaml(source);
  assert.equal(action?.runs?.using, 'composite', 'the guard must be a composite action');
  const steps = Array.isArray(action?.runs?.steps) ? action.runs.steps : [];
  const runner = steps.find((step) => (step?.run ?? '').includes('drop-unused-sources.sh'));
  assert.ok(runner, 'the guard action must run drop-unused-sources.sh');
  // The script is addressed through the action's own directory, never a
  // workspace-relative path: that breaks the moment a caller's working
  // directory is not the repo root. And it must be the GITHUB_ACTION_PATH
  // ENVIRONMENT VARIABLE, not the `github.action_path` CONTEXT. In a
  // `container:` job the context still holds the host path
  // (/home/runner/work/...), which the container does not mount, while the
  // runner translates the variable to the container mount (/__w/...)
  // (actions/runner#716). The context form failed Web E2E and Performance E2E
  // with exit 127 on their first nightly (run 39029252932). Do not revert it.
  assert.equal(
    runner.run.trim(),
    '"$GITHUB_ACTION_PATH/drop-unused-sources.sh"',
    'the script must be addressed as "$GITHUB_ACTION_PATH/drop-unused-sources.sh"; a workspace-relative path breaks outside the repo root'
  );
  assert.doesNotMatch(
    source,
    /\$\{\{\s*github\.action_path\s*\}\}/,
    'the `github.action_path` context resolves to the host path in container jobs (actions/runner#716); use the GITHUB_ACTION_PATH environment variable'
  );
  assert.match(
    String(runner.if ?? ''),
    /runner\.os\s*==\s*'Linux'/,
    'the guard is an apt concept and the script exits non-zero without apt-get; gate it on Linux rather than discovering that on the first non-Linux caller'
  );
}

function assertScriptDropsTheSourceAndProvesIt(source = readFileSync(scriptPath, 'utf8')) {
  assert.match(source, /set -euo pipefail/, 'the guard script must fail loudly itself');
  assert.match(
    source,
    /\/etc\/apt\/sources\.list\.d\/google-chrome\*/,
    'the guard must remove the runner image Google Chrome source drop-in'
  );
  assert.match(
    source,
    /grep -RIl/,
    'removing files by name is a pattern, not a result: the script must assert no configured source still points at the dropped host'
  );
  assert.match(
    source,
    /dl\.google\.com/,
    'the leftover assertion must name the host whose index broke the lanes'
  );
  for (const relaxation of APT_RELAXATIONS) {
    assert.doesNotMatch(
      withoutComments(source),
      relaxation,
      `the guard script must not relax apt (${relaxation})`
    );
  }
}

test('every apt site in CI drops the unused Google Chrome source first', () => {
  assertEveryAptSiteIsGuarded();
});

test('control: an apt site with the guard removed fails the contract', () => {
  const sources = workflowSources();
  const mutated = sources
    .get('test.yml')
    .replace(
      / {6}- name: Drop unused apt sources\n {8}uses: \.\/\.github\/actions\/apt-drop-unused-sources\n\n/,
      ''
    );
  assert.notEqual(mutated, sources.get('test.yml'), 'mutation did not remove a guard step');
  sources.set('test.yml', mutated);
  assert.throws(
    () => assertEveryAptSiteIsGuarded(sources),
    /runs apt with no earlier/,
    'the contract must fail when a single apt site loses its guard'
  );
});

test('control: the detector cannot pass by finding no apt steps at all', () => {
  const sources = new Map([['test.yml', 'jobs:\n  nothing:\n    steps: []\n']]);
  assert.throws(
    () => assertEveryAptSiteIsGuarded(sources),
    /detector go dark/,
    'a scan that finds nothing must fail rather than vacuously pass'
  );
});

test('no workflow swallows an apt failure', () => {
  assertAptFailuresAreNotSwallowed();
});

test('control: `apt-get update || true` fails the no-swallow contract', () => {
  const sources = new Map([['test.yml', 'run: |\n  sudo apt-get update || true\n']]);
  assert.throws(
    () => assertAptFailuresAreNotSwallowed(sources),
    /relaxes apt's exit status/,
    'blanket-ignoring apt must be rejected, not merely discouraged in a comment'
  );
});

test('the guard action is Linux-gated and runs the script from its own path', () => {
  assertGuardActionIsLinuxOnlyAndRunsTheScript();
});

test('control: an ungated guard action fails the contract', () => {
  const source = readFileSync(actionPath, 'utf8').replace(/^\s*- if: .*\n/m, '    - \n');
  assert.throws(
    () => assertGuardActionIsLinuxOnlyAndRunsTheScript(source),
    /gate it on Linux/,
    'losing the Linux gate must be caught'
  );
});

const GUARD_RUN_LINE = `run: '"$GITHUB_ACTION_PATH/drop-unused-sources.sh"'`;

function withGuardRunLine(replacement) {
  const original = readFileSync(actionPath, 'utf8');
  const source = original.replace(GUARD_RUN_LINE, replacement);
  assert.notEqual(source, original, 'control mutation matched no guard run line');
  return source;
}

test('control: the host-path `github.action_path` context fails the contract', () => {
  const source = withGuardRunLine(`run: ${'$'}{{ github.action_path }}/drop-unused-sources.sh`);
  assert.throws(
    () => assertGuardActionIsLinuxOnlyAndRunsTheScript(source),
    /GITHUB_ACTION_PATH/,
    'restoring the context form that breaks container jobs must be caught'
  );
});

test('control: a workspace-relative script path fails the contract', () => {
  const source = withGuardRunLine(
    'run: ./.github/actions/apt-drop-unused-sources/drop-unused-sources.sh'
  );
  assert.throws(
    () => assertGuardActionIsLinuxOnlyAndRunsTheScript(source),
    /workspace-relative path/,
    'a path that depends on the caller working directory must be caught'
  );
});

test('the guard script removes the source and asserts the result', () => {
  assertScriptDropsTheSourceAndProvesIt();
});

test('control: a script that removes files without asserting the result fails', () => {
  const source = readFileSync(scriptPath, 'utf8').replace(/grep -RIl/g, 'grep -RI');
  assert.throws(
    () => assertScriptDropsTheSourceAndProvesIt(source),
    /must assert no configured source/,
    'a name-shaped removal with no result assertion must be caught'
  );
});

test('the guard script is executable', { skip: process.platform === 'win32' }, () => {
  // `run: <path>/drop-unused-sources.sh` executes the file directly, so a lost
  // exec bit is a red lane on every Linux job at once.
  assert.doesNotThrow(
    () => accessSync(scriptPath, constants.X_OK),
    'drop-unused-sources.sh must be committed with the executable bit set'
  );
});
