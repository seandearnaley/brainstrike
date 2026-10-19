import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { selectNativePackageTargets } from '../native-package-targets.mjs';

/**
 * BST-2190: the nightly runs the desktop smoke lane against the PACKAGED app on
 * macOS (macos-15, arm64) and Windows (windows-2025, x64). It runs inside the
 * native-package-matrix leg that packaged the app, after packaging (and the
 * macOS ad-hoc signing), so it qualifies that leg's own `apps/desktop/release`
 * output rather than a dev build or a rebuilt copy. Failed runs upload their
 * Playwright traces.
 *
 * Each check is a function over the workflow text and the target list, so the
 * CONTROL tests can mutate the real inputs and watch the check fail.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = '.github/workflows/native-package-matrix.yml';
const HARNESS_TARGET = 'apps/desktop/e2e/utils/desktop-e2e-target.ts';
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');
const expression = (body) => `${'$'}{{ ${body} }}`;

const PACKAGED_SMOKE_OSES = ['macos-15', 'windows-2025'];
const PACKAGE_STEP = 'Package the desktop application';
const SIGN_STEP = 'Ad-hoc sign with the hardened runtime (macOS)';
const REBUILDS = /\brun (?:pack|build)\b|run-turbo-command|electron-builder/u;

/** The variable the harness reads, from its own source, so a rename on either side fails. */
function harnessTargetVariable(source) {
  const match = source.match(/export const DESKTOP_E2E_TARGET_ENV = '([A-Z0-9_]+)';/u);
  assert.ok(match, `${HARNESS_TARGET} must export DESKTOP_E2E_TARGET_ENV`);
  return match[1];
}

function assertTargets(targets) {
  for (const target of targets) {
    assert.equal(typeof target.desktopSmoke, 'boolean', `${target.os} must say desktopSmoke`);
  }
  assert.deepEqual(
    targets.filter((target) => target.desktopSmoke).map((target) => target.os),
    PACKAGED_SMOKE_OSES,
    'exactly macOS arm64 and Windows x64 run the packaged desktop smoke'
  );
}

