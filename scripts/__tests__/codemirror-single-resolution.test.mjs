import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// `@codemirror/state` must resolve to ONE version. Its `EditorState`,
// `Annotation` and `Facet` identities are nominal across copies, so a split
// produces, out of `packages/ui`'s `tsc -b`:
//
//   Type '...@codemirror+state@6.7.4/...EditorState' is not assignable to type
//   '...@codemirror+state@6.7.1/...EditorState'
//
// naming two node_modules paths rather than anything the author wrote.
//
// This is the same class as `shiki-single-resolution.test.mjs` and has the same
// cause: `@codemirror/view` declares `@codemirror/state: ^6.7.0`, and pnpm
// preserves an existing lockfile resolution for a range it is not asked to
// re-resolve. So bumping the catalog moves the workspace importers while view's
// transitive copy stays put — and the diff looks like a routine version line.
//
// It is also specifically REBASE-FRAGILE, which is why it is a test rather than
// a one-time `pnpm update`. Resolving a `pnpm-lock.yaml` conflict by taking one
// side and re-running `pnpm install` regenerates a lockfile that satisfies every
// range while quietly reintroducing the split. That happened twice on the branch
// that introduced this guard: deduped, rebased onto a moved main, and the second
// copy came back with a green local install.
//
// Why a guard and not `overrides:` — the reasoning in the shiki guard applies
// verbatim: a bare override shadows the catalog entry, which
// `verify-catalog-references.mjs` rejects ("never both"), and a subtree-scoped
// `@codemirror/view>@codemirror/state` pins a second literal that must then be
// kept in step with the catalog by hand.
//
// Remedy when this fails: `pnpm update -r --depth Infinity @codemirror/state`.
const GUARDED = '@codemirror/state';

/** Every distinct version the guarded package resolves to. */
export function collectResolutions(lockfilePackages) {
  const versions = new Set();
  for (const id of Object.keys(lockfilePackages ?? {})) {
    const at = id.lastIndexOf('@');
    if (at <= 0) {
      continue;
    }
    if (id.slice(0, at) === GUARDED) {
      versions.add(id.slice(at + 1));
    }
  }
  return versions;
}

export function collectViolations(versions) {
  if (versions.size === 0) {
    return [
      `no ${GUARDED} resolution found in the lockfile — has this guard drifted from reality?`,
    ];
  }
  if (versions.size > 1) {
    return [
      `${GUARDED} resolves to ${versions.size} versions (${[...versions].sort().join(', ')}). ` +
        "CodeMirror types are nominal across copies, so this breaks packages/ui's tsc -b. " +
        'Run `pnpm update -r --depth Infinity @codemirror/state`.',
    ];
  }
  return [];
}

function loadActualState() {
  const lockfile = parseYaml(readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8'));
  return collectResolutions(lockfile.packages);
}

test(`real tree: ${GUARDED} resolves to exactly one version`, () => {
  assert.deepEqual(collectViolations(loadActualState()), []);
});

test('money control: the split this guard exists for fails visibly', () => {
  // The exact state that failed CI twice: importers on 6.7.4 while
  // @codemirror/view's transitive copy stayed at 6.7.1.
  const violations = collectViolations(new Set(['6.7.1', '6.7.4']));
  assert.match(
    violations.join('\n'),
    /@codemirror\/state resolves to 2 versions \(6\.7\.1, 6\.7\.4\)/u
  );
  assert.match(violations.join('\n'), /pnpm update -r --depth Infinity @codemirror\/state/u);
});

test('money control: a lockfile with no codemirror at all fails instead of passing vacuously', () => {
  // A guard that reads nothing and reports nothing is the failure mode worth
  // refusing outright: if the package is ever renamed or dropped, this should
  // say so rather than going quietly green.
  assert.match(collectViolations(new Set()).join('\n'), /has this guard drifted from reality/u);
});

test('extraction: reads real lockfile ids, not a hand-rolled shape', () => {
  // Pins the parser against the real file, so a lockfile format change that
  // stopped matching ids cannot make the guard above trivially true.
  assert.ok(loadActualState().size > 0);
  assert.deepEqual(
    [...collectResolutions({ '@codemirror/state@6.7.4': {}, '@codemirror/view@6.43.11': {} })],
    ['6.7.4']
  );
});
