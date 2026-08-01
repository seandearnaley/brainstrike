/**
 * BST-1009 (R09): `pnpm check` must stay an honest mirror of the CI gate set.
 *
 * `scripts/check.mjs` used to be a SECOND, divergent definition of CI, and the
 * divergence was a false green rather than a documented difference: its
 * `test:coverage:split` step resolves to
 * `pnpm -r --filter '!@brainstrike/db' … run test:coverage`, so a green
 * `pnpm check` had never executed `packages/db` at all — while also skipping
 * `secrets:scan`, `turbo boundaries`, the two db lane checks, and
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
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'test.yml');

/**
 * Runner plumbing: steps that provision the machine or propagate the
 * quiet-head admission decision. They gate nothing about the code, so a local
 * gate has nothing to mirror. Keyed `<job> › <step name>` so the repeated
 * names ("Install dependencies", "Require successful admission") stay
 * distinguishable per job.
 */
const PROVISIONING_STEPS = new Set([
  'admission › Wait for pull request activity to settle',
  'static › Require successful admission',
  'unit-shard › Require successful admission',
  'unit › Require successful admission',
  'unit › Check shard results',
  'build › Require successful admission',
  'browser-tests › Require successful admission',
  'browser-tests › Install dependencies',
  'web-e2e › Require successful admission',
  'web-e2e › Install dependencies',
  'desktop-e2e › Require successful admission',
  'desktop-e2e › Get Electron version',
  'desktop-e2e › Install dependencies',
  'desktop-e2e › Install Chromium system dependencies',
  'desktop-e2e › Provision Electron binary',
]);

/**
 * Exact commands of every mapped workflow gate. The local command can use a
 * portable wrapper, but changing CI's command must force an explicit parity
 * decision instead of retaining the old mapping by step name alone.
 */
const CI_GATE_RUNS = new Map([
  ['static › Secret scan', 'pnpm secrets:scan'],
  ['static › Package boundaries', 'pnpm exec turbo boundaries'],
  ['static › Script tests', 'pnpm test:scripts'],
  [
    'static › Check DB test + coverage lane assignments',
    'pnpm --filter @brainstrike/db test:db:check-lanes\npnpm --filter @brainstrike/db test:coverage:db:check-lanes\n',
  ],
  ['static › Lint', 'pnpm run lint:ci'],
  ['static › Type check', 'pnpm run type-check'],
  [
    'unit-shard › Pull request affected unit tests',
    `pnpm turbo run test ${'$'}{{ matrix.pr_filters }} --concurrency=4`,
  ],
  [
    'unit-shard › Pull request affected integration tests',
    `pnpm turbo run test:integration ${'$'}{{ matrix.pr_filters }} --concurrency=2`,
  ],
  [
    'unit-shard › Push and manual unit tests',
    `pnpm turbo run test ${'$'}{{ matrix.push_filters }} --concurrency=4`,
  ],
  [
    'unit-shard › Push and manual integration tests',
    `pnpm turbo run test:integration ${'$'}{{ matrix.push_filters }} --concurrency=2`,
  ],
  [
    'build › Build',
    'pnpm turbo run build --summarize --log-order=grouped --continue=dependencies-successful',
  ],
  [
    'build › Validate CSS bundle',
    `CSS_SIZE=$(find apps/web/dist/assets -name '*.css' -exec cat {} + | wc -c)
echo "CSS bundle size: \${CSS_SIZE} bytes"

if [ "$CSS_SIZE" -lt 50000 ]; then
  echo "::error::CSS bundle too small: \${CSS_SIZE} bytes (expected >= 50,000 bytes). Tailwind may not be scanning all package sources."
  exit 1
fi

PAT='*,:after,:before,::backdrop{box-sizing:border-box'
DUPLICATE_COUNT=$(grep -h -F -o "$PAT" $(find apps/web/dist/assets -name '*.css') | wc -l)
if [ "$DUPLICATE_COUNT" -ne 1 ]; then
  echo "::error::Duplicate Tailwind layers detected ($DUPLICATE_COUNT copies). Check for duplicate @import \\"tailwindcss\\" statements."
  exit 1
fi
`,
  ],
  [
    'browser-tests › Run browser tests',
    'pnpm test:browser --filter=@brainstrike/db --filter=@brainstrike/storage --filter=@brainstrike/ui',
  ],
  ['web-e2e › Run web smoke', 'pnpm --filter @brainstrike/web run test:e2e:lane:smoke'],
  ['desktop-e2e › Run desktop smoke', 'dbus-run-session -- pnpm run test:e2e:lane:smoke'],
]);

function workflowSource() {
  return readFileSync(workflowPath, 'utf8');
}

