/**
 * Contract for the Native Windows node-gyp header cache (BST-1375).
 *
 * The `native-windows` job installs TWO packages that build native addons and
 * neither ships headers, so a cold `pnpm install` has both processes fetching
 * the same ~30MB `node-vX-headers.tar.gz` from nodejs.org concurrently — pnpm
 * runs workspace install scripts in parallel. Twice in 290 attempts one of
 * those two streams returned HTTP 200 and was then aborted mid-body (undici
 * `Fetch.onAborted`), failing `Setup workspace` outright. Restoring node-gyp's
 * dev dir removes the download instead of hardening it: `--ensure` finds the
 * headers and reports "version is good" without issuing a single request.
 *
 * That fix is FOUR separate pieces of wiring, and any one of them silently
 * un-does it — a restore placed after the install prevents nothing, a save key
 * that omits the resolved Node version pins the cache to a stale version
 * forever, and a composite that stops exporting the version turns the save key
 * into the restore prefix, which then EXACT-matches and shadows the good entry.
 * None of those failures are visible in CI: the job just goes back to
 * downloading twice and flaking at the old rate. This test is what notices.
 *
 * Every assertion has a CONTROL below that breaks exactly that piece and
 * requires the check to fail — an instrument that cannot fail is not evidence.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readWorkflow() {
  return parseYaml(readFileSync(path.join(repoRoot, '.github/workflows/test.yml'), 'utf8'));
}

function readComposite() {
  return parseYaml(
    readFileSync(path.join(repoRoot, '.github/actions/setup-workspace/action.yml'), 'utf8')
  );
}

const usesPrefix = (step, prefix) => typeof step.uses === 'string' && step.uses.startsWith(prefix);

/**
 * @throws if the header cache is not wired end to end
 */
function assertHeaderCacheContract(workflow, composite) {
  const job = workflow?.jobs?.['native-windows'];
  assert.ok(job, 'test.yml must define the native-windows job');

  // node-gyp's default dev dir is under %LOCALAPPDATA%, which no cache step can
  // name portably. Pinning it is what makes the directory addressable at all.
  const devdir = job.env?.npm_config_devdir;
  assert.ok(
    devdir,
    'the native-windows job must pin npm_config_devdir for the cache steps to name'
  );

  const steps = job.steps ?? [];
  const restoreIndex = steps.findIndex((step) => usesPrefix(step, 'actions/cache/restore@'));
  const setupIndex = steps.findIndex(
    (step) => typeof step.uses === 'string' && step.uses.includes('setup-workspace')
  );
  const saveIndex = steps.findIndex((step) => usesPrefix(step, 'actions/cache/save@'));

  assert.notEqual(restoreIndex, -1, 'the node-gyp header restore step is gone');
  assert.notEqual(
    setupIndex,
    -1,
    'the native-windows job must still use the setup-workspace action'
  );
  assert.notEqual(saveIndex, -1, 'the node-gyp header save step is gone');

  // ORDERING IS THE FIX. setup-workspace ends in `pnpm install`, which is where
  // node-gyp downloads; a restore placed after it prevents nothing at all.
  assert.ok(
    restoreIndex < setupIndex,
    'the header restore must run BEFORE Setup workspace — the download happens inside its `pnpm install`'
  );
  assert.ok(
    saveIndex > setupIndex,
    'the header save must run AFTER the install that populates the dir'
  );

  assert.equal(
    steps[restoreIndex].with?.path,
    devdir,
    'the restore must target the pinned npm_config_devdir, or it warms a directory node-gyp never reads'
  );
  assert.equal(
    steps[saveIndex].with?.path,
    devdir,
    'the save must target the pinned npm_config_devdir, or it stores the wrong directory'
  );

  const restoreKey = String(steps[restoreIndex].with?.key ?? '');
  const saveKey = String(steps[saveIndex].with?.key ?? '');

  // `.nvmrc` pins a MAJOR, so the exact version is unknown until setup-node has
  // run — which is inside the composite, after this step.
  assert.ok(
    !restoreKey.includes('node-version'),
    'the restore key cannot reference the resolved Node version; setup-node has not run yet'
  );
  assert.ok(
    String(steps[restoreIndex].with?.['restore-keys'] ?? '').trim().length > 0,
    'the restore needs restore-keys, or a Node patch bump can never warm-start from the previous entry'
  );

  const setupId = steps[setupIndex].id;
  assert.ok(setupId, 'the Setup workspace step needs an `id` so the save key can read its output');
  assert.ok(
    saveKey.includes(`steps.${setupId}.outputs.node-version`),
    'the save key must carry the RESOLVED Node version, or a patch bump hits the old key forever and the cache silently stops covering the version in use'
  );
  assert.ok(
    saveKey.startsWith(restoreKey),
    'the save key must extend the restore prefix, or restore-keys can never find what was saved'
  );
  // Without this guard a failed setup writes an entry under the bare prefix,
  // which EXACT-matches later restores and shadows the good version-keyed one.
  assert.match(
    String(steps[saveIndex].if ?? ''),
    new RegExp(`steps\\.${setupId}\\.outputs\\.node-version\\s*!=\\s*''`),
    'the save must refuse to run with an empty node-version, or it poisons the restore prefix'
  );
  // The empty-version guard only covers failure BEFORE setup-node resolves a
  // version. The header download runs later, inside the composite's install
  // step, and composite outputs survive a later embedded step's failure — so
  // node-version is non-empty on exactly the runs where node-gyp's rollback
  // has deleted only the NEW version dir and left a cross-version restore in
  // the devdir. Cache keys are immutable: `always()` would archive that older
  // tree under the new exact key, restore-keys would prefer it (newest) from
  // then on, and no later run could repair it until the next patch bump.
  assert.match(
    String(steps[saveIndex].if ?? ''),
    new RegExp(`steps\\.${setupId}\\.outcome\\s*==\\s*'success'`),
    'the save must refuse to run when Setup workspace failed, or a cross-version restore is archived under the new immutable exact key'
  );

  const outputValue = composite?.outputs?.['node-version']?.value;
  assert.ok(
    outputValue,
    'setup-workspace must expose node-version; the save key above reads it as a step output'
  );
  const referenced = /steps\.([A-Za-z0-9_-]+)\.outputs\.node-version/.exec(String(outputValue));
  assert.ok(referenced, `the composite output must read a step output, got: ${outputValue}`);
  const sourceStep = (composite?.runs?.steps ?? []).find((step) => step.id === referenced[1]);
  assert.ok(
    sourceStep,
    `the composite output references step id "${referenced[1]}", which no step declares`
  );
  assert.match(
    String(sourceStep.uses ?? ''),
    /^actions\/setup-node@/,
    'the node-version output must come from setup-node, the only step that resolves it'
  );
}

