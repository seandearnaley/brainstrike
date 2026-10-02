import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * BST-1005 (R09): the Build job's invocation contract.
 *
 * The ticket also asked to affected-filter this job and skip E2E when nothing
 * was selected. Both were dropped after measurement — see the Build step's own
 * comment and the ticket. What remains is the part that is unambiguously
 * correct: invoke turbo directly, and report every independent failure.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function workflow() {
  return readFileSync(path.join(repoRoot, '.github', 'workflows', 'test.yml'), 'utf8');
}

test('Build invokes turbo directly so flags cannot leak into package scripts', () => {
  // `pnpm run build -- <flags>` preserves the `--`, so turbo treats the flags
  // as pass-through args and appends them to EVERY package's build script,
  // where pnpm tacks them onto the last command of the `&&` chain. That is not
  // theoretical: it killed tsup and node-gyp on the first CI run of this PR.
  const source = workflow();
  assert.match(source, /run: pnpm turbo run build /, 'the Build step must call turbo directly');
  assert.doesNotMatch(
    source,
    /run: .*pnpm run build --/,
    'never pass turbo flags through `pnpm run build --`; they leak into package scripts'
  );
});

test('Build reports every independent failure in one run', () => {
  assert.match(workflow(), /--continue=dependencies-successful/);
});

test('both E2E smoke jobs stay ungated by any build selection', () => {
  // AGENTS.md's CI contract: "web + desktop E2E smoke run on every PR", and
  // audit-bolt-readiness.mjs counts a SKIPPED required check as not-ready. A
  // selection-based gate on these jobs would violate both, and would save at
  // most one package anyway — the web+desktop dependency closure is 46 of 47.
  const source = workflow();
  assert.doesNotMatch(
    source,
    /needs\.build\.outputs\.\w*_selected/,
    'E2E jobs must not gate on a build-selection output'
  );
});
