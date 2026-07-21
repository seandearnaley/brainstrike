import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyCommand,
  classifyFileToken,
  isFileToken,
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

test('dotted code identifiers are not treated as file tokens at all', () => {
  // hyphenated dotted identifiers and code-extension tokens stay out of the file branch
  assert.equal(isFileToken('subagent-personas.v1'), false);
  assert.equal(isFileToken('assistant-preferences-store.planModeEnabled'), false);
  assert.equal(isFileToken('array.map'), false);
});

const packages = new Map([
  ['__root__', { scripts: { doctor: 'react-doctor .' }, devDependencies: { vitest: '^2' } }],
]);

test('pnpm <bin> invocations are not treated as missing root scripts', () => {
  // real script → ACCURATE
  assert.equal(classifyCommand('pnpm doctor', packages, new Set()), 'ACCURATE');
  // dependency binary, not a script → MANUAL, never DANGLING
  assert.equal(classifyCommand('pnpm vitest run', packages, new Set()), 'MANUAL');
  // a flag is not a script name at all → MANUAL
  assert.equal(classifyCommand('pnpm --version', packages, new Set()), 'MANUAL');
  // genuine unknown script name stays fail-closed DANGLING
  assert.equal(classifyCommand('pnpm nonexistent-script', packages, new Set()), 'DANGLING');
});
