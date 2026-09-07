import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// undici 7.x below 7.29.0 carries a HIGH advisory (cross-user information
// disclosure and parse-time confusion) plus several moderates, all patched in
// 7.29.0. Unlike most of this repo's advisory noise — which roots in dev-only
// tooling like vercel, stryker and electron-builder — this one reached a SHIPPED
// path: `packages__agent>@ai-sdk/openai>@ai-sdk/provider-utils>undici`.
//
// It got there because `@ai-sdk/openai` is pinned EXACTLY at 4.0.49 (see the
// `//@ai-sdk/openai` rationale in packages/agent/package.json — 4.0.50 onward
// re-regresses itemId preservation), which freezes that subtree on
// provider-utils 5.0.32 while the rest of the tree is on 5.0.36. The undici half
// of that cost is separable though: 5.0.32 declares `undici: ^7.28.0`, and
// 7.29.1 satisfies it, so `pnpm update undici -r` lifts the subtree without
// touching the pin (BST-1671).
//
// This is a TEST rather than an `overrides:` entry for the same reason as
// `codemirror-single-resolution.test.mjs`: the remedy is a one-line `pnpm
// update`, but the fix is REBASE-FRAGILE. Resolving a `pnpm-lock.yaml` conflict
// by taking one side and re-running `pnpm install` regenerates a lockfile that
// satisfies every range while quietly restoring the old resolution — which is
// exactly how the codemirror dedupe was lost twice on the branch that
// introduced its guard. A caret range makes a fresh resolve pick >=7.29.1 on its
// own, so this should hold unaided; the guard exists for the case where it does
// not, because silence and safety look identical here.
//
// Scope is the 7.x line only, matching the advisory range (>=7.0.0 <7.29.0).
// The 5.x and 6.x copies live under the `vercel` dev CLI and have their own
// separate advisories; they are not in a shipped path and are not this guard's
// business.
//
// Remedy when this fails: `pnpm update "undici@^7" -r`. Scoped on purpose — a
// bare `pnpm update undici -r` also moves the 5.x/6.x/8.x copies under the
// vercel CLI, @actions/* and node-gyp, landing unrelated resolution drift in the
// same commit. It did exactly that here (6.28.0 -> 6.28.1, 8.10.0 -> 8.10.2):
// both forward into already-patched territory and neither on a shipped path,
// but still churn nobody asked for.
const MIN_SEVEN_X = [7, 29, 0];

function parseVersion(raw) {
  const parts = raw.split('.').map((piece) => Number.parseInt(piece, 10));
  return parts.length === 3 && parts.every((n) => Number.isInteger(n)) ? parts : null;
}

function isBelow(version, floor) {
  for (const [index, bound] of floor.entries()) {
    if (version[index] !== bound) {
      return version[index] < bound;
    }
  }
  return false;
}

/** Every distinct undici version the lockfile resolves, as `major.minor.patch`. */
export function lockfileUndiciVersions(lockfile) {
  // Snapshot keys look like `  undici@7.29.1:`; a peer suffix would follow in
  // parentheses, so stop at the first '(' rather than taking the whole tail.
  const found = new Set();
  for (const match of lockfile.matchAll(/^ {2}'?undici@([^:'(\s]+)/gm)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

test('no undici 7.x below the 7.29.0 patch floor reaches the lockfile', () => {
  const lockfile = readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
  const versions = lockfileUndiciVersions(lockfile);
  // A guard that finds nothing to check is not a guard: if the shape of the
  // lockfile key ever changes, this fails loudly instead of passing vacuously.
  assert.ok(versions.length > 0, 'expected the lockfile to resolve at least one undici');

  // A version this cannot parse must fail loudly rather than be filtered out:
  // silently skipping it would let a malformed or prerelease spelling slip the
  // floor, which is precisely what this guard exists to prevent.
  const sevenX = versions.filter((raw) => raw.startsWith('7.'));
  const unparseable = sevenX.filter((raw) => parseVersion(raw) === null);
  assert.deepEqual(
    unparseable,
    [],
    `undici 7.x versions this guard cannot compare: ${unparseable.join(', ')}`
  );

  const offenders = sevenX.filter((raw) => isBelow(parseVersion(raw), MIN_SEVEN_X));
  assert.deepEqual(
    offenders,
    [],
    `undici 7.x below 7.29.0 is present (${offenders.join(', ')}); run \`pnpm update "undici@^7" -r\``
  );
});
