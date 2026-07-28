import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyAnchoredPath,
  classifyCommand,
  classifyFileToken,
  classifyProjectPath,
  isFileToken,
  isSymbol,
  sourceAnchorEnd,
  stripSourceAnchor,
} from './collect-scribe-references.mjs';

const tree = new Set([
  'AGENTS.md',
  'packages/db/db-test-lane-manifest.mjs',
  'secret-scan.config.json',
  'packages/db/src/repo.ts',
]);

test('hyphenated root-file references are classified, not silently skipped', () => {
  assert.equal(isFileToken('db-test-lane-manifest.mjs'), true);
  assert.equal(isFileToken('secret-scan.config.json'), true);
  // present in the tree (by basename) → ACCURATE
  assert.equal(classifyFileToken('db-test-lane-manifest.mjs', tree), 'ACCURATE');
  assert.equal(classifyFileToken('AGENTS.md', tree), 'ACCURATE');
});

test('an absent file token is MANUAL (a human-verify lead), never a fabricated DANGLING', () => {
  // docs cite filenames as examples/contrasts, so absent != mechanically dangling
  assert.equal(classifyFileToken('db-test-lane-manifsst.mjs', tree), 'MANUAL');
  assert.equal(classifyFileToken('docs/agents/ghost.md', tree), 'MANUAL');
});

test('project-path citations strip only trailing source anchors', () => {
  assert.equal(classifyProjectPath('packages/db/src/repo.ts:12', tree), 'ACCURATE');
  assert.equal(classifyProjectPath('packages/db/src/repo.ts:12-24', tree), 'ACCURATE');
  assert.equal(classifyProjectPath('packages/db/src/ghost.ts:12-24', tree), 'DANGLING');
  assert.equal(classifyProjectPath('packages/db/src/repo.ts:main', tree), 'DANGLING');
  assert.equal(stripSourceAnchor('packages/db/src/repo.ts:12:5'), 'packages/db/src/repo.ts');
  assert.equal(sourceAnchorEnd('packages/db/src/repo.ts:12-24'), 24);
  assert.equal(
    classifyAnchoredPath('packages/db/src/repo.ts:12-24', tree, () => 24),
    'ACCURATE'
  );
  assert.equal(
    classifyAnchoredPath('packages/db/src/repo.ts:12-25', tree, () => 24),
    'DANGLING'
  );
});

test('bare filename citations with source anchors are classified', () => {
  assert.equal(isFileToken('db-test-lane-manifest.mjs:12-24'), true);
  assert.equal(classifyFileToken('db-test-lane-manifest.mjs:12-24', tree), 'ACCURATE');
});

test('dotted code identifiers are not treated as file tokens at all', () => {
  // hyphenated dotted identifiers and code-extension tokens stay out of the file branch
  assert.equal(isFileToken('subagent-personas.v1'), false);
  assert.equal(isFileToken('assistant-preferences-store.planModeEnabled'), false);
  assert.equal(isFileToken('array.map'), false);
});

test('commit hashes are not counted as symbol references', () => {
  assert.equal(isSymbol('c30fea0525d38329ee96950efd251285f912d2b9'), false);
  assert.equal(isSymbol('0413d6baef16c1d716987ad2d3ef880e247b5e09'), false);
  assert.equal(isSymbol('DataStreamMapper'), true);
});

const packages = new Map([
  [
    '__root__',
    {
      devDependencies: { vitest: '^2' },
      scripts: { clean: 'turbo run clean', 'react-doctor': 'react-doctor .' },
    },
  ],
]);

test('pnpm <bin> invocations are not treated as missing root scripts', () => {
  // real script → ACCURATE
  assert.equal(classifyCommand('pnpm react-doctor', packages, new Set()), 'ACCURATE');
  // dependency binary, not a script → MANUAL, never DANGLING
  assert.equal(classifyCommand('pnpm vitest run', packages, new Set()), 'MANUAL');
  // a flag is not a script name at all → MANUAL
  assert.equal(classifyCommand('pnpm --version', packages, new Set()), 'MANUAL');
  // genuine unknown script name stays fail-closed DANGLING
  assert.equal(classifyCommand('pnpm nonexistent-script', packages, new Set()), 'DANGLING');
});

// BST-852. `doctor` is a pnpm BUILTIN subcommand, so the bare shorthand
// `pnpm doctor` runs pnpm's own environment doctor and NEVER reaches a
// package script of the same name — while printing "All checks passed", which
// reads exactly like a clean run of the script. A documented command that
// cannot do what it claims is DANGLING, not ACCURATE; classifying it ACCURATE
// made this collector a third false-green instrument on top of the bug itself.
//
// The shadow set is EMPIRICALLY derived, not read from `pnpm help -a`: that
// listing omits `doctor` (hidden builtin) and includes `clean` (which does NOT
// shadow — a `clean` script runs normally). Verified against pnpm 11.15.0 with
// a scratch fixture whose scripts echo a sentinel.
test('bare `pnpm <name>` for a pnpm-shadowed builtin is DANGLING, not ACCURATE', () => {
  const shadowingPackages = new Map([
    ['__root__', { devDependencies: {}, scripts: { doctor: 'react-doctor .' } }],
  ]);
  // The bug: the script exists, but this invocation can never reach it.
  assert.equal(classifyCommand('pnpm doctor', shadowingPackages, new Set()), 'DANGLING');
  // The explicit `run` form is unambiguous and does reach the script.
  assert.equal(classifyCommand('pnpm run doctor', shadowingPackages, new Set()), 'ACCURATE');
});

// Review follow-up on #2084. The rule must NOT depend on a script of that name
// existing — the shorthand is misleading either way, and gating on it would
// make the check inert against the real repo, whose script is now
// `react-doctor`. This fixture is that real shape.
test('the shadowed shorthand is DANGLING even when no script of that name exists', () => {
  const renamedPackages = new Map([
    [
      '__root__',
      {
        devDependencies: { 'react-doctor': '1.0.0' },
        scripts: { 'react-doctor': 'react-doctor .' },
      },
    ],
  ]);
  assert.equal(classifyCommand('pnpm doctor', renamedPackages, new Set()), 'DANGLING');
  // ...and the renamed script is reachable by both forms.
  assert.equal(classifyCommand('pnpm react-doctor', renamedPackages, new Set()), 'ACCURATE');
  assert.equal(classifyCommand('pnpm run react-doctor', renamedPackages, new Set()), 'ACCURATE');
});

test('non-shadowing builtin names keep working in bare form', () => {
  // `clean` appears in `pnpm help -a` but does NOT shadow a package script,
  // so flagging it would be a false positive. Empirically verified.
  assert.equal(classifyCommand('pnpm clean', packages, new Set()), 'ACCURATE');
  assert.equal(classifyCommand('pnpm run clean', packages, new Set()), 'ACCURATE');
});
