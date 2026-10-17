/**
 * BST-1009 (R09): `pnpm check` must stay an honest mirror of the CI gate set.
 *
 * `scripts/check.mjs` used to be a SECOND, divergent definition of CI, and the
 * divergence was a false green rather than a documented difference: its
 * `test:coverage:split` step resolves to
 * `pnpm -r --filter '!@brainstrike/db' … run test:coverage`, so a green
 * `pnpm check` had never executed `packages/db` at all — while also skipping
 * `secrets:scan`, `turbo boundaries`, the former db lane checks, and
 * `test:scripts` (the guard-script gate that exists to catch exactly this).
 *
 * This contract parses `.github/workflows/test.yml` — the source of truth —
 * and requires every gating `run:` step to be either
 *
 *   a) mapped to a step id that `buildPlan()` actually emits, or
 *   b) named in `CI_GATES_NOT_RUN_LOCALLY` with a reason a reader can audit,
 *      or
 *   c) listed in `PROVISIONING_STEPS` below as runner plumbing, not a gate.
 *
 * Anything else FAILS. A new CI gate therefore cannot slip into the workflow
 * without either being covered locally or being declared uncovered — no silent
 * omission (AGENTS.md: NO SILENT FALLBACKS).
 *
 * Per the BST-836 discipline, the guard is control-tested: a SYNTHETIC
 * `check.mjs` with a gate deleted from its plan, and another with an exclusion
 * entry deleted, must both make the parity assertion throw. A guard never
 * observed failing is not evidence.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

import {
  buildPlan,
  CI_GATE_PLAN_IDS,
  CI_GATES_NOT_RUN_LOCALLY,
  parseFlags,
  runStep,
  uncoveredCiGates,
} from '../check.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const checkSourcePath = path.join(repoRoot, 'scripts', 'check.mjs');
const nightlyCoverageWorkflowPath = path.join(
  repoRoot,
  '.github',
  'workflows',
  'nightly-coverage.yml'
);
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'test.yml');

/**
 * Runner plumbing: steps that provision the machine, propagate the quiet-head
 * admission decision, or REPORT a verdict the gates already reached. They gate
 * nothing about the code, so a local gate has nothing to mirror. Keyed
 * `<job> › <step name>` so the repeated names ("Install dependencies",
 * "Require successful admission") stay distinguishable per job.
 */
const PROVISIONING_STEPS = new Set([
  'admission › Wait for pull request activity to settle',
  'static › Require successful admission',
  // Native affected selection only avoids empty runners; local tests stay full.
  'static › Select affected Unit shards',
  'unit-shard › Require successful admission',
  'unit › Require successful admission',
  'unit › Check shard results',
  'build › Require successful admission',
  'browser-tests › Require successful admission',
  'browser-tests › Install dependencies',
  'web-e2e › Require successful admission',
  'web-e2e › Install dependencies',
  // Explicit browser/system-tool provisioning; drift is guarded by
  // verify-playwright-pin-sync.test.mjs and web-chromium.test.mjs.
  'web-e2e › Install web test system tools',
  'web-e2e › Provision qualified web Chromium',
  'desktop-e2e-smoke › Require successful admission',
  'desktop-e2e-smoke › Install Chromium system dependencies',
  'desktop-e2e-smoke › Provision Electron binary',
  'desktop-e2e-delegated › Require successful admission',
  'desktop-e2e-delegated › Install Chromium system dependencies',
  'desktop-e2e-delegated › Provision Electron binary',
  // The required Desktop E2E fan-in only reports its smoke lanes' verdicts.
  'desktop-e2e › Require successful admission',
  'desktop-e2e › Check lane results',
  // Runner plumbing for the packaged OAuth proof: installs the freedesktop
  // Secret Service and URL-opening utilities required by the packaged app on
  // headless Linux. The packaged-lane contract pins the daemon wiring.
  'native-electron › Provision Linux desktop services',
]);

function workflowSource() {
  return readFileSync(workflowPath, 'utf8');
}

function stripJsonc(source) {
  let output = '';
  let inBlockComment = false;
  let inLineComment = false;
  let inString = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (inLineComment) {
      if (character === '\n') {
        inLineComment = false;
        output += character;
      }
      continue;
    }
    if (inBlockComment) {
      if (character === '*' && nextCharacter === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += character;
      if (character === '\\') {
        output += nextCharacter ?? '';
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === '/' && nextCharacter === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    output += character;
  }

  return output.replace(/,(\s*[}\]])/g, '$1');
}

function parseJsonc(source) {
  return JSON.parse(stripJsonc(source));
}

/**
 * CI gates whose work is raw shell — no pnpm/turbo/node invocation for the
 * command comparison below to match on. Each needs a named test that covers
 * its drift, or the comparison would pass vacuously for it.
 */
const SHELL_GATE_STEPS = new Set([
  // The LOCAL side of this gate is no longer shell — it is
  // `node scripts/validate-css-bundle.mjs`, control-tested in
  // scripts/__tests__/validate-css-bundle.test.mjs (too small, and duplicate
  // layers, each proven to throw). The CI side is still inline shell and
  // test.yml is not ours to edit, so the exemption stays — but it now means
  // "CI's half is unparseable", not "nothing verifies this". Its drift is
  // covered by 'the CSS bundle gate has not drifted from the workflow', which
  // reads the byte floor and duplicate-layer pattern out of test.yml and
  // requires the validator's exported constants to match.
  'build › Validate CSS bundle',
]);

/** pnpm subcommands that are not a package script. */
const PNPM_NON_SCRIPT_SUBCOMMANDS = new Set([
  'add',
  'dlx',
  'exec',
  'install',
  'licenses',
  'link',
  'list',
  'remove',
  'store',
  'turbo',
  'update',
  'why',
]);

