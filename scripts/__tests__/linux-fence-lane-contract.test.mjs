/**
 * BST-1071 follow-up: the Unit lane must actually be able to RUN the real-OS-
 * fence suites on Linux, and must fail loudly if it ever stops being able to.
 *
 * WHY THIS GUARD EXISTS. `packages/agent`'s three real-fence suites
 * (`fence-executor`, `run-python-tool`, `fence-escape-resistance`) gate
 * themselves on `SandboxManager.checkDependenciesAsync()`, which on Linux
 * requires `bwrap`, `socat` and `rg`. No workflow installed any of them, so
 * every Linux CI run printed
 *
 *     SUITE SKIPPED — sandbox-runtime dependencies are missing on this linux
 *     host: ripgrep (rg) not found, bubblewrap (bwrap) not installed, socat
 *     not installed
 *
 * and stayed GREEN — while `docs/agents/code-execution.md` and
 * `fence-escape-resistance.README.md` both required an srt bump to be
 * re-greened on macOS AND Linux. The Linux half was unobtainable, and nothing
 * said so: the only assertion that ran there was the ungated version pin.
 *
 * Three things have to hold together, and each fails differently:
 *
 *   1. The job INSTALLS the three binaries, through the shared
 *      `.github/actions/linux-desktop-test-host` action (BST-2127). Drop this
 *      and the suites go back to skipping — except that (2) now turns that
 *      into a red lane.
 *   2. The integration steps set `BRAINSTRIKE_FENCE_DEPS_REQUIRED=1`, which
 *      the shared host gate reads to escalate a missing dependency from a skip
 *      into a collection failure. Drop this and (1)'s removal becomes silent
 *      again.
 *   3. turbo.jsonc lists that variable on `test:integration`. Turbo runs tasks
 *      in Strict env mode, so a variable missing from the task's `env` /
 *      `passThroughEnv` never reaches vitest — the workflow would set it, the
 *      guard would never see it, and the lane would be quietly back to square
 *      one. This is the failure mode no amount of YAML review catches.
 *
 * The job also lifts `kernel.apparmor_restrict_unprivileged_userns`. That is
 * not tidying: on the Ubicloud image (Ubuntu 24.04) bubblewrap installs and
 * satisfies the dependency check but still cannot build a sandbox
 * ("bwrap: setting up uid map: Permission denied"), so every fenced run fails
 * before executing a line. Asserted here so it cannot be dropped as noise.
 *
 * Per the BST-836 discipline every assertion is control-tested against a
 * mutated copy of the source: a guard never observed failing is not evidence.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'test.yml');
const hostActionPath = path.join(
  repoRoot,
  '.github',
  'actions',
  'linux-desktop-test-host',
  'action.yml'
);
const HOST_USES = './.github/actions/linux-desktop-test-host';
const turboPath = path.join(repoRoot, 'turbo.jsonc');
const agentTests = path.join(repoRoot, 'packages', 'agent', 'src', '__tests__');
const gatePath = path.join(agentTests, 'fixtures', 'fence-host-gate.ts');
const FENCE_SPECS = [
  path.join(agentTests, 'fence-executor.integration.spec.ts'),
  path.join(agentTests, 'run-python-tool.integration.spec.ts'),
  path.join(agentTests, 'fence-escape-resistance.integration.spec.ts'),
];

const REQUIRED_ENV = 'BRAINSTRIKE_FENCE_DEPS_REQUIRED';
const REQUIRED_BINARIES = ['bubblewrap', 'socat', 'ripgrep'];

function workflowSource() {
  return readFileSync(workflowPath, 'utf8');
}

function hostActionSource() {
  return readFileSync(hostActionPath, 'utf8');
}

function unitShardSteps(source) {
  const workflow = parseYaml(source);
  const steps = workflow?.jobs?.['unit-shard']?.steps;
  assert.ok(Array.isArray(steps), 'test.yml must define the unit-shard job with steps');
  return steps;
}

/** The steps that actually execute the uncached env-sensitive lane. */
function integrationSteps(source) {
  const steps = unitShardSteps(source).filter((step) =>
    /\bpnpm\s+turbo\s+run\s+test:integration\b/.test(step.run ?? '')
  );
  assert.equal(
    steps.length,
    2,
    'expected exactly the pull-request and push `test:integration` steps in unit-shard'
  );
  return steps;
}

