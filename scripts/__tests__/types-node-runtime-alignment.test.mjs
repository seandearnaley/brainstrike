import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// BST-1294: `@types/node` describes the standard library the compiler believes
// exists. When it names a HIGHER major than the Node the repo actually runs,
// `tsc` accepts calls into APIs that are absent at runtime — `node:ffi` and
// `node:quic` are declared by @types/node 26 and throw ERR_UNKNOWN_BUILTIN_MODULE
// on Node 24. A green type-check then stops being evidence that the code runs,
// which is precisely the silent-degradation class AGENTS.md forbids.
//
// So the contract is one-way and exact, not "close enough": the catalog major
// must EQUAL the runtime major. A LOWER types major is not a safe direction
// either — it hides APIs that do exist, pushing authors toward casts.
const CATALOG_PACKAGE = '@types/node';

// Every manifest that declares a Node engine range. These were tightened to a
// single bounded major by BST-1275 (#2442); this contract is what keeps them
// tightened, because an unbounded floor like `>=24.15.0` silently re-admits
// Node 26 and makes the alignment claim meaningless again.
const ENGINE_MANIFESTS = [
  'package.json',
  'apps/desktop/package.json',
  'apps/e2e-test-utils/package.json',
];

// Scope note, deliberately narrow: this contract governs the catalog, the
// lockfile's catalog resolution, and the workspace importers that DECLARE
// `@types/node`. It is NOT a repo-global uniqueness assertion over the
// lockfile. Unrelated third-party packages legitimately pin their own copy —
// `@vercel/node@5.8.22` hard-depends on `@types/node@20.11.0` — and a
// transitive pin like that cannot change what `tsc` loads for our sources, so
// reporting it here would fail the lane for someone else's dependency graph.
function parseMajor(version) {
  const match = /^(?<major>\d+)\./u.exec(String(version ?? ''));
  return match?.groups ? Number(match.groups.major) : null;
}

// Derives the single Node major an engines range admits. Returns null when the
// range is not pinned to exactly one major, because then there is no runtime
// major to align the types against.
function impliedEngineMajor(range) {
  const text = String(range ?? '').trim();
  if (text === '') {
    return null;
  }
  // `24` / `24.x` / `24.*`
  const shorthand = /^(?<major>\d+)(?:\.[x*](?:\.[x*])?)?$/u.exec(text);
  if (shorthand?.groups) {
    return Number(shorthand.groups.major);
  }
  // `>=24.15.0 <25` — a bounded floor/ceiling pair one major apart.
  const bounded = /^>=\s*(?<floor>\d+)\.\d+\.\d+\s+<\s*(?<ceiling>\d+)(?:\.0\.0)?$/u.exec(text);
  if (bounded?.groups) {
    const floor = Number(bounded.groups.floor);
    return Number(bounded.groups.ceiling) === floor + 1 ? floor : null;
  }
  return null;
}