/** @returns {{ key: string, run: string }[]} every `run:` step in test.yml */
function ciRunSteps() {
  const workflow = parseYaml(workflowSource());
  assert.ok(workflow?.jobs, 'test.yml must parse to a workflow with jobs');

  const steps = [];
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.run === 'string') {
        assert.ok(
          typeof step.name === 'string' && step.name.length > 0,
          `every run: step needs a name; ${jobId} has an unnamed one`
        );
        steps.push({ key: `${jobId} › ${step.name}`, run: step.run });
      }
    }
  }
  // Discovery floor: refuse a vacuous green if the parse silently found
  // nothing (a restructured workflow, a YAML shape change).
  assert.ok(steps.length >= 30, `expected the full test.yml step set, found ${steps.length}`);
  return steps;
}

function ciRunStep(key) {
  const found = ciRunSteps().find((step) => step.key === key);
  assert.ok(found, `test.yml no longer has the step "${key}"`);
  return found.run;
}

/**
 * The single parity assertion, shared by the real module and by the synthetic
 * control modules. Throws — it must be usable inside `assert.throws`.
 */
function assertPlanCoversCiGates(plan, exclusions) {
  const planIds = new Set(plan.map((step) => step.id));
  const excluded = new Set(exclusions.map((entry) => entry.step));
  const unmapped = [];

  for (const { key } of ciRunSteps()) {
    if (PROVISIONING_STEPS.has(key) || excluded.has(key)) {
      continue;
    }
    const required = CI_GATE_PLAN_IDS.get(key);
    if (!required) {
      unmapped.push(key);
      continue;
    }
    for (const id of required) {
      if (!planIds.has(id)) {
        throw new Error(
          `CI gate "${key}" maps to plan step "${id}", which pnpm check's plan does not contain.`
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

test('every mapped CI gate command remains the reviewed command', () => {
  for (const [key, expectedRun] of CI_GATE_RUNS) {
    assert.equal(
      ciRunStep(key),
      expectedRun,
      `CI gate "${key}" changed command; update its local parity mapping deliberately.`
    );
  }
  assert.equal(
    CI_GATE_RUNS.size,
    CI_GATE_PLAN_IDS.size,
    'every local parity mapping needs a command lock'
  );
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

test('every exclusion names a real CI step and carries a substantive reason', () => {
  const keys = new Set(ciRunSteps().map((step) => step.key));
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

  // Unfiltered turbo selection is the union of CI's three Unit shards, and
  // `@brainstrike/db` is a shard of its own there.
  assert.match(unit.command, /run-turbo-command\.mjs .*run test\b/);
  assert.doesNotMatch(unit.command, /--filter/);
});

test('the local unit lane mirrors CI selection semantics and cache keys', () => {
  const plan = buildPlan(parseFlags([]));
  const unit = plan.find((step) => step.id === 'unit-tests');
  const integration = plan.find((step) => step.id === 'integration-tests');

  for (const step of [unit, integration]) {
    assert.match(step.command, /TURBO_TEST_MODE=unit/, `${step.id} must share CI's test cache key`);
  }

  // CI splits the phases and caps the uncached integration lane at 2 so at
  // most two real-PGlite suites run at once; mirror both caps.
  assert.match(ciRunStep('unit-shard › Push and manual unit tests'), /--concurrency=4/);
  assert.match(ciRunStep('unit-shard › Push and manual integration tests'), /--concurrency=2/);
  assert.match(unit.command, /--concurrency=4/);
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

  for (const id of ['web-e2e-smoke', 'desktop-e2e-smoke']) {
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
  for (const id of ['browser-tests', 'web-e2e-smoke', 'desktop-e2e-smoke']) {
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

test('mode flags report every required gate they omit', () => {
  const omittedByFast = new Set(
    uncoveredCiGates(buildPlan(parseFlags(['--fast']))).map((gate) => gate.step)
  );
  for (const step of [
    'browser-tests › Run browser tests',
    'web-e2e › Run web smoke',
    'desktop-e2e › Run desktop smoke',
  ]) {
    assert.ok(omittedByFast.has(step), `--fast must disclose that it omits ${step}`);
  }

  const omittedByNoE2E = new Set(
    uncoveredCiGates(buildPlan(parseFlags(['--no-e2e']))).map((gate) => gate.step)
  );
  for (const step of ['web-e2e › Run web smoke', 'desktop-e2e › Run desktop smoke']) {
    assert.ok(omittedByNoE2E.has(step), `--no-e2e must disclose that it omits ${step}`);
  }
});

test('install and smoke lanes match CI failure semantics', () => {
  const plan = buildPlan(parseFlags([]));
  assert.equal(
    plan.find((step) => step.id === 'install')?.command,
    'pnpm -s install --frozen-lockfile'
  );
  for (const id of ['web-e2e-smoke', 'desktop-e2e-smoke']) {
    assert.match(plan.find((step) => step.id === id)?.command ?? '', /run-env\.mjs CI=true/);
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