/**
 * The install step every Unit shard runs: unit-shard must call the shared host
 * action unconditionally, and that action carries the install.
 */
function installStep(source, actionSource) {
  const host = unitShardSteps(source).find((step) => step.uses === HOST_USES);
  assert.ok(
    host,
    `unit-shard must provision its host through ${HOST_USES}; without it no fence dependency is installed`
  );
  assert.equal(host.if, undefined, 'every Unit shard must provision the host');
  const steps = parseYaml(actionSource)?.runs?.steps;
  assert.ok(Array.isArray(steps), `${HOST_USES} must be a composite action with steps`);
  return steps.find((step) =>
    REQUIRED_BINARIES.every((binary) => (step.run ?? '').includes(binary))
  );
}

function assertFenceDependenciesInstalled(
  source = workflowSource(),
  actionSource = hostActionSource()
) {
  const step = installStep(source, actionSource);
  assert.ok(
    step,
    `unit-shard must install ${REQUIRED_BINARIES.join(', ')}; without them srt's dependency check fails and every real-fence suite skips itself green`
  );
  assert.match(
    step.run,
    /apt-get install\b/,
    'the fence dependencies must come from a real install step'
  );
}

function assertUnprivilegedUsernsIsUnlocked(
  source = workflowSource(),
  actionSource = hostActionSource()
) {
  const step = installStep(source, actionSource);
  assert.ok(step, 'no fence dependency install step to check');
  assert.match(
    step.run,
    /kernel\.apparmor_restrict_unprivileged_userns=0/,
    'bubblewrap cannot create a user namespace on the Ubuntu 24.04 runner image without this; the suites would run and fail rather than skip'
  );
}

/**
 * The interpreter is a prerequisite exactly like the three binaries: all three
 * suites skip themselves without it. Asserting it in the install step turns a
 * future runner image that drops python3 into a provisioning failure that names
 * itself, rather than leaving it to the runtime gate.
 */
function assertInterpreterIsAsserted(source = workflowSource(), actionSource = hostActionSource()) {
  const step = installStep(source, actionSource);
  assert.ok(step, 'no fence dependency install step to check');
  assert.match(
    step.run,
    /python3 --version/,
    'the fence suites need an interpreter; assert it where it can be named rather than discovering it as a skipped security suite'
  );
}

/**
 * Every suite-wide skip must escalate in a promised lane, not only the srt
 * dependency one.
 *
 * Raised in review of this PR: the gate originally threw inside
 * `describeFenceHostSkipReason`, which sees ONLY the dependency check. The
 * suites then apply their own prerequisites — an interpreter on PATH, and
 * unsandboxed reachability of the probe host, the latter skipping
 * `fence-executor` and `run-python-tool` in their entirety — so a lane could
 * still report green having proven nothing. The escalation therefore has to sit
 * at the point that sees the COMPLETE reason.
 */
