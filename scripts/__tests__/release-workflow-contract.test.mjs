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
 * ever publishes. It also pins that a published release asset is never
 * replaced (PR #3870 review, P1): a rerun's re-signed DMGs differ in bytes, and
 * `--clobber` would swap them under a live manifest that names the old digests.
 * Publishing keeps identical assets, uploads missing ones and refuses different
 * ones, through scripts/release-asset-plan.mjs.
 *
 * BST-2190: the `resolve` job runs first and every job that checks out code
 * builds the commit it resolves, never the triggering ref. A tag push judges
 * the tagged commit and a dispatch its `sha` input as given; a dispatch without
 * one takes the newest all-green main commit. The rule itself is tested in
 * release-sha-resolution.test.mjs.
 *
 * The release builds one leg per Native Package Matrix target
 * (scripts/native-package-targets.mjs), Linux arm64 included, and every leg's
 * asset and record reach the manifest: the legs' real record steps feed the
 * publish job's real staging step and scripts/generate-release-manifest.mjs.
 * Each Linux leg runs on a Ubicloud runner of its own arch, as macOS does on
 * GitHub's.
 *
 * Those checks EXECUTE the workflow's own `run:` scripts, since a regex cannot
 * see what bash decides.
 * Every check is a function over the workflow text, so each CONTROL test
 * mutates the real file and watches the check fail.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
function runStep(script, env, cwd = repoRoot) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-contract-'));
  try {
    const output = path.join(dir, 'github-output');
    const result = spawnSync('bash', ['-e', '-c', script], {
      cwd,
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

const REPLACES_OR_DELETES =
  /--clobber|delete-asset|gh release delete|-X\s*DELETE|--method[\s=]+DELETE/iu;
const UPLOAD_STEP = 'Upload assets not yet published';
const MANIFEST_STEP = 'Publish the manifest last';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const publishedAsset = (name, text) => ({
  digest: `sha256:${sha256(text)}`,
  name,
  state: 'uploaded',
});

function publishStep(source, name) {
  const found = (parseYaml(source).jobs?.publish?.steps ?? []).find((step) => step.name === name);
  assert.ok(found, `publish must have a "${name}" step`);
  return found;
}

/**
 * Runs a publish step's real `run:` script in a scratch workspace whose `gh`
 * answers `gh api` with the given published assets and records every upload.
 */
function runPublishStep(script, { files, published }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-publish-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    mkdirSync(path.join(dir, 'assets'));
    mkdirSync(path.join(dir, 'tmp'));
    symlinkSync(path.join(repoRoot, 'scripts'), path.join(dir, 'scripts'));
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), text);
    }
    writeFileSync(path.join(dir, 'published.json'), JSON.stringify(published));
    const uploads = path.join(dir, 'uploads');
    writeFileSync(
      path.join(bin, 'gh'),
      [
        '#!/usr/bin/env bash',
        'case "$1 $2" in',
        `  "api "*) cat "${path.join(dir, 'published.json')}" ;;`,
        `  "release upload") shift 2; printf '%s\\n' "$*" >> "${uploads}" ;;`,
        '  *) echo "unexpected gh $*" >&2; exit 64 ;;',
        'esac',
      ].join('\n')
    );
    chmodSync(path.join(bin, 'gh'), 0o755);
    const result = spawnSync('bash', ['-e', '-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        GH_TOKEN: 'fake-token-for-a-stub',
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        RUNNER_TEMP: path.join(dir, 'tmp'),
        TAG: 'v0.1.0',
      },
    });
    // One entry per `gh release upload`: its tag, sorted files and trailing flags.
    const uploaded = (existsSync(uploads) ? readFileSync(uploads, 'utf8') : '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [tag, ...args] = line.split(' ');
        const flags = args.slice(args.indexOf('--repo'));
        const uploadedFiles = args.slice(0, args.indexOf('--repo')).sort();
        return [tag, ...uploadedFiles, ...flags].join(' ');
      });
    return { status: result.status, stderr: result.stderr, uploaded };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function assertNeverReplacesPublishedAssets(source) {
  assert.doesNotMatch(
    source,
    REPLACES_OR_DELETES,
    'release.yml must never replace or delete a published release asset'
  );
  const { publish } = parseYaml(source).jobs;
  for (const { name, run = '' } of publish.steps) {
    if (/gh release upload/u.test(run)) {
      assert.match(
        run,
        /node scripts\/release-asset-plan\.mjs --remote /u,
        `${name} must upload only what release-asset-plan.mjs plans`
      );
    }
  }
  const names = publish.steps.map((candidate) => candidate.name);
  assert.ok(
    names.indexOf(UPLOAD_STEP) < names.indexOf('Verify every public asset URL'),
    'assets are uploaded before their URLs are verified'
  );
  assert.equal(names.at(-1), MANIFEST_STEP, 'the manifest is published last');

  const upload = publishStep(source, UPLOAD_STEP).run;
  const files = { 'assets/a.dmg': 'A', 'assets/b.exe': 'B', 'assets/SHA256SUMS': 'sums' };
  const fresh = runPublishStep(upload, { files, published: [] });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(
    fresh.uploaded,
    [
      'v0.1.0 assets/SHA256SUMS assets/a.dmg assets/b.exe --repo seandearnaley/brainstrike-releases',
    ],
    'a first publish uploads every asset once'
  );
  const identical = Object.entries(files).map(([name, text]) =>
    publishedAsset(path.basename(name), text)
  );
  const rerun = runPublishStep(upload, { files, published: identical });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.deepEqual(rerun.uploaded, [], 'identical published assets are kept, not re-uploaded');
  const partial = runPublishStep(upload, {
    files,
    published: identical.filter((asset) => asset.name !== 'SHA256SUMS'),
  });
  assert.deepEqual(
    partial.uploaded,
    ['v0.1.0 assets/SHA256SUMS --repo seandearnaley/brainstrike-releases'],
    'a resumed publish uploads only the missing assets'
  );
  const rebuilt = runPublishStep(upload, {
    files: { ...files, 'assets/a.dmg': 'A, re-signed' },
    published: identical,
  });
  assert.notEqual(rebuilt.status, 0, 'different published bytes must fail the publish');
  assert.deepEqual(rebuilt.uploaded, [], 'and nothing is uploaded');
  assert.match(rebuilt.stderr, /new version tag/u);

  const manifest = publishStep(source, MANIFEST_STEP).run;
  const manifestFiles = { 'release-manifest.json': '{"v":2}' };
  const first = runPublishStep(manifest, { files: manifestFiles, published: identical });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(first.uploaded, [
    'v0.1.0 release-manifest.json --repo seandearnaley/brainstrike-releases',
  ]);
  const replaced = runPublishStep(manifest, {
    files: manifestFiles,
    published: [...identical, publishedAsset('release-manifest.json', '{"v":1}')],
  });
  assert.notEqual(replaced.status, 0, 'a published manifest is never replaced');
  assert.deepEqual(replaced.uploaded, []);
}