function splitShellCommands(text) {
  return text
    .split(/\n|&&|;/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function turboInvocations(command) {
  const found = new Set();
  // `pnpm turbo run <tasks>` / `turbo run <tasks>` (CI) and this repo's wrapper
  // `run-turbo-command.mjs [wrapper flags] -- run <tasks>` (the local plan).
  for (const pattern of [
    /(?:^|\s)turbo\s+run\s+(.*)$/,
    /run-turbo-command\.mjs\b.*?\s--\s+run\s+(.*)$/,
  ]) {
    const match = command.match(pattern);
    if (!match) {
      continue;
    }
    for (const token of match[1].trim().split(/\s+/)) {
      // Tasks come first; the first flag or `${{ … }}` expression ends them.
      if (token.startsWith('-') || token.startsWith('$')) {
        break;
      }
      found.add(`turbo-task:${token}`);
    }
  }
  // Non-`run` turbo subcommands — `turbo boundaries` today, whatever is added
  // tomorrow. `run-turbo-command.mjs` cannot match: its `turbo` is preceded by
  // a hyphen, not by whitespace.
  const subcommand = command.match(/(?:^|\s)turbo\s+([a-z][\w-]*)/);
  if (subcommand && subcommand[1] !== 'run') {
    found.add(`turbo:${subcommand[1]}`);
  }
  return found;
}

function pnpmInvocations(command) {
  const found = new Set();
  const tokens = command.split(/\s+/);
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== 'pnpm') {
      continue;
    }
    let cursor = index + 1;
    while (cursor < tokens.length && tokens[cursor].startsWith('-')) {
      // `--filter <value>` takes a separate argument; `--filter=<value>` does not.
      cursor += tokens[cursor] === '--filter' ? 2 : 1;
    }
    const subcommand = tokens[cursor];
    if (subcommand === undefined) {
      continue;
    }
    if (subcommand === 'run') {
      if (tokens[cursor + 1]) {
        found.add(`pnpm-script:${tokens[cursor + 1]}`);
      }
      continue;
    }
    if (subcommand === 'exec') {
      const binary = tokens[cursor + 1];
      // turbo is covered with far more precision by turboInvocations.
      if (binary && binary !== 'turbo') {
        found.add(`pnpm-exec:${binary}`);
      }
      continue;
    }
    if (!PNPM_NON_SCRIPT_SUBCOMMANDS.has(subcommand)) {
      // Script shorthand: `pnpm --filter @brainstrike/db test:coverage`.
      found.add(`pnpm-script:${subcommand}`);
    }
  }
  return found;
}

function nodeScriptInvocations(command) {
  const found = new Set();
  for (const match of command.matchAll(/(?:^|\s)node\s+(\S+\.(?:mjs|cjs|js))(?:\s|$)/g)) {
    found.add(`node-script:${match[1].split('/').pop()}`);
  }
  return found;
}

/**
 * The gate SEMANTICS of a command: which pnpm scripts, turbo tasks, and node
 * scripts it actually invokes.
 *
 * Comparing these instead of step names is the whole point. Asserting only
 * that a mapped plan id still exists lets `pnpm test:scripts` become
 * `pnpm test:scripts && pnpm run new-gate` with the contract still green — the
 * new gate would run in CI, never locally, and nothing would say so. Every
 * gate in test.yml is a pnpm/turbo/node invocation, so a CI step whose token
 * set comes back EMPTY is a shape this extractor does not understand and must
 * fail rather than pass vacuously (see SHELL_GATE_STEPS).
 */
function gateInvocations(text) {
  const found = new Set();
  for (const command of splitShellCommands(text)) {
    for (const token of turboInvocations(command)) {
      found.add(token);
    }
    for (const token of pnpmInvocations(command)) {
      found.add(token);
    }
    for (const token of nodeScriptInvocations(command)) {
      found.add(token);
    }
  }
  return found;
}

/** @returns {{ env: Record<string, unknown>, key: string, run: string }[]} every named `run:` step */
function workflowRunSteps(source, { label, minimumSteps }) {
  const workflow = parseYaml(source);
  assert.ok(workflow?.jobs, `${label} must parse to a workflow with jobs`);

  const steps = [];
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.run === 'string') {
        assert.ok(
          typeof step.name === 'string' && step.name.length > 0,
          `every run: step needs a name; ${jobId} has an unnamed one`
        );
        steps.push({
          env: step.env && typeof step.env === 'object' ? step.env : {},
          key: `${jobId} › ${step.name}`,
          run: step.run,
        });
      }
    }
  }
  assert.ok(
    steps.length >= minimumSteps,
    `expected at least ${minimumSteps} named run steps in ${label}, found ${steps.length}`
  );
  return steps;
}

/** @returns {{ env: Record<string, unknown>, key: string, run: string }[]} every `run:` step in test.yml */
function ciRunSteps(source = workflowSource()) {
  return workflowRunSteps(source, { label: 'test.yml', minimumSteps: 30 });
}

function assertProvisioningStepsExist(provisioningSteps, source = workflowSource()) {
  const keys = new Set(ciRunSteps(source).map((step) => step.key));
  for (const step of provisioningSteps) {
    assert.ok(
      keys.has(step),
      `PROVISIONING_STEPS names "${step}", which test.yml no longer has. ` +
        'A stale exclusion can hide a renamed gate.'
    );
  }
}

function ciStep(key) {
  const found = ciRunSteps().find((step) => step.key === key);
  assert.ok(found, `test.yml no longer has the step "${key}"`);
  return found;
}

function ciRunStep(key) {
  return ciStep(key).run;
}

function timeoutSensitiveTurboTaskNames(config) {
  assert.ok(
    config?.tasks && typeof config.tasks === 'object' && !Array.isArray(config.tasks),
    'turbo.jsonc must declare a tasks object'
  );
  const taskNames = Object.keys(config.tasks).filter(
    (taskName) =>
      ['test', 'test:browser', 'test:coverage', 'test:integration'].includes(taskName) ||
      /^test:coverage:db:/.test(taskName)
  );
  assert.ok(
    taskNames.length >= 5,
    `expected at least 5 Vitest task families to hash timeout policy, found ${taskNames.length}`
  );
  return taskNames;
}