test('the Native Windows node-gyp header cache is wired end to end', () => {
  assertHeaderCacheContract(readWorkflow(), readComposite());
});

test('CONTROL: a restore placed after the install FAILS the contract', () => {
  const workflow = structuredClone(readWorkflow());
  const steps = workflow.jobs['native-windows'].steps;
  const restoreIndex = steps.findIndex((step) => usesPrefix(step, 'actions/cache/restore@'));
  const [restore] = steps.splice(restoreIndex, 1);
  steps.push(restore);
  assert.throws(
    () => assertHeaderCacheContract(workflow, readComposite()),
    /must run BEFORE Setup workspace/,
    'a restore that cannot prevent the download must not pass'
  );
});

test('CONTROL: a save key without the resolved Node version FAILS the contract', () => {
  const workflow = structuredClone(readWorkflow());
  const steps = workflow.jobs['native-windows'].steps;
  const save = steps.find((step) => usesPrefix(step, 'actions/cache/save@'));
  const restore = steps.find((step) => usesPrefix(step, 'actions/cache/restore@'));
  save.with.key = restore.with.key;
  assert.throws(
    () => assertHeaderCacheContract(workflow, readComposite()),
    /RESOLVED Node version/,
    'a version-blind save key pins the cache to a stale Node forever and must not pass'
  );
});

test('CONTROL: dropping the empty-version guard FAILS the contract', () => {
  const workflow = structuredClone(readWorkflow());
  const save = workflow.jobs['native-windows'].steps.find((step) =>
    usesPrefix(step, 'actions/cache/save@')
  );
  save.if = 'always()';
  assert.throws(
    () => assertHeaderCacheContract(workflow, readComposite()),
    /poisons the restore prefix/,
    'a save that can write the bare prefix must not pass'
  );
});

test('CONTROL: dropping the setup-outcome guard FAILS the contract', () => {
  const workflow = structuredClone(readWorkflow());
  const steps = workflow.jobs['native-windows'].steps;
  const save = steps.find((step) => usesPrefix(step, 'actions/cache/save@'));
  const setupId = steps.find((step) => usesPrefix(step, './.github/actions/setup-workspace'))?.id;
  save.if = `always() && steps.${setupId}.outputs.node-version != ''`;
  assert.throws(
    () => assertHeaderCacheContract(workflow, readComposite()),
    /archived under the new immutable exact key/,
    'a save that still runs after a failed setup must not pass'
  );
});

test('CONTROL: a composite that stops exporting node-version FAILS the contract', () => {
  const composite = structuredClone(readComposite());
  composite.outputs = undefined;
  assert.throws(
    () => assertHeaderCacheContract(readWorkflow(), composite),
    /must expose node-version/,
    'the save key reads this output; losing it must not pass'
  );
});

test('CONTROL: a cache path that is not the pinned devdir FAILS the contract', () => {
  const workflow = structuredClone(readWorkflow());
  const restore = workflow.jobs['native-windows'].steps.find((step) =>
    usesPrefix(step, 'actions/cache/restore@')
  );
  restore.with.path = 'some/other/place';
  assert.throws(
    () => assertHeaderCacheContract(workflow, readComposite()),
    /warms a directory node-gyp never reads/,
    'caching a directory node-gyp does not read must not pass'
  );
});
