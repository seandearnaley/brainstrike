import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Patch floors for advisories that reached a SHIPPED surface — `packages/agent`,
// `apps/desktop`, `packages/embeddings` — and were cleared by lifting a
// transitive rather than by moving the direct dependency.
//
// This repo's advisory count is dominated by DEV-only tooling (`vercel`,
// `@stryker-mutator/*`, `electron-builder`), and chasing that number is close to
// worthless: an 8-PR sweep once moved it 80 -> 78. These entries are the
// exception — each was a real severity on a path that ships.
//
// Every one had the same shape: the parent's range already admitted the patched
// version, so the tree was held on the vulnerable one by lockfile inertia and a
// single `pnpm update <pkg> -r` lifted it with no direct-dependency change.
//
// It is a TEST rather than an `overrides:` entry because the fix is
// REBASE-FRAGILE, the same way `codemirror-single-resolution.test.mjs` describes:
// resolving a `pnpm-lock.yaml` conflict by taking one side and re-running
// `pnpm install` regenerates a lockfile that satisfies every range while quietly
// restoring the old resolution. That is how the codemirror dedupe was lost twice
// on the branch that introduced its guard. A caret range means a fresh resolve
// should pick the patched version unaided; this guard exists for when it does
// not, because here silence and safety look identical.
//
// Remedy when this fails: `pnpm update <package> -r`.
//
// DELIBERATELY NOT GUARDED, and why — `ip-address` and `hono` also had shipped
// findings cleared (via `@modelcontextprotocol/server-legacy` and
// `@modelcontextprotocol/node`), but straggler copies BELOW the floor remain in
// the tree on non-shipped paths. A lockfile-wide floor would fail on those, and
// narrowing this guard to per-path resolution would make it far more fragile
// than the thing it guards. They are covered by the audit, not by this test.
const FLOORS = [
  // >=7.0.0 <7.29.0: high (cross-user information disclosure / parse-time
  // confusion) reached packages__agent>@ai-sdk/openai>@ai-sdk/provider-utils.
  // Scoped to the 7.x line; the 5.x/6.x copies are under the vercel dev CLI.
  { floor: [7, 29, 0], major: 7, name: 'undici' },
  // <=3.1.3: high, reached @mastra/core, @mastra/memory and electron-store.
  { floor: [3, 1, 4], name: 'fast-uri' },
  // >=3.0.0 <3.15.1: high, reached @mastra/core and @mastra/memory. The 4.x
  // copies are above the floor on a major comparison and are unaffected.
  { floor: [3, 15, 1], name: 'js-yaml' },
];

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

/** Every distinct version of `name` the lockfile resolves. */
export function lockfileVersions(lockfile, name) {
  // Snapshot keys look like `  js-yaml@4.1.1:`; a peer suffix would follow in
  // parentheses, so stop at the first '(' rather than taking the whole tail.
  const pattern = new RegExp(
    `^ {2}'?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@([^:'(\\s]+)`,
    'gm'
  );
  return [...new Set([...lockfile.matchAll(pattern)].map((match) => match[1]))].sort();
}

for (const { name, floor, major } of FLOORS) {
  const scope = major === undefined ? '' : ` (${major}.x line)`;
  test(`${name}${scope} stays at or above its ${floor.join('.')} patch floor`, () => {
    const lockfile = readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
    const versions = lockfileVersions(lockfile, name);
    // A guard that finds nothing to check is not a guard: if the lockfile key
    // shape ever changes, fail loudly rather than pass vacuously.
    assert.ok(versions.length > 0, `expected the lockfile to resolve at least one ${name}`);

    const offenders = versions.filter((raw) => {
      const version = parseVersion(raw);
      if (version === null) {
        return false;
      }
      if (major !== undefined && version[0] !== major) {
        return false;
      }
      return isBelow(version, floor);
    });
    assert.deepEqual(
      offenders,
      [],
      `${name} below ${floor.join('.')} is present (${offenders.join(', ')}); run \`pnpm update ${name} -r\``
    );
  });
}