function assertTimeoutMultiplierIsHashed(config) {
  for (const taskName of timeoutSensitiveTurboTaskNames(config)) {
    const task = config.tasks[taskName];
    assert.ok(task, `turbo.jsonc no longer declares the ${taskName} task`);
    assert.ok(
      task.env?.includes('TEST_TIMEOUT_MULTIPLIER'),
      `turbo ${taskName} must hash TEST_TIMEOUT_MULTIPLIER in env`
    );
    assert.ok(
      !task.passThroughEnv?.includes('TEST_TIMEOUT_MULTIPLIER'),
      `turbo ${taskName} must not leave the result-affecting multiplier unhashed`
    );
  }
}

function assertCacheableTestWorkerModeIsHashed(config) {
  const task = config.tasks.test;
  assert.ok(task, 'turbo.jsonc no longer declares the test task');
  assert.ok(
    task.env?.includes('CI'),
    'turbo test must hash CI because it changes Vitest worker and coverage workloads'
  );
  assert.ok(
    !task.passThroughEnv?.includes('CI'),
    'turbo test must not pass CI through without hashing its result-affecting workload'
  );
}

function assertDbTestShardEnvIsScoped(rootConfig, dbConfig) {
  assert.ok(
    !rootConfig.tasks.test.env?.includes('DB_TEST_SHARD'),
    'root turbo test must not hash DB_TEST_SHARD for every package in the filter closure'
  );
  assert.deepEqual(
    dbConfig.tasks.test.env,
    ['$TURBO_EXTENDS$', 'DB_TEST_SHARD'],
    'packages/db test must append DB_TEST_SHARD to the inherited hashed environment'
  );
  assert.ok(
    rootConfig.tasks['test:coverage:db:shard'].env?.includes('DB_TEST_SHARD'),
    'the DB coverage shard task must hash DB_TEST_SHARD'
  );
}

function assertAgentTestShardEnvIsScoped(rootConfig, agentConfig) {
  const shardVariables = ['AGENT_TEST_SHARD', 'AGENT_TEST_SHARD_REQUIRED'];
  for (const taskName of ['test', 'test:integration']) {
    for (const variable of shardVariables) {
      assert.ok(
        !rootConfig.tasks[taskName].env?.includes(variable),
        `root turbo ${taskName} must not hash ${variable} for every package in the filter closure`
      );
    }
    assert.deepEqual(
      agentConfig.tasks[taskName].env,
      ['$TURBO_EXTENDS$', ...shardVariables],
      `packages/agent ${taskName} must append the Agent shard identity to the inherited hashed environment`
    );
  }
}

function assertRootTestPhaseParity(rootPackage) {
  const commands = splitShellCommands(rootPackage.scripts.test);
  assert.equal(commands.length, 2, 'root pnpm test must run unit and integration as two phases');
  assert.match(
    commands[0],
    /\brun\s+test\s+--concurrency=1\b/,
    'root pnpm test must admit one whole-host unit pool at a time'
  );
  assert.doesNotMatch(
    commands[0],
    /\btest:integration\b/,
    'root pnpm test must not combine integration into the unit phase'
  );
  assert.match(
    commands[1],
    /\brun\s+test:integration\s+--concurrency=2\b/,
    'root pnpm test must run integration after unit at CI concurrency 2'
  );
}

function unitPhaseTestSteps(source = workflowSource()) {
  return ciRunSteps(source).filter(
    (step) =>
      step.key.startsWith('unit-shard › ') &&
      /\bpnpm\s+turbo\s+run\s+test(?::integration)?(?:\s|$)/.test(step.run)
  );
}

function assertUnitWorkflowTimeoutPolicy(source = workflowSource()) {
  const steps = unitPhaseTestSteps(source);
  assert.equal(steps.length, 4, 'the Unit phase test-step count changed; re-audit timeout policy');
  for (const step of steps) {
    assert.equal(
      step.env['TEST_TIMEOUT_MULTIPLIER'],
      '2',
      `${step.key} must use the same explicit timeout policy as local gates`
    );
  }
}

function assertNightlyCoverageTimeoutPolicy(
  source = readFileSync(nightlyCoverageWorkflowPath, 'utf8')
) {
  const steps = workflowRunSteps(source, {
    label: 'nightly-coverage.yml',
    minimumSteps: 10,
  }).filter((step) => /\bpnpm\s+turbo\s+run\s+test:coverage(?:\s|:)/.test(step.run));
  assert.equal(
    steps.length,
    2,
    'the Nightly Coverage Vitest step count changed; re-audit timeout policy'
  );
  for (const step of steps) {
    assert.equal(
      step.env['TEST_TIMEOUT_MULTIPLIER'],
      '2',
      `${step.key} must use the explicit coverage timeout policy`
    );
  }
}

/**
 * The single parity assertion, shared by the real module, by the synthetic
 * control modules, and by the mutated-workflow controls. Throws — it must be
 * usable inside `assert.throws`.
 *
 * `workflowText` and `shellGateSteps` are parameters so a control can drive
 * this against a workflow that gained a gate, or with the vacuity allowlist
 * emptied.
 */
function assertPlanCoversCiGates(
  plan,
  exclusions,
  workflowText = workflowSource(),
  shellGateSteps = SHELL_GATE_STEPS
) {
  const planById = new Map(plan.map((step) => [step.id, step]));
  const excluded = new Set(exclusions.map((entry) => entry.step));
  const unmapped = [];

  for (const { key, run } of ciRunSteps(workflowText)) {
    if (PROVISIONING_STEPS.has(key) || excluded.has(key)) {
      continue;
    }
    const required = CI_GATE_PLAN_IDS.get(key);
    if (!required) {
      unmapped.push(key);
      continue;
    }

    const covered = new Set();
    for (const id of required) {
      const step = planById.get(id);
      if (!step) {
        throw new Error(
          `CI gate "${key}" maps to plan step "${id}", which pnpm check's plan does not contain.`
        );
      }
      for (const token of gateInvocations(step.command)) {
        covered.add(token);
      }
    }

    const wanted = gateInvocations(run);
    if (wanted.size === 0 && !shellGateSteps.has(key)) {
      throw new Error(
        `CI gate "${key}" invokes no pnpm/turbo/node command this contract can compare, so ` +
          'mapping it proves nothing. Declare it in SHELL_GATE_STEPS naming the test that ' +
          'covers its drift, or teach gateInvocations its shape.'
      );
    }
    for (const token of wanted) {
      if (!covered.has(token)) {
        throw new Error(
          `CI gate "${key}" runs \`${token}\`, which no plan step mapped to it ` +
            `(${required.join(', ')}) runs. pnpm check would go green without it.`
        );
      }
    }
  }

  if (unmapped.length > 0) {
    throw new Error(
      'CI run steps that are neither covered by a plan step nor declared in ' +
        `CI_GATES_NOT_RUN_LOCALLY:\n  ${unmapped.join('\n  ')}`
    );
  }
}