test('publishing never replaces or deletes a published asset: identical is kept, different refuses', () => {
  assertNeverReplacesPublishedAssets(readRelease());
});

test('CONTROL: --clobber, a delete or an unplanned upload fails the never-replace check', () => {
  const source = readRelease();
  const clobber = mutate(
    source,
    /gh release upload "\$TAG" "\$\{FILES\[@\]\}" --repo seandearnaley\/brainstrike-releases/u,
    '$& --clobber'
  );
  assert.throws(() => assertNeverReplacesPublishedAssets(clobber), /never replace or delete/u);
  const deletes = mutate(
    source,
    /(\n {10}set -euo pipefail\n)(?= {10}# A published asset)/u,
    '$1          gh release delete-asset "$TAG" a.dmg --yes\n'
  );
  assert.throws(() => assertNeverReplacesPublishedAssets(deletes), /never replace or delete/u);
  const unplanned = mutate(
    source,
    /UPLOAD=\$\(node scripts\/release-asset-plan\.mjs --remote "\$PUBLISHED" assets\/\*\)/u,
    'UPLOAD=$(printf "%s\\n" assets/*)'
  );
  assert.throws(
    () => assertNeverReplacesPublishedAssets(unplanned),
    /must upload only what release-asset-plan\.mjs plans/u
  );
});

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

// --- BST-2190: the release builds only a commit every required nightly passed

const RESOLVED_SHA = actions('needs.resolve.outputs.sha');
const RESOLVER_SHA = 'e'.repeat(40);
const needsOf = (job) => [job.needs ?? []].flat();

/**
 * Runs the resolve step's real `run:` script in a scratch workspace whose
 * scripts/resolve-release-sha.mjs records its arguments, then prints
 * `sha=RESOLVER_SHA`, prints `prints` instead, or exits with `exit`.
 */
function runResolveStep(script, env, { exit, prints = `sha=${RESOLVER_SHA}\n` } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-resolve-'));
  try {
    mkdirSync(path.join(dir, 'scripts'));
    const record = path.join(dir, 'argv.json');
    writeFileSync(
      path.join(dir, 'scripts', 'resolve-release-sha.mjs'),
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));`,
        exit === undefined
          ? `process.stdout.write(${JSON.stringify(prints)});`
          : `process.exit(${exit});`,
      ].join('\n')
    );
    const result = runStep(script, env, dir);
    const argv = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : undefined;
    return { ...result, argv };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function assertResolvesTheReleaseSha(source) {
  const workflow = parseYaml(source);
  const input = workflow.on?.workflow_dispatch?.inputs?.sha;
  assert.equal(input?.type, 'string', 'workflow_dispatch must offer the optional sha input');
  assert.equal(input?.required, false, 'the sha input is optional');
  assert.equal(input?.default, '', 'an empty sha applies the newest-green rule');

  const resolve = workflow.jobs?.resolve;
  assert.ok(resolve, 'release.yml must define the resolve job');
  assert.deepEqual(needsOf(resolve), [], 'resolve runs first');
  assert.deepEqual(resolve.permissions, { actions: 'read', contents: 'read' });
  assert.equal(resolve.outputs?.sha, actions('steps.resolve.outputs.sha'));
  const resolveStep = (resolve.steps ?? []).find((candidate) => candidate.id === 'resolve');
  assert.ok(resolveStep, 'resolve must have a step with id resolve');
  assert.equal(resolveStep.env?.GIVEN_SHA, actions('inputs.sha'));
  assert.equal(resolveStep.env?.GITHUB_TOKEN, actions('github.token'));

  const tag = 'refs/tags/v1.2.3';
  const given = 'f'.repeat(40);
  const push = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: tag };
  const dispatch = (sha) => ({
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GIVEN_SHA: sha,
  });
  const pushed = runResolveStep(resolveStep.run, push);
  assert.deepEqual(pushed.argv, ['--given', tag], 'a tag push judges the tagged commit as given');
  assert.equal(pushed.outputs.sha, RESOLVER_SHA, pushed.stderr);
  assert.deepEqual(runResolveStep(resolveStep.run, dispatch(given)).argv, ['--given', given]);
  assert.deepEqual(
    runResolveStep(resolveStep.run, dispatch('')).argv,
    ['--newest-green', '--lookback-days', '14'],
    'a dispatch without sha takes the newest all-green main commit'
  );
  assert.notEqual(
    runResolveStep(resolveStep.run, { GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: tag }).status,
    0,
    'any other event fails'
  );
  const refused = runResolveStep(resolveStep.run, push, { exit: 1 });
  assert.notEqual(refused.status, 0, 'a refusal fails the release');
  assert.equal(refused.outputs.sha, undefined, 'and resolves no SHA');
  const silent = runResolveStep(resolveStep.run, push, { prints: '' });
  assert.notEqual(
    silent.status,
    0,
    'a resolver that printed no SHA must fail, or every checkout would build the triggering ref'
  );
  assert.equal(silent.outputs.sha, undefined);
}

function assertBuildsOnlyTheResolvedSha(source) {
  const { jobs } = parseYaml(source);
  for (const [id, job] of Object.entries(jobs)) {
    const checkouts = (job.steps ?? []).filter((candidate) =>
      /^actions\/checkout@/u.test(candidate.uses ?? '')
    );
    if (id === 'resolve' || checkouts.length === 0) {
      continue;
    }
    assert.ok(needsOf(job).includes('resolve'), `${id} must need resolve to read the resolved SHA`);
    for (const checkout of checkouts) {
      assert.equal(
        checkout.with?.ref,
        RESOLVED_SHA,
        `${id} must check out the resolved SHA, never the triggering ref`
      );
    }
  }
  for (const name of [
    'Create release in the public binaries repo',
    'Generate manifest from upload records',
  ]) {
    assert.equal(publishStep(source, name).env?.SOURCE_COMMIT, RESOLVED_SHA, name);
  }
  assert.match(
    publishStep(source, 'Generate manifest from upload records').run,
    /--source-commit "\$\{SOURCE_COMMIT\}"/u
  );
  assert.doesNotMatch(
    source,
    /GITHUB_SHA|github\.sha/u,
    'release.yml must record the resolved SHA, never the triggering commit'
  );
}

test('the release resolves its commit first: a tag or sha is judged as given, else the newest all-green main commit', () => {
  assertResolvesTheReleaseSha(readRelease());
});

test('every job that checks out code builds the resolved SHA and records it as the source commit', () => {
  assertBuildsOnlyTheResolvedSha(readRelease());
});

test('CONTROL: a tag judged by the default rule or an unvalidated resolver output fails the resolve check', () => {
  const source = readRelease();
  const tagByDefault = mutate(
    source,
    /push\) ARGS=\(--given "\$\{GITHUB_REF\}"\) ;;/u,
    'push) ARGS=(--newest-green --lookback-days 14) ;;'
  );
  assert.throws(() => assertResolvesTheReleaseSha(tagByDefault), /judges the tagged commit/u);
  const unvalidated = mutate(source, /\n *\[\[ "\$RESOLVED" =~ [^\n]*\n/u, '\n');
  assert.throws(() => assertResolvesTheReleaseSha(unvalidated), /printed no SHA must fail/u);
});

test('CONTROL: a leg on the triggering ref or a manifest naming GITHUB_SHA fails the resolved-SHA check', () => {
  const source = readRelease();
  const triggering = mutate(
    source,
    /(name: Build Windows \(x64\)[\s\S]*?uses: actions\/checkout@v6\n) {8}with:\n {10}ref: [^\n]*\n/u,
    '$1'
  );
  assert.throws(
    () => assertBuildsOnlyTheResolvedSha(triggering),
    /build-windows must check out the resolved SHA/u
  );
  const shellVar = (name) => `${'$'}{${name}}`;
  const githubSha = mutate(
    source,
    `Source commit: ${shellVar('SOURCE_COMMIT')}`,
    `Source commit: ${shellVar('GITHUB_SHA')}`
  );
  assert.throws(() => assertBuildsOnlyTheResolvedSha(githubSha), /never the triggering commit/u);
});

// --- One release leg per Native Package Matrix target, each in the manifest --

const MANIFEST_PLATFORM = { darwin: 'macos', linux: 'linux', win32: 'windows' };
const ASSET_EXTENSION = { darwin: 'dmg', linux: 'AppImage', win32: 'exe' };
const BUILD_JOB = { darwin: 'build-macos', linux: 'build-linux', win32: 'build-windows' };
const RELEASE_VERSION = '1.2.3';
const targetKey = ({ arch, platform }) => `${platform}-${arch}`;
const assetName = ({ arch, platform }) =>
  `Brainstrike-${RELEASE_VERSION}-${MANIFEST_PLATFORM[platform]}-${arch}.${ASSET_EXTENSION[platform]}`;

/** release.yml's build legs: one per matrix entry, or one for a job without a matrix. */
function releaseLegs(source) {
  const { jobs } = parseYaml(source);
  return Object.entries(BUILD_JOB).flatMap(([platform, id]) => {
    const job = jobs?.[id];
    assert.ok(job, `release.yml must define ${id}`);
    const include = job.strategy?.matrix?.include;
    if (include !== undefined) {
      return include.map((matrix) => ({ arch: matrix.arch, id, job, matrix, platform }));
    }
    // A job without a matrix builds the one arch its packaging command names.
    const arch = (job.steps ?? [])
      .map(({ run = '' }) => /run dist --\w+ \w+ --(\w+) --publish never/u.exec(run)?.[1])
      .find(Boolean);
    return [{ arch, id, job, matrix: {}, platform }];
  });
}

const legStep = (leg, name) => {
  const found = (leg.job.steps ?? []).find((candidate) => candidate.name === name);
  assert.ok(found, `${leg.id} must have a "${name}" step`);
  return found;
};

/** Substitutes the `${{ }}` expressions a step uses; an unknown one fails the check. */
function renderExpressions(text, values) {
  return String(text).replace(/\$\{\{\s*(.+?)\s*\}\}/gu, (_, expression) => {
    assert.ok(Object.hasOwn(values, expression), `no test value for the expression ${expression}`);
    return values[expression];
  });
}

function legValues(leg) {
  return {
    'needs.context.outputs.version': RELEASE_VERSION,
    ...Object.fromEntries(
      Object.entries(leg.matrix).map(([key, value]) => [`matrix.${key}`, String(value)])
    ),
  };
}

/** Runs a leg's step with its expressions and env rendered for that leg. */
function runLegStep(leg, name, cwd, extraEnv = {}) {
  const found = legStep(leg, name);
  const values = legValues(leg);
  const env = Object.fromEntries(
    Object.entries(found.env ?? {}).map(([key, value]) => [key, renderExpressions(value, values)])
  );
  return spawnSync('bash', ['-e', '-c', renderExpressions(found.run, values)], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env, ...extraEnv },
  });
}

/**
 * Every Native Package Matrix target is one release leg. Each leg records and
 * uploads its own asset; download-artifact's merge-multiple puts every leg's
 * upload in one tree, where a shared path would keep only one copy. The publish
 * job's staging step and scripts/generate-release-manifest.mjs then run on that
 * tree, and the manifest must name one asset per target.
 */
function assertEveryTargetIsReleased(source) {
  const legs = releaseLegs(source);
  const targets = selectNativePackageTargets().include;
  assert.deepEqual(
    legs.map(targetKey).sort(),
    targets.map(targetKey).sort(),
    'release.yml must build one leg per Native Package Matrix target'
  );
  const dir = mkdtempSync(path.join(tmpdir(), 'release-legs-'));
  try {
    const publish = path.join(dir, 'publish');
    for (const leg of legs) {
      const label = `${leg.id} (${leg.arch})`;
      const work = path.join(dir, targetKey(leg));
      const release = path.join(work, 'apps', 'desktop', 'release');
      mkdirSync(release, { recursive: true });
      writeFileSync(path.join(release, assetName(leg)), `${label} bytes`);
      const record = runLegStep(leg, 'Record asset metadata', work);
      assert.equal(record.status, 0, `${label} must record ${assetName(leg)}: ${record.stderr}`);
      const upload = legStep(leg, 'Upload artifacts');
      const patterns = renderExpressions(upload.with?.path, legValues(leg))
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      for (const pattern of patterns) {
        const files = globSync(pattern, { cwd: work });
        assert.ok(files.length > 0, `${label} uploads nothing for ${pattern}`);
        for (const file of files) {
          const merged = path.join(publish, 'staging', file);
          assert.ok(
            !existsSync(merged),
            `${label} uploads ${file}, which another leg also uploads; the merged download keeps only one`
          );
          mkdirSync(path.dirname(merged), { recursive: true });
          copyFileSync(path.join(work, file), merged);
        }
      }
    }
    const stage = runStep(publishStep(source, 'Stage assets and checksums').run, {}, publish);
    assert.equal(stage.status, 0, `publish must stage one asset per target: ${stage.stdout}`);
    const generated = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts', 'generate-release-manifest.mjs'),
        ...['--tag', `v${RELEASE_VERSION}`, '--source-commit', 'a'.repeat(40)],
        ...['--records-dir', 'release-records', '--out', 'release-manifest.json'],
      ],
      { cwd: publish, encoding: 'utf8' }
    );
    assert.equal(generated.status, 0, generated.stderr);
    const manifest = JSON.parse(readFileSync(path.join(publish, 'release-manifest.json'), 'utf8'));
    assert.deepEqual(
      manifest.latest.assets
        .map(({ architecture, name, platform }) => `${platform} ${architecture} ${name}`)
        .sort(),
      targets
        .map(
          (target) => `${MANIFEST_PLATFORM[target.platform]} ${target.arch} ${assetName(target)}`
        )
        .sort(),
      'the manifest must name one asset per target'
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/** Runs a leg's packaging step with a `pnpm` stub and returns the argv it received. */
function packagingArgv(leg, name) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-pack-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const record = path.join(dir, 'argv.json');
    writeFileSync(
      path.join(bin, 'pnpm'),
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`
    );
    chmodSync(path.join(bin, 'pnpm'), 0o755);
    const result = runLegStep(leg, name, dir, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(record, 'utf8'));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/**
 * Each Linux leg runs on a Ubicloud runner of its own arch (the header's
 * placement), asserts that runner is its target before building, and packages
 * an AppImage named for its arch: linux.artifactName pins the x64 literal,
 * because electron-builder's ${arch} macro names an x64 AppImage x86_64.
 */
function assertNativeLinuxLegs(source) {
  const legs = releaseLegs(source).filter(({ platform }) => platform === 'linux');
  const job = legs[0]?.job;
  assert.ok(job?.strategy?.matrix?.include, 'build-linux must build one matrix leg per arch');
  assert.equal(job['runs-on'], actions('matrix.runner'), 'each Linux leg runs on its own runner');
  assert.equal(job.strategy['fail-fast'], false, 'one failing Linux leg must not cancel the other');
  for (const leg of legs) {
    const arm = leg.arch === 'arm64';
    assert.match(
      leg.matrix.runner ?? '',
      arm ? /^ubicloud-standard-\d+-arm$/u : /^ubicloud-standard-\d+$/u,
      `the ${leg.arch} Linux leg must run on a Ubicloud ${leg.arch} runner`
    );
  }
  const names = job.steps.map((candidate) => candidate.name);
  const check = names.indexOf('Assert the runner is the target');
  assert.ok(
    names.indexOf('Setup workspace') < check &&
      check < names.indexOf('Build desktop dependency graph'),
    'the Linux runner check must follow the install and precede the build'
  );
  const runnerCheck = legStep(legs[0], 'Assert the runner is the target');
  assert.equal(runnerCheck.env?.TARGET, `linux-${actions('matrix.arch')}`);
  const host = `${process.platform}-${process.arch}`;
  assert.equal(runStep(runnerCheck.run, { TARGET: host }).status, 0, 'the host is its own target');
  assert.notEqual(
    runStep(runnerCheck.run, { TARGET: `${host}-other` }).status,
    0,
    'a Linux runner that is not the target must fail the leg'
  );
  for (const leg of legs) {
    const argv = packagingArgv(leg, 'Package AppImage');
    assert.ok(argv.includes(`--${leg.arch}`), `the ${leg.arch} leg must package ${leg.arch}`);
    const override = argv.find((arg) => arg.startsWith('--config.linux.artifactName='));
    assert.ok(override, `the ${leg.arch} leg must name its AppImage for its arch`);
    const expanded = override
      .slice('--config.linux.artifactName='.length)
      .replaceAll(`${'$'}{version}`, RELEASE_VERSION)
      .replaceAll(`${'$'}{ext}`, 'AppImage');
    assert.equal(expanded, assetName(leg), `the ${leg.arch} leg must package the asset it records`);
    assert.equal(legStep(leg, 'Smoke-test AppImage').env?.ARCH, actions('matrix.arch'));
    assert.match(
      legStep(leg, 'Smoke-test AppImage').run,
      /APPIMAGE="apps\/desktop\/release\/Brainstrike-\$\{VERSION\}-linux-\$\{ARCH\}\.AppImage"/u
    );
  }
}

test('the release builds one leg per Native Package Matrix target, and the manifest names each asset', () => {
  assertEveryTargetIsReleased(readRelease());
});

test('each Linux AppImage builds on a Ubicloud runner of its own arch and is named for it', () => {
  assertNativeLinuxLegs(readRelease());
});

test('CONTROL: a dropped Linux arm64 leg or a shared record name fails the every-target check', () => {
  const source = readRelease();
  const noArm = mutate(source, /\n {10}- arch: arm64\n {12}runner: [^\n]*/u, '');
  assert.throws(
    () => assertEveryTargetIsReleased(noArm),
    /one leg per Native Package Matrix target/u
  );
  const sharedUpload = mutate(
    source,
    /release-records\/linux-\$\{\{ matrix\.arch \}\}\.json/u,
    'release-records/linux.json'
  );
  const shared = mutate(
    sharedUpload,
    /release-records\/linux-\$\{arch\}\.json/u,
    'release-records/linux.json'
  );
  assert.throws(() => assertEveryTargetIsReleased(shared), /another leg also uploads/u);
});

test('CONTROL: an AppImage not named for its arch or a cross-arch runner fails the Linux-leg check', () => {
  const source = readRelease();
  const pinned = mutate(
    source,
    /'Brainstrike-\$\{version\}-linux-'"\$ARCH"'\.\$\{ext\}'/u,
    `'Brainstrike-${'$'}{version}-linux-x64.${'$'}{ext}'`
  );
  assert.throws(() => assertNativeLinuxLegs(pinned), /must package the asset it records/u);
  const onX64 = mutate(source, 'runner: ubicloud-standard-4-arm', 'runner: ubicloud-standard-4');
  assert.throws(() => assertNativeLinuxLegs(onX64), /Ubicloud arm64 runner/u);
});

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
