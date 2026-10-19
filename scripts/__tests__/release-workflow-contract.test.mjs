/**
 * Contract for the macOS legs of the desktop release workflow (BST-2148).
 *
 * Cross-built on the arm64 runner, the x64 DMG shipped arm64-only native
 * addons: pnpm installs only the host's platform packages, and node-gyp
 * compiles the workspace addons for the host. The owner's decision
 * (19 Oct 2026, option a) is that each macOS arch builds on a runner of its own
 * arch, the Native Package Matrix's darwin targets, with
 * `apps/desktop/scripts/verify-macos-addon-archs.mjs` and the signing-evidence
 * gate run per leg.
 *
 * The same file pins the owner-safe proof run: a dispatch with `unsigned`
 * builds the unsigned posture even when signing secrets exist, and no dispatch
 * ever publishes. Those checks EXECUTE the workflow's own `run:` scripts, since
 * a regex cannot see what bash decides. Every check is a function over the
 * workflow text, so each CONTROL test mutates the real file and watches the
 * check fail.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { selectNativePackageTargets } from '../native-package-targets.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRelease = () =>
  readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8');
const desktopVersion = JSON.parse(
  readFileSync(path.join(repoRoot, 'apps/desktop/package.json'), 'utf8')
).version;

const actions = (body) => `${'$'}{{ ${body} }}`;
const CREDENTIALS = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_TEAM_ID',
];

function macosJob(source) {
  const job = parseYaml(source).jobs?.['build-macos'];
  assert.ok(job, 'release.yml must define build-macos');
  return job;
}

function stepIndex(job, name) {
  const index = (job.steps ?? []).findIndex((step) => step.name === name);
  assert.ok(index >= 0, `build-macos must have a "${name}" step`);
  return index;
}

const step = (job, name) => job.steps[stepIndex(job, name)];

/** Runs a workflow step's `run:` script and returns its exit status and outputs. */
function runStep(script, env) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-contract-'));
  try {
    const output = path.join(dir, 'github-output');
    const result = spawnSync('bash', ['-e', '-c', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env, GITHUB_OUTPUT: output },
    });
    let outputs = {};
    try {
      outputs = Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split(/[=](.*)/su).slice(0, 2))
      );
    } catch {
      // A script that failed before writing any output leaves no file.
    }
    return { outputs, status: result.status, stderr: result.stderr, stdout: result.stdout };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function assertNativeMacosLegs(source) {
  const job = macosJob(source);
  const darwin = selectNativePackageTargets()
    .include.filter((target) => target.platform === 'darwin')
    .map(({ arch, os }) => ({ arch, os }));
  assert.deepEqual(
    job.strategy?.matrix?.include,
    darwin,
    'build-macos legs must be the Native Package Matrix darwin targets'
  );
  assert.equal(job['runs-on'], actions('matrix.os'), 'each macOS leg runs on its own target');

  const install = stepIndex(job, 'Setup workspace');
  const assertion = stepIndex(job, 'Assert the runner is the target');
  const build = stepIndex(job, 'Build desktop dependency graph');
  assert.ok(
    install < assertion && assertion < build,
    'the runner check must follow the install and precede the build'
  );
  const runnerCheck = step(job, 'Assert the runner is the target');
  assert.equal(runnerCheck.env?.TARGET, `darwin-${actions('matrix.arch')}`);
  const host = `${process.platform}-${process.arch}`;
  assert.equal(runStep(runnerCheck.run, { TARGET: host }).status, 0, 'the host is its own target');
  assert.notEqual(
    runStep(runnerCheck.run, { TARGET: `${host}-other` }).status,
    0,
    'a runner that is not the target must fail the leg'
  );

  const pack = step(job, 'Package DMG');
  assert.equal(pack.env?.ARCH, actions('matrix.arch'), 'Package DMG builds the leg arch');
  assert.match(pack.run, /--mac dmg --"\$ARCH" --publish never/u);
  for (const name of ['Verify signing evidence', 'Smoke-test the packaged app']) {
    assert.equal(step(job, name).env?.ARCH, actions('matrix.arch'), `${name} checks the leg's DMG`);
  }
  assert.match(
    step(job, 'Smoke-test the packaged app').run,
    /node \.\.\/scripts\/verify-macos-addon-archs\.mjs "\$APP" "\$ARCH"/u
  );
  for (const { name, run = '' } of job.steps) {
    assert.doesNotMatch(run, /--arm64|--x64|for ARCH in/u, `${name} must build only the leg arch`);
  }

  const upload = step(job, 'Upload artifacts');
  assert.equal(upload.with?.name, `release-macos-${actions('matrix.arch')}`);
  assert.match(upload.with?.path ?? '', /release-records\/macos-\$\{\{ matrix\.arch \}\}\.json/u);
  assert.match(step(job, 'Record asset metadata').run, /release-records\/macos-\$\{arch\}\.json/u);
}

