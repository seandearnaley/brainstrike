import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

// The manifests that must pin exactly ONE Node major: the repo root plus every
// app. These were tightened to a single bounded major by BST-1275 (#2442); this
// contract is what keeps them tightened, because an unbounded floor like
// `>=24.15.0` silently re-admits Node 26 and makes the alignment claim
// meaningless again.
//
// DISCOVERED, not hardcoded. A hardcoded list is exactly the drift this file
// exists to prevent, and it had already gone stale on arrival: `apps/web`
// (engines.node "24.x", a direct consumer of the catalog `@types/node`) was
// missing, so pointing the web runtime at another major would have left this
// test green. `apps/*` mirrors the pnpm-workspace.yaml glob, so a new app is
// covered the day it lands.
//
// Deliberately EXCLUDED: the 26 `packages/*` manifests that declare the
// library-consumer floor `>=22` (19 more declare no engines at all). That range
// is unbounded BY DESIGN — they are libraries, and a consumer on any Node >=22
// may use them — so it implies no single major and would fail
// `impliedEngineMajor`. The alignment claim is about the Node this repo RUNS,
// which the root and the apps are what actually name.
function discoverEngineManifests() {
  const apps = readdirSync(path.join(repoRoot, 'apps'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `apps/${entry.name}/package.json`)
    .filter((manifest) => existsSync(path.join(repoRoot, manifest)))
    .sort();
  return ['package.json', ...apps];
}

const ENGINE_MANIFESTS = discoverEngineManifests();

// Scope note, deliberately narrow: this contract governs the catalog, the
// lockfile's catalog resolution, and the workspace importers that DECLARE
// `@types/node`. It is NOT a repo-global uniqueness assertion over the
// lockfile. Unrelated third-party packages legitimately pin their own copy —
// `@vercel/node@5.8.22` hard-depends on `@types/node@20.11.0` — and a
// transitive pin like that cannot change what `tsc` loads for our sources, so
// reporting it here would fail the lane for someone else's dependency graph.
//
// A SECOND copy — `@types/node@26.1.0` — is also installed, and it is likewise
// out of scope. History matters here, because the obvious fix was tried and
// only half worked.
//
// `@types/node` is an optional PEER of vite/vitest, and a catalog does not
// govern peers it is not asked about. Six packages (assistant-contract,
// assistant-wire, config, indexing-contract, local-runtime, pipeline) took
// `vitest` from the catalog while declaring no `@types/node` of their own, so
// pnpm resolved that peer straight from the registry at the newest satisfying
// version and keyed a THIRD vite/vitest instance on 26.1.0. Those six now
// declare `"@types/node": "catalog:"` like the other 41, which collapsed the
// peer keying: vite and vitest each went 3 peer-keyed instances -> 2, and the
// lockfile lost 5 snapshots / 70 lines. Every one of the six genuinely imports
// a `node:` builtin (`node:path` in five vitest configs, `node:crypto` in
// config's `src/vitest-browser.ts`), so the declaration is honest and knip
// counts it used — it reports no new unused dependency.
//
// What that did NOT do is evict 26.1.0. Nine unrelated third-party packages
// depend on `@types/node` with UNBOUNDED ranges — happy-dom `>=20.0.0`,
// protobufjs `>=13.7.0`, buffer-image-size `*`, plus the `@types/*` wrappers
// (cacheable-request, fs-extra, keyv, responselike, ws, yauzl) — and pnpm
// resolves an unbounded range to the newest published version. Nothing in this
// repo can pin someone else's floor, so the second copy stays. Do not chase it
// again expecting the tree to shrink; that experiment has been run.
//
// It never mattered for correctness, which is the part worth not relitigating.
// Measured with `tsc --noEmit --traceResolution` in all six BEFORE they
// declared the dependency: zero references to the `@types+node@26.1.0` store
// path, 2.1k to 24.13.3. The mechanism, from the trace in packages/config:
// `vite/dist/node/index.d.ts` — served out of the 26.1.0-keyed vite copy —
// really does emit `/// <reference types="node" />`. But a type reference
// directive resolves against `typeRoots`, which are anchored at the TSCONFIG
// directory and walk UP (config/node_modules/@types →
// packages/node_modules/@types → <root>/node_modules/@types), never at the
// directory of the file that asked. It therefore landed on the root copy —
// 24.13.3, logged `primary: true`. The containing-file-relative fallback that
// would have found 26.1.0 never runs. Bare `node:*` specifiers never resolve
// as modules at all; they are satisfied by the ambient `declare module` blocks
// in the single `@types/node` the program loaded.
//
// Every package-local `@types/node` link is 24.13.3, so no package shadows the
// root. (A stale untracked `packages/<name>/node_modules` left behind by an old
// branch can still hold a 26.1.0 link; those directories have no package.json
// and are in no workspace glob, so they are install debris, not a shadow.)
//
// So the duplicate is dev-only install weight, not a types skew. Reproduce with:
//   cd packages/config && pnpm exec tsc --noEmit --traceResolution \
//     | grep -c '@types+node@26\.1\.0/'   # -> 0
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

function readActualState() {
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

// `pnpm-lock.yaml` is ~19k lines and this suite runs uncached in the required
// Static lane, so parse it once and hand every test the same snapshot. Lazy
// rather than module-scope so a malformed file fails the test that needs it
// instead of aborting the whole file at import time.
let cachedActualState;
function loadActualState() {
  cachedActualState ??= readActualState();
  return cachedActualState;
}

test('real tree: @types/node tracks the Node major this repo actually runs', () => {
  assert.deepEqual(collectViolations(loadActualState()), []);
});

test('real tree: every workspace package declaring @types/node goes through the catalog', () => {
  // The catalog only governs packages that opt in with "catalog:". A package
  // that hard-pins its own range keeps compiling against whatever it named, so
  // assert the resolutions rather than trusting the catalog entry alone.
  const { importerVersions, lockfileCatalog } = loadActualState();
  assert.ok(
    lockfileCatalog?.version,
    `pnpm-lock.yaml has no resolved catalog version for ${CATALOG_PACKAGE}; run pnpm install`
  );
  assert.ok(
    importerVersions.length > 0,
    'expected at least one workspace package to declare @types/node; if that is genuinely no longer true, this contract needs rewriting around the new layout'
  );
  assert.deepEqual([...new Set(importerVersions.map((entry) => entry.version))].sort(), [
    lockfileCatalog.version,
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