test('CI_GATE_PLAN_IDS maps exactly the gating steps — no missing, no stale', () => {
  // The mapping must be exhaustive in BOTH directions. Missing entries are
  // caught by the parity assertion's `unmapped` list; a STALE entry — one
  // naming a step test.yml no longer has — is not, and it would quietly shrink
  // what the contract checks while every test stayed green.
  const excluded = new Set(CI_GATES_NOT_RUN_LOCALLY.map((entry) => entry.step));
  const gatingSteps = ciRunSteps()
    .map((step) => step.key)
    .filter((key) => !(PROVISIONING_STEPS.has(key) || excluded.has(key)));

  assert.deepEqual([...CI_GATE_PLAN_IDS.keys()].sort(), gatingSteps.sort());
});

/** Import a variant of check.mjs with `mutate` applied to its source text. */
async function importMutatedCheck(mutate) {
  const source = readFileSync(checkSourcePath, 'utf8');
  const mutated = mutate(source);
  assert.notEqual(
    mutated,
    source,
    'the control mutation matched nothing in check.mjs — the control test would be vacuous'
  );
  const dir = mkdtempSync(path.join(tmpdir(), 'check-parity-control-'));
  try {
    const file = path.join(dir, 'check.mjs');
    writeFileSync(file, mutated);
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test('the default plan covers every CI gate, or declares why it does not', () => {
  assertPlanCoversCiGates(buildPlan(parseFlags([])), CI_GATES_NOT_RUN_LOCALLY);
});

test('CONTROL: a plan missing a CI gate FAILS the parity assertion', async () => {
  // Matched on the step id rather than on a literal block: biome sorts object
  // keys, so a copy-pasted snippet would silently stop matching and only the
  // vacuity assertion in importMutatedCheck would notice.
  const control = await importMutatedCheck((source) =>
    source.replace(/\n\s*plan\.push\(\{[^{}]*'secrets-scan'[^{}]*\}\);/, '')
  );

  const plan = control.buildPlan(control.parseFlags([]));
  assert.ok(
    !plan.some((step) => step.id === 'secrets-scan'),
    'the synthetic plan must really be missing the gate'
  );
  assert.throws(
    () => assertPlanCoversCiGates(plan, control.CI_GATES_NOT_RUN_LOCALLY),
    /Secret scan.*secrets-scan/s,
    'a plan that dropped the secret scan must FAIL this contract'
  );
});

test('CONTROL: deleting an exclusion entry FAILS the parity assertion', async () => {
  const control = await importMutatedCheck((source) =>
    source.replace(
      /\n\s*\{[^{}]*'native-windows › Build and test Agent DevTools process ownership'[^{}]*\},/,
      ''
    )
  );

  assert.throws(
    () =>
      assertPlanCoversCiGates(
        control.buildPlan(control.parseFlags([])),
        control.CI_GATES_NOT_RUN_LOCALLY
      ),
    /neither covered by a plan step nor declared/,
    'an undeclared, uncovered CI step must FAIL this contract'
  );
});

test('CONTROL: a CI step that GAINS an uncovered gate FAILS the parity assertion', () => {
  // The drift this contract exists to catch, and the one a name-only check
  // sails past: the mapped step id still exists, the plan is untouched, and a
  // brand-new gate runs in CI and nowhere else.
  const source = workflowSource();
  const mutated = source.replace(
    'run: pnpm test:scripts',
    'run: pnpm test:scripts && pnpm run new-uncovered-gate'
  );
  assert.notEqual(
    mutated,
    source,
    'the control mutation matched nothing in test.yml — the control would be vacuous'
  );

  assert.throws(
    () => assertPlanCoversCiGates(buildPlan(parseFlags([])), CI_GATES_NOT_RUN_LOCALLY, mutated),
    /pnpm-script:new-uncovered-gate/,
    'a CI gate the plan does not run must FAIL this contract'
  );
});

test('CONTROL: an undeclared shell-only CI gate FAILS rather than passing vacuously', () => {
  // Emptying the allowlist makes `build › Validate CSS bundle` — whose run is
  // pure shell — the undeclared case. It must fail, not silently match nothing.
  assert.throws(
    () =>
      assertPlanCoversCiGates(
        buildPlan(parseFlags([])),
        CI_GATES_NOT_RUN_LOCALLY,
        workflowSource(),
        new Set()
      ),
    /invokes no pnpm\/turbo\/node command this contract can compare/
  );
});

test('gateInvocations reads the shapes both sides are actually written in', () => {
  // Control for the comparator itself: if it silently returned nothing, every
  // command comparison above would pass vacuously.
  assert.deepEqual([...gateInvocations('pnpm secrets:scan')], ['pnpm-script:secrets:scan']);
  assert.deepEqual([...gateInvocations('pnpm -s run secrets:scan')], ['pnpm-script:secrets:scan']);
  assert.deepEqual([...gateInvocations('pnpm exec turbo boundaries')], ['turbo:boundaries']);

  // Read from the real workflow rather than retyped here: these two carry the
  // shapes most likely to defeat a naive extractor — a `${{ … }}` matrix
  // expression right after the task name, and a `dbus-run-session --` wrapper
  // in front of pnpm.
  assert.ok(
    gateInvocations(ciRunStep('unit-shard › Pull request affected unit tests')).has(
      'turbo-task:test'
    )
  );
  assert.ok(
    gateInvocations(ciRunStep('desktop-e2e-smoke › Run desktop smoke')).has(
      'pnpm-script:test:e2e:lane:smoke'
    )
  );
  // `smoke` is a prefix of `smoke-delegated`; the extractor must keep them distinct.
  assert.deepEqual(
    [...gateInvocations(ciRunStep('desktop-e2e-delegated › Run desktop delegated smoke'))],
    ['pnpm-script:test:e2e:lane:smoke-delegated']
  );
  assert.ok(
    gateInvocations(
      'node scripts/run-env.mjs TURBO_TEST_MODE=unit -- node scripts/run-turbo-command.mjs --windows-concurrency=1 -- run test --concurrency=4'
    ).has('turbo-task:test')
  );
  // A wrapper must not be mistaken for the task it wraps.
  assert.ok(
    !gateInvocations('node scripts/run-turbo-command.mjs -- run build').has('turbo:command')
  );
});

test('the install step is frozen, exactly as the CI composite installs', () => {
  const composite = parseYaml(
    readFileSync(path.join(repoRoot, '.github/actions/setup-workspace/action.yml'), 'utf8')
  );
  const compositeInstall = composite.runs?.steps?.find(({ run }) => run?.includes('pnpm install'));
  assert.equal(typeof compositeInstall?.run, 'string');
  assert.match(
    compositeInstall.run,
    /(^|\n)\s*pnpm install --frozen-lockfile(\s|$)/,
    'the CI composite this mirrors must still install frozen'
  );
  // BST-1712 wrapped that command in a bounded retry loop, so it is no longer
  // alone on its line — hence `\s` above rather than `\n`. That loosening would
  // let an UNFROZEN second invocation hide behind the frozen one, so pin the
  // flag per invocation instead: a plain `pnpm install` anywhere in this script
  // would update pnpm-lock.yaml on manifest drift, which is the exact drift
  // this whole test exists to reject.
  const unfrozen = compositeInstall.run
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .filter((line) => /\bpnpm install\b/.test(line) && !line.includes('--frozen-lockfile'));
  assert.deepEqual(unfrozen, [], 'every `pnpm install` in the CI composite must be frozen');

  const install = buildPlan(parseFlags([])).find((step) => step.id === 'install');
  assert.ok(install, 'the default plan must install');
  // A plain `pnpm install` UPDATES pnpm-lock.yaml on manifest drift and stays
  // green while CI rejects the same input.
  assert.match(install.command, /--frozen-lockfile\b/);
});

test('the Playwright lanes run under CI semantics, and nothing else does', () => {
  const plan = buildPlan(parseFlags(['--full']));
  const playwrightIds = new Set([
    'web-e2e-smoke',
    'desktop-e2e-smoke',
    'desktop-e2e-delegated-smoke',
    'web-e2e-full-regression',
    'desktop-e2e-full-regression',
  ]);
  const timeoutMatchedIds = new Set([
    'browser-tests',
    'coverage',
    'integration-tests',
    'unit-tests',
  ]);

  for (const step of plan) {
    if (playwrightIds.has(step.id)) {
      // Without this, playwright.config.mts loads in local mode: forbidOnly is
      // false, so a stray `test.only` passes the lane while the required Web
      // E2E job rejects the same source.
      assert.match(step.command, /\bCI=true\b/, `${step.id} must mirror CI's environment`);
    } else {
      // BST-1050: `CI` must NOT leak into the unit/integration/build steps —
      // vector-management's vitest config switches on a 70% line-coverage
      // threshold when CI === 'true'.
      assert.doesNotMatch(
        step.command,
        /\bCI=true\b/,
        `${step.id} must not run under CI semantics; it would change the workload, not just the env`
      );
    }

    if (timeoutMatchedIds.has(step.id)) {
      assert.match(
        step.command,
        /\bTEST_TIMEOUT_MULTIPLIER=2\b/,
        `${step.id} must match CI timeout budgets without setting CI`
      );
    } else {
      assert.doesNotMatch(
        step.command,
        /\bTEST_TIMEOUT_MULTIPLIER=/,
        `${step.id} is not a Vitest Unit phase and must not inherit its timeout policy`
      );
    }
  }

  // And the unit lanes still assert the uninstrumented CI workload.
  assert.match(
    plan.find((step) => step.id === 'unit-tests').command,
    /COVERAGE=false/,
    "the unit lane must stay uninstrumented, as CI's Unit shards are"
  );
});

test('CI workflows, root Vitest scripts, and pnpm check share one hashed timeout policy', () => {
  assertUnitWorkflowTimeoutPolicy();
  assertNightlyCoverageTimeoutPolicy();

  const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  for (const scriptName of [
    'test',
    'test:browser',
    'test:coverage',
    'test:coverage:base',
    'test:coverage:embeddings',
    'test:fast',
  ]) {
    assert.match(
      rootPackage.scripts[scriptName],
      /\bTEST_TIMEOUT_MULTIPLIER=2\b/,
      `the root pnpm ${scriptName} battery must match the CI timeout policy`
    );
  }
  assertRootTestPhaseParity(rootPackage);

  const turboConfig = parseJsonc(readFileSync(path.join(repoRoot, 'turbo.jsonc'), 'utf8'));
  const dbTurboConfig = parseJsonc(
    readFileSync(path.join(repoRoot, 'packages/db/turbo.json'), 'utf8')
  );
  const agentTurboConfig = parseJsonc(
    readFileSync(path.join(repoRoot, 'packages/agent/turbo.json'), 'utf8')
  );
  assertTimeoutMultiplierIsHashed(turboConfig);
  assertCacheableTestWorkerModeIsHashed(turboConfig);
  assertDbTestShardEnvIsScoped(turboConfig, dbTurboConfig);
  assertAgentTestShardEnvIsScoped(turboConfig, agentTurboConfig);

  for (const taskName of ['test', 'test:browser', 'test:coverage', 'test:coverage:db:shard']) {
    const mutatedTurboConfig = structuredClone(turboConfig);
    mutatedTurboConfig.tasks[taskName].env = mutatedTurboConfig.tasks[taskName].env.filter(
      (name) => name !== 'TEST_TIMEOUT_MULTIPLIER'
    );
    assert.throws(
      () => assertTimeoutMultiplierIsHashed(mutatedTurboConfig),
      new RegExp(`${taskName} must hash TEST_TIMEOUT_MULTIPLIER`),
      `CONTROL: removing the hashed multiplier from ${taskName} must turn the contract red`
    );
  }

  const unhashedWorkerMode = structuredClone(turboConfig);
  unhashedWorkerMode.tasks.test.env = unhashedWorkerMode.tasks.test.env.filter(
    (name) => name !== 'CI'
  );
  unhashedWorkerMode.tasks.test.passThroughEnv = [
    ...(unhashedWorkerMode.tasks.test.passThroughEnv ?? []),
    'CI',
  ];
  assert.throws(
    () => assertCacheableTestWorkerModeIsHashed(unhashedWorkerMode),
    /turbo test must hash CI/,
    'CONTROL: moving CI back to passThroughEnv must expose the cache false-green'
  );

  const globallyHashedShard = structuredClone(turboConfig);
  globallyHashedShard.tasks.test.env.push('DB_TEST_SHARD');
  assert.throws(
    () => assertDbTestShardEnvIsScoped(globallyHashedShard, dbTurboConfig),
    /must not hash DB_TEST_SHARD for every package/,
    'CONTROL: leaking the shard environment into every unit task must turn the guard red'
  );

  const unscopedDbShard = structuredClone(dbTurboConfig);
  unscopedDbShard.tasks.test.env = ['$TURBO_EXTENDS$'];
  assert.throws(
    () => assertDbTestShardEnvIsScoped(turboConfig, unscopedDbShard),
    /must append DB_TEST_SHARD/,
    'CONTROL: removing the package-local shard hash must turn the guard red'
  );

  const globallyHashedAgentShard = structuredClone(turboConfig);
  globallyHashedAgentShard.tasks.test.env.push('AGENT_TEST_SHARD');
  assert.throws(
    () => assertAgentTestShardEnvIsScoped(globallyHashedAgentShard, agentTurboConfig),
    /must not hash AGENT_TEST_SHARD for every package/,
    'CONTROL: leaking the Agent shard environment into every unit task must turn the guard red'
  );

  const unscopedAgentShard = structuredClone(agentTurboConfig);
  unscopedAgentShard.tasks['test:integration'].env = ['$TURBO_EXTENDS$'];
  assert.throws(
    () => assertAgentTestShardEnvIsScoped(turboConfig, unscopedAgentShard),
    /must append the Agent shard identity/,
    'CONTROL: removing the Agent integration shard hash must turn the guard red'
  );

  const mismatchedRootPhases = structuredClone(rootPackage);
  mismatchedRootPhases.scripts.test = mismatchedRootPhases.scripts.test.replace(
    'run test:integration --concurrency=2',
    'run test:integration --concurrency=4'
  );
  assert.notEqual(
    mismatchedRootPhases.scripts.test,
    rootPackage.scripts.test,
    'the root-phase control mutation matched nothing'
  );
  assert.throws(
    () => assertRootTestPhaseParity(mismatchedRootPhases),
    /integration after unit at CI concurrency 2/,
    'CONTROL: root integration scheduling drift must turn the parity guard red'
  );
});

test('CONTROL: a fifth Unit test step without timeout policy turns the discovery guard red', () => {
  const source = workflowSource();
  const insertionPoint = '      - name: Push and manual integration tests\n';
  const mutated = source.replace(
    insertionPoint,
    '      - name: Unreviewed fifth unit phase\n' +
      '        run: pnpm turbo run test --filter=@brainstrike/types\n\n' +
      insertionPoint
  );
  assert.notEqual(mutated, source, 'the fifth-step control mutation matched nothing');
  assert.throws(
    () => assertUnitWorkflowTimeoutPolicy(mutated),
    /Unit phase test-step count changed/,
    'a newly added Unit phase must not bypass timeout-policy review'
  );
});

test('CONTROL: Nightly Coverage without explicit timeout policy turns the guard red', () => {
  const source = readFileSync(nightlyCoverageWorkflowPath, 'utf8');
  // Anchor the mutation inside a COVERAGE step's env block: a bare
  // TEST_TIMEOUT_MULTIPLIER line is no longer unique (the pg-textsearch
  // durability job carries one too, and it is deliberately OUTSIDE the
  // guard's turbo-run-test:coverage scope), and replace() strips the first
  // occurrence — which must be a step the guard actually inspects for this
  // control to prove anything.
  const mutated = source.replace(
    '          COVERAGE: "true"\n          NODE_ENV: test\n          TEST_TIMEOUT_MULTIPLIER: "2"\n',
    '          COVERAGE: "true"\n          NODE_ENV: test\n'
  );
  assert.notEqual(mutated, source, 'the Nightly Coverage control mutation matched nothing');
  assert.throws(
    () => assertNightlyCoverageTimeoutPolicy(mutated),
    /must use the explicit coverage timeout policy/,
    'a Nightly Coverage task must not fall back to Turbo-filtered CI state'
  );
});

test('every exclusion names a real CI step and carries a substantive reason', () => {
  const keys = new Set(ciRunSteps().map((step) => step.key));
  assertProvisioningStepsExist(PROVISIONING_STEPS);
  for (const entry of CI_GATES_NOT_RUN_LOCALLY) {
    assert.ok(
      keys.has(entry.step),
      `CI_GATES_NOT_RUN_LOCALLY names "${entry.step}", which test.yml no longer has. ` +
        'A stale exclusion can hide a renamed gate.'
    );
    assert.ok(
      typeof entry.reason === 'string' && entry.reason.trim().length >= 40,
      `"${entry.step}" needs a reason a reader can audit, not a placeholder.`
    );
  }
});

test('CONTROL: a stale provisioning exclusion turns the guard red', () => {
  assert.throws(
    () =>
      assertProvisioningStepsExist(
        new Set([...PROVISIONING_STEPS, 'desktop-e2e › Stale provisioning step'])
      ),
    /PROVISIONING_STEPS names "desktop-e2e › Stale provisioning step"/
  );
});

test('packages/db is tested by a green pnpm check', () => {
  const plan = buildPlan(parseFlags([]));
  const unit = plan.find((step) => step.id === 'unit-tests');
  assert.ok(unit, 'the plan must run the unit lane');

  // The exact false green this ticket removed: the old plan reached db-less
  // `pnpm -r --filter '!@brainstrike/db'` recursion via test:coverage:split.
  for (const step of plan) {
    assert.doesNotMatch(
      step.command,
      /!@brainstrike\/db/,
      `step "${step.id}" negates packages/db out of the local gate`
    );
    assert.doesNotMatch(
      step.command,
      /\bpnpm -r\b/,
      `step "${step.id}" uses pnpm -r recursion; CI selects through turbo and the two drift`
    );
    assert.doesNotMatch(
      step.command,
      /test:coverage:(split|base)/,
      `step "${step.id}" reintroduces the db-excluding coverage split`
    );
  }

  // Unfiltered turbo selection is the union of CI's five logical Unit
  // partitions (DB and Agent each use two native Vitest shards).
  assert.match(unit.command, /run-turbo-command\.mjs .*run test\b/);
  assert.doesNotMatch(unit.command, /--filter/);
});

test('local test batteries do not stack whole-host unit worker pools', () => {
  const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  for (const mode of [[], ['--fast'], ['--full'], ['--routine']]) {
    const plan = buildPlan(parseFlags(mode));
    for (const step of plan.filter(({ id }) => id === 'unit-tests' || id === 'coverage')) {
      assert.match(
        step.command,
        /--concurrency=1(?:\s|$)/,
        `${step.id} must leave package parallelism to its Vitest pool`
      );
    }
  }
  for (const name of ['test', 'test:affected']) {
    const [unit] = splitShellCommands(rootPackage.scripts[name]);
    assert.match(unit, /--concurrency=1(?:\s|$)/, `${name} must not stack unit worker pools`);
  }
  const [fastUnit] = splitShellCommands(rootPackage.scripts['test:fast']);
  assert.match(fastUnit, /--workspace-concurrency=1(?:\s|$)/);
});

test('the local unit lane mirrors CI selection semantics and cache keys', () => {
  const plan = buildPlan(parseFlags([]));
  const unit = plan.find((step) => step.id === 'unit-tests');
  const integration = plan.find((step) => step.id === 'integration-tests');

  for (const step of [unit, integration]) {
    assert.match(step.command, /TURBO_TEST_MODE=unit/, `${step.id} must share CI's test cache key`);
  }

  // The task sets and cache keys match CI. Local unit pools can use the whole
  // host, so package admission is serial; CI keeps its dedicated-runner cap.
  // Integration pools already bound their real subsystem work separately.
  assert.match(ciRunStep('unit-shard › Push and manual unit tests'), /--concurrency=4/);
  assert.match(ciRunStep('unit-shard › Push and manual integration tests'), /--concurrency=2/);
  assert.match(unit.command, /--concurrency=1/);
  assert.match(integration.command, /--concurrency=2/);
});

test('lint is read-only by default and writing is an explicit opt-in', () => {
  const readOnly = buildPlan(parseFlags([])).find((step) => step.id === 'lint');
  assert.equal(readOnly.command, 'pnpm -s run lint:ci');
  assert.match(
    ciRunStep('static › Lint'),
    /pnpm run lint:ci/,
    'CI must still be the read-only chain this mirrors'
  );

  const writing = buildPlan(parseFlags(['--fix-lint'])).find((step) => step.id === 'lint');
  assert.equal(writing.command, 'pnpm -s run lint-all');
});

test('the CSS bundle gate has not drifted from the workflow', () => {
  const ciStep = ciRunStep('build › Validate CSS bundle');
  const local = buildPlan(parseFlags([])).find((step) => step.id === 'validate-css-bundle');
  assert.ok(local, 'the plan must validate the CSS bundle');

  // The two literals that ARE the gate. A copied shell snippet can drift;
  // these cannot drift silently.
  const floor = ciStep.match(/-lt (\d+)/);
  assert.ok(floor, 'the CI gate must still assert a minimum CSS bundle size');
  assert.equal(local.command, 'node scripts/validate-css-bundle.mjs');
  const validatorSource = readFileSync(
    path.join(repoRoot, 'scripts', 'validate-css-bundle.mjs'),
    'utf8'
  );
  assert.match(
    validatorSource,
    new RegExp(`CSS_BUNDLE_MIN_BYTES = ${floor[1].replace(/000$/, '_000')}`)
  );

  const pattern = ciStep.match(/PAT='([^']+)'/);
  assert.ok(pattern, 'the CI gate must still assert a single Tailwind base layer');
  assert.ok(
    validatorSource.includes(pattern[1]),
    `the portable CSS gate must use the same duplicate-layer pattern: ${pattern[1]}`
  );
});

test('the build step invokes turbo directly, never through `pnpm run build --`', () => {
  const build = buildPlan(parseFlags([])).find((step) => step.id === 'build');
  assert.match(build.command, /run-turbo-command\.mjs -- run build\b/);
  assert.doesNotMatch(build.command, /pnpm .*run build --/);
  // The flags CI's Build step carries.
  assert.match(build.command, /--continue=dependencies-successful/);
  assert.match(build.command, /TAILWIND_DEBUG=1/);
  assert.match(ciRunStep('build › Build'), /--continue=dependencies-successful/);
});

test('a non-zero step exit fails the whole check despite --continue', async () => {
  // `--continue=dependencies-successful` changes turbo's SCHEDULING, not its
  // exit code, and this is the seam that turns that exit code into a failed
  // `pnpm check`. Proven, not asserted.
  await assert.rejects(
    () => runStep({ command: 'exit 3', id: 'control', label: 'control' }, false),
    (error) => error.code === 3
  );
  const ok = await runStep({ command: 'exit 0', id: 'control', label: 'control' }, false);
  assert.equal(ok.label, 'control');
});

test('a child spawn error fails the whole check instead of hanging', async () => {
  const failedSpawn = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('spawn failed')));
    return child;
  };
  await assert.rejects(
    () => runStep({ command: 'control', id: 'control', label: 'control' }, false, failedSpawn),
    (error) => error.code === 1 && error.message === 'spawn failed'
  );
});