function assertUnsignedProof(source) {
  const workflow = parseYaml(source);
  const input = workflow.on?.workflow_dispatch?.inputs?.unsigned;
  assert.equal(input?.type, 'boolean', 'workflow_dispatch must offer the unsigned input');
  assert.equal(input?.default, false, 'a dispatch signs unless unsigned is chosen');

  const job = macosJob(source);
  const posture = step(job, 'Resolve signing posture');
  assert.equal(posture.env?.UNSIGNED_REQUESTED, actions('inputs.unsigned == true'));
  const signed = (hasLink, unsigned) =>
    runStep(posture.run, { HAS_CSC_LINK: hasLink, UNSIGNED_REQUESTED: unsigned }).outputs.signed;
  assert.equal(signed('true', 'false'), 'true', 'CSC_LINK alone selects the signed posture');
  assert.equal(signed('true', 'true'), 'false', 'unsigned wins over configured secrets');
  assert.equal(signed('false', 'false'), 'false', 'no CSC_LINK is the unsigned posture');

  const pack = step(job, 'Package DMG');
  for (const name of CREDENTIALS) {
    assert.equal(
      pack.env?.[name],
      actions(`steps.signing.outputs.signed == 'true' && secrets.${name} || ''`),
      `Package DMG must pass ${name} only to a signed build`
    );
  }
  assert.equal(
    step(job, 'Materialise the notarization key').if,
    "steps.signing.outputs.signed == 'true'"
  );
}

function assertDispatchNeverPublishes(source) {
  const workflow = parseYaml(source);
  const resolve = workflow.jobs.context.steps.find((candidate) => candidate.id === 'resolve');
  assert.ok(resolve, 'context must resolve the release version');
  const run = (event, ref) => runStep(resolve.run, { GITHUB_EVENT_NAME: event, GITHUB_REF: ref });
  const tag = `refs/tags/v${desktopVersion}`;
  assert.equal(run('push', tag).outputs.publish, 'true', 'a version tag push publishes');
  assert.equal(run('workflow_dispatch', tag).outputs.publish, 'false', 'a dispatch on a tag');
  assert.equal(run('workflow_dispatch', 'refs/heads/main').outputs.publish, 'false');
  assert.notEqual(run('push', 'refs/tags/v0.0.0-mismatch').status, 0, 'a wrong tag fails');
  assert.equal(workflow.jobs.publish.if, "needs.context.outputs.publish == 'true'");
}

test('each macOS DMG builds, signs and is gated on a runner of its own arch', () => {
  assertNativeMacosLegs(readRelease());
});

test('an unsigned dispatch builds the unsigned posture even when signing secrets exist', () => {
  assertUnsignedProof(readRelease());
});

test('only a version tag push publishes; a dispatch never does', () => {
  assertDispatchNeverPublishes(readRelease());
});

function mutate(source, from, to) {
  const mutated = source.replace(from, to);
  assert.notEqual(mutated, source, `control mutation ${String(from)} matched nothing`);
  return mutated;
}

test('CONTROL: a cross-built leg or a leg that skips a gate fails the native-leg check', () => {
  const source = readRelease();
  const onArm = mutate(source, 'os: macos-15-intel', 'os: macos-15');
  assert.throws(() => assertNativeMacosLegs(onArm), /Native Package Matrix darwin targets/u);
  const unchecked = mutate(source, /test "\$\(node -p process\.platform\)[^\n]*\n/u, 'true\n');
  assert.throws(() => assertNativeMacosLegs(unchecked), /not the target must fail/u);
  const bothArchs = mutate(source, '--mac dmg --"$ARCH"', '--mac dmg --arm64 --x64');
  assert.throws(() => assertNativeMacosLegs(bothArchs), /--mac dmg/u);
  const ungated = mutate(source, /node \.\.\/scripts\/verify-macos-addon-archs\.mjs/u, 'true');
  assert.throws(() => assertNativeMacosLegs(ungated), /verify-macos-addon-archs/u);
});

test('CONTROL: secrets reaching an unsigned build fail the unsigned-proof check', () => {
  const source = readRelease();
  const leaked = mutate(
    source,
    actions("steps.signing.outputs.signed == 'true' && secrets.CSC_LINK || ''"),
    actions('secrets.CSC_LINK')
  );
  assert.throws(() => assertUnsignedProof(leaked), /CSC_LINK only to a signed build/u);
  const ignored = mutate(source, /if \[\[ "\$UNSIGNED_REQUESTED" == "true" \]\]/u, 'if false');
  assert.throws(() => assertUnsignedProof(ignored), /unsigned wins/u);
});

test('CONTROL: a ref-only publish decision fails the dispatch check', () => {
  const source = readRelease();
  const refOnly = mutate(source, /"\$\{GITHUB_EVENT_NAME\}" == push && /u, '');
  assert.throws(() => assertDispatchNeverPublishes(refOnly), /dispatch on a tag/u);
});