function assertEveryFinalSkipEscalates(
  gateSource = readFileSync(gatePath, 'utf8'),
  specSources = FENCE_SPECS.map((spec) => readFileSync(spec, 'utf8'))
) {
  const hostGate = gateSource.match(
    /export async function describeFenceHostSkipReason[\s\S]*?\n}\n/
  );
  assert.ok(hostGate, 'fence-host-gate must still export describeFenceHostSkipReason');
  assert.doesNotMatch(
    hostGate[0],
    /throw new Error/,
    'describeFenceHostSkipReason must NOT escalate on its own — it sees only the dependency check, so throwing there leaves the interpreter and reachability skips able to report a green lane'
  );
  assert.match(
    gateSource,
    /export function refuseToSkipInAPromisedLane/,
    'the shared choke point that escalates a COMPLETE skip reason must exist'
  );

  for (const [index, spec] of specSources.entries()) {
    const name = path.basename(FENCE_SPECS[index]);
    // Every module-scope skip decision the suite acts on has to pass through
    // the choke point. Both of the escape-resistance gates count: dropping the
    // network cases silently is the same broken promise as dropping the suite.
    const decisions = [...spec.matchAll(/^const \w*[sS]kipReason\w* =\s*([\s\S]*?);$/gm)];
    assert.ok(decisions.length > 0, `${name}: found no module-scope skip decision to check`);
    for (const decision of decisions) {
      assert.match(
        decision[1],
        /refuseToSkipInAPromisedLane\(|hostSkipReason \?\?[\s\S]*refuseToSkipInAPromisedLane\(/,
        `${name}: this skip decision bypasses refuseToSkipInAPromisedLane, so a promised lane could skip it and still report green`
      );
    }
  }
}

function assertIntegrationStepsRequireTheDependencies(source = workflowSource()) {
  for (const step of integrationSteps(source)) {
    assert.equal(
      step.env?.[REQUIRED_ENV],
      '1',
      `${step.name} must set ${REQUIRED_ENV}=1 so a missing fence dependency fails this lane instead of silently skipping the security suites`
    );
  }
}

/** Minimal JSONC reader: strips comments and trailing commas, string-aware. */
function stripJsonc(source) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    const next = source[index + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        index += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      index += 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      out = out.replace(/,\s*$/, '');
    }
    out += ch;
  }
  return out;
}

function assertTurboForwardsTheRequirement(source = readFileSync(turboPath, 'utf8')) {
  const config = JSON.parse(stripJsonc(source));
  const task = config.tasks?.['test:integration'];
  assert.ok(task, 'turbo.jsonc no longer declares the test:integration task');
  const declared = [...(task.env ?? []), ...(task.passThroughEnv ?? [])];
  assert.ok(
    declared.includes(REQUIRED_ENV),
    `turbo runs tasks in Strict env mode, so ${REQUIRED_ENV} must be declared on test:integration or it never reaches vitest and the workflow's guarantee is inert`
  );
}

test('the Unit lane installs the Linux OS-fence dependencies', () => {
  assertFenceDependenciesInstalled();
});

test('the Unit lane lets bubblewrap create an unprivileged user namespace', () => {
  assertUnprivilegedUsernsIsUnlocked();
});

test('both Unit integration steps refuse to skip the real-fence suites', () => {
  assertIntegrationStepsRequireTheDependencies();
});

test('turbo forwards the requirement flag into the integration lane', () => {
  assertTurboForwardsTheRequirement();
});

test('CONTROL: dropping the install step turns the dependency guard red', () => {
  const mutated = hostActionSource().replace(
    /sudo apt-get install -y --no-install-recommends bubblewrap socat ripgrep/,
    'sudo apt-get install -y --no-install-recommends jq'
  );
  assert.notEqual(mutated, hostActionSource(), 'the control mutation did not apply');
  assert.throws(() => assertFenceDependenciesInstalled(workflowSource(), mutated), /must install/);
});

test('CONTROL: dropping the shared host step from unit-shard turns the dependency guard red', () => {
  const mutated = workflowSource().replace(
    / {6}- name: Provision the Linux desktop test host\n {8}uses: \.\/\.github\/actions\/linux-desktop-test-host\n/,
    '      - name: Provision the Linux desktop test host\n        uses: ./.github/actions/setup-workspace\n'
  );
  assert.notEqual(mutated, workflowSource(), 'the control mutation did not apply');
  assert.throws(() => assertFenceDependenciesInstalled(mutated), /must provision its host/);
});

