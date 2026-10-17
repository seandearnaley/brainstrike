import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The shiki family must resolve to ONE version each, and `shiki` itself must
// agree with `@shikijs/types` — the two carry the same `HighlighterCore` /
// `HighlighterGeneric` identities, and a split produces
//
//   Type 'HighlighterCore' is not assignable to type 'HighlighterGeneric<never, never>'
//
// out of `packages/ui`'s `tsc -b`, far from the dependency that caused it.
//
// This is not hypothetical. `react-shiki` declares `shiki: ^4.3.0`, and pnpm
// preserves an existing lockfile resolution while it still satisfies the range.
// So on EVERY catalog bump of shiki the workspace importers move forward while
// react-shiki's transitive copy stays put, silently reintroducing the split in
// a diff that looks like a routine version-line change (BST-1279).
//
// Why a guard and not an `overrides:` entry, which is how react/react-dom solve
// their own single-instance problem: a BARE `shiki` override would shadow the
// catalog entry completely, which `verify-catalog-references.mjs` rejects
// outright ("never both"). A subtree-scoped `react-shiki>shiki` is permitted,
// but it pins a second shiki version that must then be kept in step with the
// catalog by hand — trading this failure for a drift between two version
// literals, which is the same class of defect one layer up. A guard has no such
// surface and catches every cause, not just react-shiki's.
//
// Remedy when this fails: `pnpm update -r shiki`.
const GUARDED_PREFIXES = ['shiki', '@shikijs/'];

/** Every distinct version each shiki-family package resolves to, by name. */
export function collectResolutions(lockfilePackages) {
  const byName = new Map();
  for (const id of Object.keys(lockfilePackages ?? {})) {
    const at = id.lastIndexOf('@');
    if (at <= 0) {
      continue;
    }
    const name = id.slice(0, at);
    const version = id.slice(at + 1);
    const guarded = GUARDED_PREFIXES.some((prefix) =>
      prefix.endsWith('/') ? name.startsWith(prefix) : name === prefix
    );
    if (!guarded) {
      continue;
    }
    if (!byName.has(name)) {
      byName.set(name, new Set());
    }
    byName.get(name).add(version);
  }
  return byName;
}

export function collectViolations(byName) {
  const violations = [];

  for (const [name, versions] of [...byName].sort()) {
    if (versions.size > 1) {
      violations.push(
        `${name} resolves to ${versions.size} versions (${[...versions].sort().join(', ')}). Run \`pnpm update -r shiki\`.`
      );
    }
  }

  // shiki and @shikijs/types share the HighlighterCore/HighlighterGeneric type
  // identities, so a mismatch between them is the specific break BST-1279 hit.
  const shiki = [...(byName.get('shiki') ?? [])];
  const types = [...(byName.get('@shikijs/types') ?? [])];
  if (shiki.length === 1 && types.length === 1 && shiki[0] !== types[0]) {
    violations.push(
      `shiki@${shiki[0]} and @shikijs/types@${types[0]} disagree. These carry the same HighlighterCore/HighlighterGeneric identities; a split breaks packages/ui's tsc -b. Run \`pnpm update -r shiki\`.`
    );
  }

  if (!byName.has('shiki')) {
    violations.push(
      'no shiki resolution found in the lockfile — has the guard drifted from reality?'
    );
  }

  return violations;
}

function loadActualState() {
  const lockfile = parsePnpmLockfile(readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8'));
  return collectResolutions(lockfile.packages);
}

test('real tree: every shiki-family package resolves to exactly one version', () => {
  assert.deepEqual(collectViolations(loadActualState()), []);
});

test('money control: a stale transitive shiki fails visibly', () => {
  // The exact pre-fix state of BST-1279: workspace importers on 4.4.3 while
  // react-shiki's transitive copy stayed at 4.3.1.
  const violations = collectViolations(
    new Map([
      ['shiki', new Set(['4.3.1', '4.4.3'])],
      ['@shikijs/types', new Set(['4.3.1', '4.4.3'])],
      ['@shikijs/langs', new Set(['4.4.3'])],
    ])
  );
  assert.match(violations.join('\n'), /shiki resolves to 2 versions \(4\.3\.1, 4\.4\.3\)/u);
  assert.match(violations.join('\n'), /pnpm update -r shiki/u);
});

test('money control: shiki and @shikijs/types drifting apart fails visibly', () => {
  const violations = collectViolations(
    new Map([
      ['shiki', new Set(['4.4.3'])],
      ['@shikijs/types', new Set(['4.3.1'])],
    ])
  );
  assert.match(violations.join('\n'), /shiki@4\.4\.3 and @shikijs\/types@4\.3\.1 disagree/u);
});

test('money control: a single aligned family passes', () => {
  assert.deepEqual(
    collectViolations(
      new Map([
        ['shiki', new Set(['4.4.3'])],
        ['@shikijs/types', new Set(['4.4.3'])],
        ['@shikijs/langs', new Set(['4.4.3'])],
        ['@shikijs/themes', new Set(['4.4.3'])],
      ])
    ),
    []
  );
});

test('parses scoped and unscoped lockfile ids without confusing the @ in a scope', () => {
  const byName = collectResolutions({
    '@shikijs/langs@4.4.3': {},
    '@shikijs/types@4.4.3': {},
    'lucide-react@1.31.0': {},
    'react-shiki@0.11.1': {},
    'shiki@4.4.3': {},
  });
  assert.deepEqual([...byName.keys()].sort(), ['@shikijs/langs', '@shikijs/types', 'shiki']);
  // react-shiki is NOT shiki — the prefix match must be exact for unscoped names.
  assert.equal(byName.has('react-shiki'), false);
});