test('boundaries runs before any dist-producing step, as it does in Static', () => {
  const ids = buildPlan(parseFlags([])).map((step) => step.id);
  const boundaries = ids.indexOf('boundaries');
  assert.notEqual(boundaries, -1);
  for (const id of ['type-check', 'build', 'unit-tests', 'browser-tests']) {
    assert.ok(boundaries < ids.indexOf(id), `boundaries must precede ${id}`);
  }
});

test('the documented flags stay coherent', () => {
  const ids = (argv) => buildPlan(parseFlags(argv)).map((step) => step.id);

  assert.ok(ids([]).includes('install'));
  assert.ok(!ids(['--no-install']).includes('install'));

  for (const id of ['web-e2e-smoke', 'desktop-e2e-smoke', 'desktop-e2e-delegated-smoke']) {
    assert.ok(ids([]).includes(id));
    assert.ok(!ids(['--no-e2e']).includes(id));
  }

  // --fast keeps every gate a single Static/Unit/Build runner performs and
  // drops the lanes CI fans out to separate machines.
  const fast = ids(['--fast']);
  for (const id of [
    'secrets-scan',
    'boundaries',
    'script-tests',
    'lint',
    'type-check',
    'build',
    'unit-tests',
    'integration-tests',
  ]) {
    assert.ok(fast.includes(id), `--fast must keep ${id}`);
  }
  for (const id of [
    'browser-tests',
    'web-e2e-smoke',
    'desktop-e2e-smoke',
    'desktop-e2e-delegated-smoke',
  ]) {
    assert.ok(!fast.includes(id), `--fast must drop ${id}`);
  }

  // --full is additive: the required mirror plus the advisory/nightly gates.
  const full = ids(['--full']);
  for (const id of ids([])) {
    assert.ok(full.includes(id), `--full must be a superset of the default plan (${id})`);
  }
  for (const id of ['coverage', 'coverage-enforce', 'web-e2e-full-regression']) {
    assert.ok(full.includes(id), `--full must add ${id}`);
  }

  // --no-coverage stays meaningful: it is the opt-out of the only mode that
  // runs coverage at all.
  assert.ok(!ids(['--full', '--no-coverage']).includes('coverage-enforce'));

  assert.ok(ids(['--headless'])[0] === 'setup-headless');

  assert.throws(() => parseFlags(['--fast', '--full']), /select different plans/);
  assert.throws(() => parseFlags(['--no-coverage']), /only applies with --full/);
});