function collectViolations({ nvmrc, engines, catalogRange, lockfileCatalog, importerVersions }) {
  const violations = [];

  const nvmrcMajor = /^(?<major>\d+)\b/u.exec(String(nvmrc ?? '').trim())?.groups?.major;
  const runtimeMajor = nvmrcMajor === undefined ? null : Number(nvmrcMajor);
  if (runtimeMajor === null) {
    violations.push(`.nvmrc must name a Node major, found ${JSON.stringify(nvmrc)}`);
  }

  // Every engines range must pin exactly one major, and the same one .nvmrc names.
  for (const { manifest, range } of engines) {
    const major = impliedEngineMajor(range);
    if (major === null) {
      violations.push(
        `${manifest} engines.node must pin exactly one Node major (e.g. ">=24.15.0 <25"), found ${JSON.stringify(range)}; an unbounded range re-admits a newer runtime and voids this contract`
      );
      continue;
    }
    if (runtimeMajor !== null && major !== runtimeMajor) {
      violations.push(
        `${manifest} engines.node implies Node ${major} but .nvmrc names ${runtimeMajor}`
      );
    }
  }

  // The headline assertion: catalog types major === runtime major.
  const catalogMajor = parseMajor(String(catalogRange ?? '').replace(/^[\^~>=<\s]+/u, ''));
  if (catalogMajor === null) {
    violations.push(
      `catalog ${CATALOG_PACKAGE} must be a version range, found ${JSON.stringify(catalogRange)}`
    );
  } else if (runtimeMajor !== null && catalogMajor !== runtimeMajor) {
    violations.push(
      `${CATALOG_PACKAGE} major skew: the catalog pins ${catalogRange} (Node ${catalogMajor} typings) but this repo runs Node ${runtimeMajor}. ${
        catalogMajor > runtimeMajor
          ? `The compiler will accept Node ${catalogMajor}-only APIs that throw at runtime, so a green type-check stops proving the code runs.`
          : `The compiler will hide APIs Node ${runtimeMajor} really has, pushing authors toward casts.`
      }`
    );
  }

  // The catalog string is an intent; the lockfile is what actually installs.
  // An edited catalog that was never installed would otherwise pass silently.
  const lockMajor = parseMajor(lockfileCatalog?.version);
  if (lockMajor === null) {
    violations.push(
      `pnpm-lock.yaml has no resolved catalog version for ${CATALOG_PACKAGE}; run pnpm install`
    );
  } else {
    if (catalogMajor !== null && lockMajor !== catalogMajor) {
      violations.push(
        `pnpm-lock.yaml resolves ${CATALOG_PACKAGE}@${lockfileCatalog.version} but the catalog asks for ${catalogRange}; run pnpm install`
      );
    }
    if (lockfileCatalog?.specifier !== catalogRange) {
      violations.push(
        `pnpm-lock.yaml records the catalog specifier as ${JSON.stringify(lockfileCatalog?.specifier)} but pnpm-workspace.yaml says ${JSON.stringify(catalogRange)}; run pnpm install`
      );
    }
  }

  // Defense in depth: no workspace package may resolve a different major, which
  // is what a stray non-catalog pin in one package.json would produce.
  for (const { id, version } of importerVersions) {
    const major = parseMajor(version);
    if (runtimeMajor !== null && major !== runtimeMajor) {
      violations.push(
        `workspace package ${id} resolves ${CATALOG_PACKAGE}@${version} (Node ${major} typings) against a Node ${runtimeMajor} runtime; it must use "catalog:"`
      );
    }
  }

  return violations;
}