function assertWorkflow(source, targetVariable) {
  const steps = parse(source).jobs.smoke.steps;
  const index = (name) => {
    const at = steps.findIndex((step) => step.name === name);
    assert.ok(at >= 0, `${WORKFLOW} › smoke has no "${name}" step`);
    return at;
  };
  const packaged = index(PACKAGE_STEP);
  const signed = index(SIGN_STEP);

  const lanes = steps.filter((step) => /\btest:e2e:/u.test(String(step.run ?? '')));
  assert.equal(lanes.length, 1, `${WORKFLOW} › smoke runs one desktop E2E lane`);
  const [lane] = lanes;
  const at = steps.indexOf(lane);
  assert.equal(lane.run, 'pnpm --filter @brainstrike/desktop run test:e2e:lane:smoke');
  assert.equal(lane.if, expression('matrix.desktopSmoke'), 'only the flagged targets run it');
  assert.equal(
    lane.env?.[targetVariable],
    'packaged',
    `the lane launches the packaged app (${targetVariable}=packaged)`
  );
  assert.ok(at > packaged && at > signed, 'the lane runs on the packaged, signed app');
  for (const step of steps.slice(packaged + 1, at + 1)) {
    assert.doesNotMatch(
      String(step.run ?? ''),
      REBUILDS,
      `${step.name} must not rebuild what the lane qualifies`
    );
  }

  const traces = steps.find(
    (step) =>
      String(step.uses ?? '').startsWith('actions/upload-artifact@') &&
      String(step.with?.path ?? '').includes('apps/desktop/test-results/')
  );
  assert.ok(traces, 'a failed lane uploads its Playwright traces');
  assert.ok(steps.indexOf(traces) > at, 'traces upload after the lane');
  assert.equal(traces.if, expression('failure() && matrix.desktopSmoke'));
  assert.match(String(traces.with.path), /apps\/desktop\/blob-report\//u);
  assert.match(String(traces.with.name), /\$\{\{ matrix\.os \}\}/u, 'one artifact per target');
}

const EXCLUSIONS = 'apps/desktop/e2e/utils/windows-smoke-exclusions.ts';
const WINDOWS_FIXME =
  /test\.(?:fixme|skip)\(\s*process\.platform === 'win32',\s*WINDOWS_SMOKE_EXCLUSIONS\.(\w+)\s*\)/gu;

/** The smoke lane's spec files, from its own script. */
function smokeLaneSpecs() {
  const { scripts } = JSON.parse(read('apps/desktop/package.json'));
  return scripts['test:e2e:lane:smoke'].match(/e2e\/\S+\.test\.ts/gu);
}

/**
 * Every Windows exclusion is a named entry with its reason, and every entry is
 * used: a smoke spec can skip on Windows only through the list.
 */
function assertWindowsExclusions(listSource, specSources) {
  const listed = [...listSource.matchAll(/^ {2}(\w+):/gmu)].map((match) => match[1]).sort();
  const used = new Set();
  for (const [file, source] of specSources) {
    for (const match of source.matchAll(WINDOWS_FIXME)) {
      used.add(match[1]);
    }
    const unlisted = source.replaceAll(WINDOWS_FIXME, '');
    assert.doesNotMatch(
      unlisted,
      /test\.(?:fixme|skip)\([^)]*win32/u,
      `${file} skips on Windows outside ${EXCLUSIONS}`
    );
  }
  assert.deepEqual([...used].sort(), listed, `every ${EXCLUSIONS} entry is used, and only those`);
}

test('macOS arm64 and Windows x64 are the packaged desktop smoke targets', () => {
  assertTargets(selectNativePackageTargets().include);
});

test('each flagged leg runs the smoke lane on the app it packaged, and keeps traces', () => {
  assertWorkflow(read(WORKFLOW), harnessTargetVariable(read(HARNESS_TARGET)));
});

test('the smoke lane skips on Windows only through the named exclusion list', () => {
  const specs = smokeLaneSpecs().map((file) => [file, read(`apps/desktop/${file}`)]);
  assertWindowsExclusions(read(EXCLUSIONS), specs);
});

function mutate(source, from, to) {
  const mutated = source.replace(from, to);
  assert.notEqual(mutated, source, `control mutation ${String(from)} matched nothing`);
  return mutated;
}

test('CONTROL: dropping either platform FAILS this contract', () => {
  for (const os of PACKAGED_SMOKE_OSES) {
    const targets = selectNativePackageTargets().include.map((target) =>
      target.os === os ? { ...target, desktopSmoke: false } : target
    );
    assert.throws(() => assertTargets(targets), /exactly macOS arm64 and Windows x64/u);
  }
});

test('CONTROL: a lane that launches the dev build FAILS this contract', () => {
  const variable = harnessTargetVariable(read(HARNESS_TARGET));
  const mutated = mutate(read(WORKFLOW), `${variable}: packaged`, `${variable}: dev`);
  assert.throws(() => assertWorkflow(mutated, variable), /launches the packaged app/u);
  assert.throws(
    () => assertWorkflow(read(WORKFLOW), 'BRAINSTRIKE_E2E_RENAMED_TARGET'),
    /launches the packaged app/u
  );
});

test('CONTROL: a lane that runs before packaging FAILS this contract', () => {
  const variable = harnessTargetVariable(read(HARNESS_TARGET));
  const workflow = parse(read(WORKFLOW));
  const steps = workflow.jobs.smoke.steps;
  const lane = steps.find((step) => /\btest:e2e:/u.test(String(step.run ?? '')));
  steps.splice(steps.indexOf(lane), 1);
  steps.splice(
    steps.findIndex((step) => step.name === PACKAGE_STEP),
    0,
    lane
  );
  // JSON is YAML, so the reordered workflow parses back unchanged otherwise.
  assert.throws(() => assertWorkflow(JSON.stringify(workflow), variable), /packaged, signed app/u);
});

test('CONTROL: a rebuild between packaging and the lane FAILS this contract', () => {
  const variable = harnessTargetVariable(read(HARNESS_TARGET));
  const workflow = parse(read(WORKFLOW));
  const steps = workflow.jobs.smoke.steps;
  const lane = steps.find((step) => /\btest:e2e:/u.test(String(step.run ?? '')));
  steps.splice(steps.indexOf(lane), 0, {
    name: 'Rebuild',
    run: 'pnpm --filter @brainstrike/desktop run build',
  });
  assert.throws(
    () => assertWorkflow(JSON.stringify(workflow), variable),
    /must not rebuild what the lane qualifies/u
  );
});

test('CONTROL: traces uploaded on every leg, or not at all, FAIL this contract', () => {
  const variable = harnessTargetVariable(read(HARNESS_TARGET));
  const source = read(WORKFLOW);
  const everyLeg = mutate(
    source,
    `if: ${expression('failure() && matrix.desktopSmoke')}`,
    'if: failure()'
  );
  assert.throws(() => assertWorkflow(everyLeg, variable));
  const workflow = parse(source);
  workflow.jobs.smoke.steps = workflow.jobs.smoke.steps.filter(
    (step) => !String(step.with?.path ?? '').includes('apps/desktop/test-results/')
  );
  assert.throws(
    () => assertWorkflow(JSON.stringify(workflow), variable),
    /uploads its Playwright traces/u
  );
});

test('CONTROL: an unlisted Windows skip, or an unused exclusion, FAILS this contract', () => {
  const specs = smokeLaneSpecs().map((file) => [file, read(`apps/desktop/${file}`)]);
  const [[file, source], ...rest] = specs;
  const unlisted = [
    [file, `${source}\ntest.skip(process.platform === 'win32', 'flaky on Windows');\n`],
    ...rest,
  ];
  assert.throws(
    () => assertWindowsExclusions(read(EXCLUSIONS), unlisted),
    /skips on Windows outside/u
  );
  const unused = mutate(
    read(EXCLUSIONS),
    '} as const;',
    "  unusedEntry: 'never used',\n} as const;"
  );
  assert.throws(() => assertWindowsExclusions(unused, specs), /every .* entry is used/u);
});