test('routine selection discloses the complete integration matrices it omits', () => {
  const plan = buildPlan(parseFlags(['--routine', '--no-install']));
  const ids = new Set(plan.map((step) => step.id));
  for (const id of [
    'unit-tests',
    'browser-tests',
    'routine-integration-packages',
    'desktop-routine-integration',
    'agent-host-routine-integration',
    'desktop-e2e-smoke',
    'desktop-e2e-delegated-smoke',
  ]) {
    assert.ok(ids.has(id), id);
  }
  assert.ok(!ids.has('integration-tests'));
  assert.ok(uncoveredCiGates(plan).some((gate) => gate.step.includes('integration tests')));
  assert.throws(() => parseFlags(['--routine', '--full']), /separate plan/);
  assert.throws(() => parseFlags(['--routine', '--fast']), /separate plan/);
});

test('stress qualification is explicit and cannot silently omit E2E', () => {
  const ordinary = new Set(buildPlan(parseFlags(['--full'])).map((step) => step.id));
  const stress = new Set(buildPlan(parseFlags(['--full', '--stress'])).map((step) => step.id));
  for (const id of ['lock-stress', 'desktop-native-retirement']) {
    assert.ok(stress.has(id));
    assert.ok(!ordinary.has(id));
  }
  assert.throws(() => parseFlags(['--stress']), /requires --full/);
  assert.throws(() => parseFlags(['--full', '--stress', '--no-e2e']), /requires --full/);
});

