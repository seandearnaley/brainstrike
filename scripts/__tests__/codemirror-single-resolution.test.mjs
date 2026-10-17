import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

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
//
// `@codemirror/view` is guarded too. The nominal-identity argument applies just
// as much to `EditorView`, `Decoration` and `ViewPlugin`, and view is the MORE
// likely of the two to drift next: `state` is catalogued, view is still a
// literal range in `packages/ui`, so nothing centralises its version.
const GUARDED = ['@codemirror/state', '@codemirror/view'];

/**
 * The name and version in a lockfile package id.
 *
 * The parenthesised peer suffix is stripped FIRST. A naive `lastIndexOf("@")`
 * over `@codemirror/state@6.7.4(x@1)` lands inside the peer and skips the entry,
 * and the dangerous shape is not zero matches — that fails loudly below — but a
 * MIXED tree where the bare id is counted and the suffixed one is dropped,
 * leaving one version and a false green.
 */
function parseId(id) {
  const withoutPeers = id.slice(0, (id.indexOf('(') + 1 || id.length + 1) - 1);
  const at = withoutPeers.lastIndexOf('@');
  return at <= 0 ? null : { name: withoutPeers.slice(0, at), version: withoutPeers.slice(at + 1) };
}

/** Every distinct version each guarded package resolves to, by name. */
export function collectResolutions(lockfilePackages) {
  const byName = new Map(GUARDED.map((name) => [name, new Set()]));
  for (const id of Object.keys(lockfilePackages ?? {})) {
    const parsed = parseId(id);
    if (parsed && byName.has(parsed.name)) {
      byName.get(parsed.name).add(parsed.version);
    }
  }
  return byName;
}

export function collectViolations(byName) {
  const violations = [];
  for (const name of GUARDED) {
    const versions = byName.get(name) ?? new Set();
    if (versions.size === 0) {
      violations.push(
        `no ${name} resolution found in the lockfile — has this guard drifted from reality?`
      );
      continue;
    }
    if (versions.size > 1) {
      violations.push(
        `${name} resolves to ${versions.size} versions (${[...versions].sort().join(', ')}). ` +
          "CodeMirror types are nominal across copies, so this breaks packages/ui's tsc -b. " +
          `Run \`pnpm update -r --depth Infinity ${name}\`.`
      );
    }
  }
  return violations;
}

function loadActualState() {
  const lockfile = parsePnpmLockfile(readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8'));
  return collectResolutions(lockfile.packages);
}

test('real tree: every guarded CodeMirror package resolves to exactly one version', () => {
  assert.deepEqual(collectViolations(loadActualState()), []);
});

test('money control: the split this guard exists for fails visibly', () => {
  // The exact state that failed CI twice: importers on 6.7.4 while
  // @codemirror/view's transitive copy stayed at 6.7.1.
  const violations = collectViolations(
    new Map([
      ['@codemirror/state', new Set(['6.7.1', '6.7.4'])],
      ['@codemirror/view', new Set(['6.43.11'])],
    ])
  );
  assert.match(
    violations.join('\n'),
    /@codemirror\/state resolves to 2 versions \(6\.7\.1, 6\.7\.4\)/u
  );
  assert.match(violations.join('\n'), /pnpm update -r --depth Infinity @codemirror\/state/u);
});

test('money control: a split in view is caught too, not just state', () => {
  const violations = collectViolations(
    new Map([
      ['@codemirror/state', new Set(['6.7.4'])],
      ['@codemirror/view', new Set(['6.43.8', '6.43.11'])],
    ])
  );
  assert.match(violations.join('\n'), /@codemirror\/view resolves to 2 versions/u);
});

test('money control: a lockfile with no codemirror at all fails instead of passing vacuously', () => {
  // A guard that reads nothing and reports nothing is the failure mode worth
  // refusing outright: if a package is renamed or dropped, this should say so
  // rather than going quietly green.
  assert.match(collectViolations(new Map()).join('\n'), /has this guard drifted from reality/u);
});

test('extraction: a peer suffix does not hide a second copy', () => {
  // The false-green shape: one bare id and one peer-suffixed id for the same
  // package. A lastIndexOf("@") parser lands inside the peer, drops the second
  // entry, and reports a single version.
  const byName = collectResolutions({
    '@codemirror/state@6.7.1(@codemirror/view@6.43.11)': {},
    '@codemirror/state@6.7.4': {},
    '@codemirror/view@6.43.11': {},
  });
  assert.deepEqual([...(byName.get('@codemirror/state') ?? [])].sort(), ['6.7.1', '6.7.4']);
  assert.match(collectViolations(byName).join('\n'), /@codemirror\/state resolves to 2 versions/u);
});

test('extraction: reads real lockfile ids, not a hand-rolled shape', () => {
  // Pins the parser against the real file, so a lockfile format change that
  // stopped matching ids cannot make the guard above trivially true.
  const actual = loadActualState();
  assert.ok((actual.get('@codemirror/state') ?? new Set()).size > 0);
  assert.ok((actual.get('@codemirror/view') ?? new Set()).size > 0);
});