function loadActualState() {
  const lockfile = parseYaml(readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8'));
  const workspace = parseYaml(readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
  const importerVersions = Object.entries(lockfile.importers ?? {})
    .map(([id, importer]) => ({
      id,
      version:
        importer?.devDependencies?.[CATALOG_PACKAGE]?.version ??
        importer?.dependencies?.[CATALOG_PACKAGE]?.version,
    }))
    .filter((entry) => entry.version !== undefined);
  return {
    catalogRange: workspace?.catalog?.[CATALOG_PACKAGE],
    engines: ENGINE_MANIFESTS.map((manifest) => ({
      manifest,
      range: JSON.parse(readFileSync(path.join(repoRoot, manifest), 'utf8')).engines?.node,
    })),
    importerVersions,
    lockfileCatalog: lockfile.catalogs?.default?.[CATALOG_PACKAGE],
    nvmrc: readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8'),
  };
}

test('real tree: @types/node tracks the Node major this repo actually runs', () => {
  assert.deepEqual(collectViolations(loadActualState()), []);
});

test('real tree: every workspace package declaring @types/node goes through the catalog', () => {
  // The catalog only governs packages that opt in with "catalog:". A package
  // that hard-pins its own range keeps compiling against whatever it named, so
  // assert the resolutions rather than trusting the catalog entry alone.
  const { importerVersions } = loadActualState();
  assert.ok(
    importerVersions.length > 0,
    'expected at least one workspace package to declare @types/node; if that is genuinely no longer true, this contract needs rewriting around the new layout'
  );
  assert.deepEqual([...new Set(importerVersions.map((entry) => entry.version))].sort(), [
    loadActualState().lockfileCatalog.version,
  ]);
});

test('money control: the pre-BST-1294 state (types 26 on a Node 24 runtime) fails visibly', () => {
  const violations = collectViolations({
    catalogRange: '^26.1.0',
    engines: ENGINE_MANIFESTS.map((manifest) => ({ manifest, range: '>=24.15.0 <25' })),
    importerVersions: [{ id: 'packages/db', version: '26.1.0' }],
    lockfileCatalog: { specifier: '^26.1.0', version: '26.1.0' },
    nvmrc: '24\n',
  });
  assert.match(violations.join('\n'), /@types\/node major skew/u);
  assert.match(violations.join('\n'), /accept Node 26-only APIs that throw at runtime/u);
});

test('money control: types BELOW the runtime major also fails', () => {
  const violations = collectViolations({
    catalogRange: '^22.9.0',
    engines: ENGINE_MANIFESTS.map((manifest) => ({ manifest, range: '>=24.15.0 <25' })),
    importerVersions: [{ id: 'packages/db', version: '22.9.0' }],
    lockfileCatalog: { specifier: '^22.9.0', version: '22.9.0' },
    nvmrc: '24\n',
  });
  assert.match(violations.join('\n'), /hide APIs Node 24 really has/u);
});

test('money control: an unbounded engines range fails instead of quietly re-admitting Node 26', () => {
  const violations = collectViolations({
    catalogRange: '^24.13.3',
    engines: [{ manifest: 'package.json', range: '>=24.15.0' }],
    importerVersions: [],
    lockfileCatalog: { specifier: '^24.13.3', version: '24.13.3' },
    nvmrc: '24\n',
  });
  assert.match(violations.join('\n'), /must pin exactly one Node major/u);
});

test('money control: a catalog edit that was never installed fails', () => {
  const violations = collectViolations({
    catalogRange: '^24.13.3',
    engines: [{ manifest: 'package.json', range: '>=24.15.0 <25' }],
    importerVersions: [],
    lockfileCatalog: { specifier: '^26.1.0', version: '26.1.0' },
    nvmrc: '24\n',
  });
  assert.match(
    violations.join('\n'),
    /resolves @types\/node@26\.1\.0 but the catalog asks for \^24\.13\.3/u
  );
});

test('money control: a single package hard-pinning a foreign major fails', () => {
  const violations = collectViolations({
    catalogRange: '^24.13.3',
    engines: [{ manifest: 'package.json', range: '>=24.15.0 <25' }],
    importerVersions: [
      { id: 'packages/db', version: '24.13.3' },
      { id: 'packages/agent', version: '26.1.0' },
    ],
    lockfileCatalog: { specifier: '^24.13.3', version: '24.13.3' },
    nvmrc: '24\n',
  });
  assert.match(violations.join('\n'), /packages\/agent resolves @types\/node@26\.1\.0/u);
});

test('money control: .nvmrc drifting from engines fails', () => {
  const violations = collectViolations({
    catalogRange: '^22.9.0',
    engines: [{ manifest: 'package.json', range: '>=24.15.0 <25' }],
    importerVersions: [],
    lockfileCatalog: { specifier: '^22.9.0', version: '22.9.0' },
    nvmrc: '22\n',
  });
  assert.match(violations.join('\n'), /engines\.node implies Node 24 but \.nvmrc names 22/u);
});

test('money control: the aligned state passes', () => {
  assert.deepEqual(
    collectViolations({
      catalogRange: '^24.13.3',
      engines: ENGINE_MANIFESTS.map((manifest) => ({ manifest, range: '>=24.15.0 <25' })),
      importerVersions: [{ id: 'packages/db', version: '24.13.3' }],
      lockfileCatalog: { specifier: '^24.13.3', version: '24.13.3' },
      nvmrc: '24\n',
    }),
    []
  );
});