test('CONTROL: gating the shared host step to some shards turns the dependency guard red', () => {
  const mutated = workflowSource().replace(
    / {6}- name: Provision the Linux desktop test host\n/,
    "      - name: Provision the Linux desktop test host\n        if: matrix.partition == 'agent'\n"
  );
  assert.notEqual(mutated, workflowSource(), 'the control mutation did not apply');
  assert.throws(() => assertFenceDependenciesInstalled(mutated), /every Unit shard/);
});

test('CONTROL: restoring the userns restriction turns the bubblewrap guard red', () => {
  const mutated = hostActionSource().replace(
    /sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0\n/,
    ''
  );
  assert.notEqual(mutated, hostActionSource(), 'the control mutation did not apply');
  assert.throws(
    () => assertUnprivilegedUsernsIsUnlocked(workflowSource(), mutated),
    /user namespace/
  );
});

test('CONTROL: clearing the requirement flag turns the skip guard red', () => {
  const mutated = workflowSource().replaceAll(`${REQUIRED_ENV}: "1"`, `${REQUIRED_ENV}: "0"`);
  assert.notEqual(mutated, workflowSource(), 'the control mutation did not apply');
  assert.throws(() => assertIntegrationStepsRequireTheDependencies(mutated), /must set/);
});

test('CONTROL: dropping the turbo declaration turns the Strict-mode guard red', () => {
  const mutated = readFileSync(turboPath, 'utf8').replace(`"${REQUIRED_ENV}",\n        `, '');
  assert.notEqual(mutated, readFileSync(turboPath, 'utf8'), 'the control mutation did not apply');
  assert.throws(() => assertTurboForwardsTheRequirement(mutated), /Strict env mode/);
});

test('the Unit lane asserts an interpreter for the fence suites', () => {
  assertInterpreterIsAsserted();
});

test('CONTROL: dropping the interpreter assertion turns that guard red', () => {
  const mutated = hostActionSource().replace(/\n *python3 --version/, '');
  assert.notEqual(mutated, hostActionSource(), 'the control mutation did not apply');
  assert.throws(
    () => assertInterpreterIsAsserted(workflowSource(), mutated),
    /need an interpreter/
  );
});

test('every suite-wide skip escalates in a promised lane, not just the dependency one', () => {
  assertEveryFinalSkipEscalates();
});

test('CONTROL: escalating inside the host gate alone turns the completeness guard red', () => {
  // The exact shape this PR shipped first: the throw lived in
  // describeFenceHostSkipReason, which never sees the interpreter or
  // reachability reasons.
  const mutated = readFileSync(gatePath, 'utf8').replace(
    '  if (deps.errors.length > 0) {\n    return `sandbox-runtime dependencies are missing',
    '  if (deps.errors.length > 0) {\n    throw new Error("deps missing");\n    return `sandbox-runtime dependencies are missing'
  );
  assert.notEqual(mutated, readFileSync(gatePath, 'utf8'), 'the control mutation did not apply');
  assert.throws(() => assertEveryFinalSkipEscalates(mutated), /must NOT escalate on its own/);
});

test('CONTROL: a spec that skips without the choke point turns the completeness guard red', () => {
  const original = readFileSync(FENCE_SPECS[0], 'utf8');
  const mutated = original.replace(
    /const skipReason = refuseToSkipInAPromisedLane\(\n[\s\S]*?\n\);/,
    'const skipReason = await describeSkipReason();'
  );
  assert.notEqual(mutated, original, 'the control mutation did not apply');
  assert.throws(
    () =>
      assertEveryFinalSkipEscalates(readFileSync(gatePath, 'utf8'), [
        mutated,
        ...FENCE_SPECS.slice(1).map((spec) => readFileSync(spec, 'utf8')),
      ]),
    /bypasses refuseToSkipInAPromisedLane/
  );
});