test('mode flags report every required gate they omit', () => {
  const omittedByFast = new Set(
    uncoveredCiGates(buildPlan(parseFlags(['--fast']))).map((gate) => gate.step)
  );
  for (const step of [
    'browser-tests › Run browser tests',
    'web-e2e › Run web smoke',
    'desktop-e2e-smoke › Run desktop smoke',
    'desktop-e2e-delegated › Run desktop delegated smoke',
  ]) {
    assert.ok(omittedByFast.has(step), `--fast must disclose that it omits ${step}`);
  }

  const omittedByNoE2E = new Set(
    uncoveredCiGates(buildPlan(parseFlags(['--no-e2e']))).map((gate) => gate.step)
  );
  for (const step of [
    'web-e2e › Run web smoke',
    'desktop-e2e-smoke › Run desktop smoke',
    'desktop-e2e-delegated › Run desktop delegated smoke',
  ]) {
    assert.ok(omittedByNoE2E.has(step), `--no-e2e must disclose that it omits ${step}`);
  }
});

test('an unknown flag fails loudly rather than running a different plan', () => {
  assert.throws(() => parseFlags(['--no-such-flag']), /Unknown flag/);
});

test('the root package scripts still reach this orchestrator', () => {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.match(manifest.scripts.check, /scripts\/check\.mjs/);
  assert.match(manifest.scripts['check:fast'], /scripts\/check\.mjs --fast/);
  assert.match(manifest.scripts['check:full'], /scripts\/check\.mjs --full/);
});
