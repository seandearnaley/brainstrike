import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  E2E_APP_PACKAGES,
  parseTurboDryRunPackages,
  resolveE2eSelection,
} from '../affected-build-selection.mjs';

/**
 * BST-1005 (R09): the Build job affected-filters on pull requests, and the two
 * E2E jobs skip when their app was not selected.
 *
 * `Build`, `Web E2E`, and `Desktop E2E` are REQUIRED contexts in the repo's
 * active ruleset, and GitHub treats a skipped required check as satisfied —
 * so a selection bug that wrongly reported "nothing affected" would silently
 * merge untested code behind a green board. That makes fail-CLOSED the only
 * acceptable posture here: anything unparseable throws, the Build job fails,
 * and the required checks stay red. There is deliberately no "assume nothing
 * changed" path.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('parses the package list out of a turbo --dry=json payload', () => {
  const payload = JSON.stringify({
    packages: ['//', '@brainstrike/web', '@brainstrike/db'],
    tasks: [],
  });
  assert.deepEqual(parseTurboDryRunPackages(payload), ['//', '@brainstrike/web', '@brainstrike/db']);
});

test('an empty affected set parses to an empty selection rather than throwing', () => {
  // Turbo emits `packages: ["//"]` with zero tasks when nothing is affected;
  // that is a legitimate answer, not a malformed payload.
  const payload = JSON.stringify({ packages: ['//'], tasks: [] });
  assert.deepEqual(parseTurboDryRunPackages(payload), ['//']);
});

test('malformed dry-run output throws instead of degrading to "nothing affected"', () => {
  // NO SILENT FALLBACKS: each of these would otherwise read as an empty
  // selection and silently skip both required E2E checks.
  for (const payload of ['', 'not json', '{}', '{"packages":null}', '{"packages":"web"}']) {
    assert.throws(
      () => parseTurboDryRunPackages(payload),
      /turbo --dry=json/i,
      `expected a loud failure for payload: ${payload}`
    );
  }
});

test('a package list containing non-strings throws', () => {
  const payload = JSON.stringify({ packages: ['//', 42], tasks: [] });
  assert.throws(() => parseTurboDryRunPackages(payload), /turbo --dry=json/i);
});

test('resolves each E2E app independently from the selected package list', () => {
  assert.deepEqual(resolveE2eSelection(['//', '@brainstrike/web']), {
    desktop: false,
    web: true,
  });
  assert.deepEqual(resolveE2eSelection(['//', '@brainstrike/desktop']), {
    desktop: true,
    web: false,
  });
  assert.deepEqual(resolveE2eSelection(['//', '@brainstrike/web', '@brainstrike/desktop']), {
    desktop: true,
    web: true,
  });
  assert.deepEqual(resolveE2eSelection(['//']), { desktop: false, web: false });
});

test('the E2E app package names match the real workspace manifests', () => {
  // A rename would otherwise make both apps look permanently unselected —
  // the same never-matches class as a stale filter string.
  for (const [app, packageName] of Object.entries(E2E_APP_PACKAGES)) {
    const manifestPath = path.join(repoRoot, 'apps', app, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(
      manifest.name,
      packageName,
      `apps/${app}/package.json declares ${manifest.name}, not ${packageName}`
    );
  }
});

test('the Build job filters only on pull requests and keeps push/dispatch whole', () => {
  const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'test.yml'), 'utf8');
  // The unit-shard precedent: PR runs use turbo's git-range filter, push and
  // workflow_dispatch runs build everything so main never drifts behind a
  // partially-built cache.
  const buildRun = /run: TAILWIND_DEBUG=1 pnpm run build -- (?<flags>.*)\n/u.exec(workflow);
  assert.ok(buildRun, 'could not locate the Build step run line');
  const flags = buildRun.groups.flags;
  assert.match(
    flags,
    /--continue=dependencies-successful/,
    'Build must report every independent failure in one run'
  );
  // ONE decision point: the build consumes the same resolved filter the E2E
  // gates were computed from, so the two can never disagree about what was
  // selected.
  assert.match(flags, /\$BUILD_FILTERS/, 'Build must consume the resolved selection filter');
  assert.match(
    workflow,
    /BUILD_FILTERS: \$\{\{ steps\.selection\.outputs\.filters \}\}/,
    'BUILD_FILTERS must come from the selection step'
  );
  // The emitted filter is FULLY RESOLVED at write time; shell parameter
  // expansion is not recursive, so a filter still containing `$BASE_REF`
  // would reach turbo as a literal.
  assert.match(
    workflow,
    /echo "filters=--filter=\.\.\.\[origin\/\$BASE_REF\]"/,
    'the selection step must emit a resolved filter'
  );
});

test('a CI-harness change forces the full build and both E2E suites', () => {
  const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'test.yml'), 'utf8');
  // No workflow file lives inside a package, so turbo's package graph cannot
  // see the CI harness at all. Without this escape hatch a PR editing the E2E
  // jobs would select nothing and skip the very required checks it changes —
  // and a skipped required check counts as satisfied.
  assert.match(
    workflow,
    /git diff --name-only "origin\/\$BASE_REF\.\.\.HEAD"/,
    'the selection step must diff the PR range to detect harness changes'
  );
  assert.match(
    workflow,
    /grep -qE '\^\\\.github\/workflows\/\|\^scripts\/affected-build-selection\\\.mjs\$'/,
    'harness detection must cover the workflows directory and this selection script'
  );
});

test('both E2E jobs gate on their own app selection output', () => {
  const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'test.yml'), 'utf8');
  assert.match(
    workflow,
    /needs\.build\.outputs\.web_selected == 'true'/,
    'Web E2E must gate on the web selection output'
  );
  assert.match(
    workflow,
    /needs\.build\.outputs\.desktop_selected == 'true'/,
    'Desktop E2E must gate on the desktop selection output'
  );
  // The outputs must actually be declared, or the gates above silently read
  // empty strings and both E2E jobs would never run again.
  assert.match(workflow, /web_selected: \$\{\{ steps\.selection\.outputs\.web \}\}/);
  assert.match(workflow, /desktop_selected: \$\{\{ steps\.selection\.outputs\.desktop \}\}/);
});
