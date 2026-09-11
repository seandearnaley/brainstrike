import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Shared production code executes in Electron's bundled Node runtime as well
// as the newer CI toolchain. Types must describe the production API floor,
// not APIs that happen to exist only in the build/test executable. The required
// native Electron smoke test checks this declaration against process.versions.
// Historical dependency boundary (BST-1294, measured 2026-08-20): spikes/*
// are intentionally outside workspace globs and lockfile importers. Their
// published prototype findings used independent TS versions; adopting them
// into the workspace to police typings would erase that isolation. They are
// not shipped or run by Turbo, although source hygiene still scans them.
// The Node 26 toolchain does not make their separate manifests runtime proof.
//
// The same investigation found third-party unbounded @types/node dependencies
// retaining 26.1.0 after workspace peers were aligned. Real --traceResolution
// found zero compiler references to that private copy: TypeScript resolves
// explicit root typeRoots, not every pnpm-store version. Do not repeat lockfile
// deduplication as an API-safety fix. Guard actual importer/catalog resolution
// and the real compiler API surface instead; historical counts are not pins.
const CATALOG_PACKAGE = '@types/node';
const APPLICATION_ENGINE_MANIFESTS = [
  'package.json',
  'apps/web/package.json',
  'packages/mcp-app-host/package.json',
  'packages/mcp-app-host-ui/package.json',
  'packages/mcp-test-lab/package.json',
];

// Root and app manifests are discovered so a new app cannot bypass the
// bounded toolchain/hosting engine check. Library-consumer floors remain
// outside this check; their actual workspace typings still use the catalog.
function discoverEngineManifests() {
  const apps = readdirSync(path.join(repoRoot, 'apps'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `apps/${entry.name}/package.json`)
    .filter((manifest) => existsSync(path.join(repoRoot, manifest)))
    .sort();
  return [...new Set([...APPLICATION_ENGINE_MANIFESTS, ...apps])];
}

const ENGINE_MANIFESTS = discoverEngineManifests();

// Third-party private typings and historical spikes do not select the ambient
// types used by workspace compilation. Every workspace importer declaring
// @types/node must continue to resolve the shared catalog version.
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

function collectViolations({
  nvmrc,
  engines,
  catalogRange,
  lockfileCatalog,
  importerVersions,
  applicationNodeMajor,
}) {
  const violations = [];

  const nvmrcMajor = /^(?<major>\d+)\b/u.exec(String(nvmrc ?? '').trim())?.groups?.major;
  const toolchainMajor = nvmrcMajor === undefined ? null : Number(nvmrcMajor);
  const runtimeMajor = applicationNodeMajor ?? toolchainMajor;
  if (
    applicationNodeMajor !== undefined &&
    (!Number.isInteger(applicationNodeMajor) ||
      applicationNodeMajor <= 0 ||
      applicationNodeMajor > toolchainMajor)
  ) {
    violations.push(
      'Application Node API major must be a positive integer supported by the toolchain'
    );
  }
  if (toolchainMajor === null) {
    violations.push(`.nvmrc must name a Node major, found ${JSON.stringify(nvmrc)}`);
  }

  // Hosting can admit the production API major alongside the managed build
  // runtime, but every arm remains bounded and no unrelated major is admitted.
  for (const { manifest, range } of engines) {
    const majors = String(range ?? '')
      .split('||')
      .map(impliedEngineMajor);
    if (majors.some((major) => major === null)) {
      violations.push(
        `${manifest} engines.node must pin exactly one Node major per bounded range arm`
      );
      continue;
    }
    if (APPLICATION_ENGINE_MANIFESTS.includes(manifest) && !majors.includes(runtimeMajor)) {
      violations.push(`${manifest} must include the deployed Node ${runtimeMajor} runtime`);
    }
    if (
      !majors.includes(toolchainMajor) ||
      majors.some((major) => major !== toolchainMajor && major !== runtimeMajor)
    ) {
      violations.push(
        `${manifest} engines.node implies Node ${majors.join(', ')} but .nvmrc names ${toolchainMajor}`
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
    applicationNodeMajor: JSON.parse(
      readFileSync(path.join(repoRoot, 'apps/desktop/package.json'), 'utf8')
    ).config?.nodeRuntimeMajor,
    catalogRange: workspace?.catalog?.[CATALOG_PACKAGE],
    engines: ENGINE_MANIFESTS.map((manifest) => ({
      manifest,
      range: JSON.parse(readFileSync(path.join(repoRoot, manifest), 'utf8')).engines?.node,
    })),
    importerVersions,
    lockedRuntime: lockfile.importers?.['.']?.devDependencies?.node,
    lockfileCatalog: lockfile.catalogs?.default?.[CATALOG_PACKAGE],
    managedRuntime: JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).devEngines
      ?.runtime,
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

test('Node 26 tooling does not permit Node 26-only APIs in the Node 24 application runtime', () => {
  const state = {
    applicationNodeMajor: 24,
    catalogRange: '^24.13.3',
    engines: [{ manifest: 'apps/desktop/package.json', range: '>=26.8.2 <27' }],
    importerVersions: [{ id: 'apps/desktop', version: '24.13.3' }],
    lockfileCatalog: { specifier: '^24.13.3', version: '24.13.3' },
    nvmrc: '26.8.2',
  };
  assert.deepEqual(collectViolations(state), []);
  assert.match(collectViolations({ ...state, catalogRange: '^26.5.1' }).join('\n'), /major skew/u);
});

test('application API floor is declared explicitly', () => {
  assert.ok(Number.isInteger(loadActualState().applicationNodeMajor));
});

test('the real compiler accepts the production Node API and rejects Node 26-only imports', () => {
  const fileName = path.join(repoRoot, '.node-api-contract.ts');
  function diagnostics(source) {
    const options = {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2023,
      typeRoots: [path.join(repoRoot, 'node_modules/@types')],
      types: ['node'],
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, ...rest) =>
      name === fileName
        ? ts.createSourceFile(name, source, languageVersion, true)
        : getSourceFile(name, languageVersion, ...rest);
    return ts
      .getPreEmitDiagnostics(ts.createProgram([fileName], options, host))
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  }
  assert.deepEqual(diagnostics("import { readFile } from 'node:fs/promises'; void readFile;"), []);
  assert.ok(
    diagnostics("import { dlopen } from 'node:ffi'; void dlopen;").some((message) =>
      message.includes("Cannot find module 'node:ffi'")
    )
  );
});

test('managed execution pins the exact qualified runtime and lock resolution', () => {
  const state = loadActualState();
  assert.deepEqual(state.managedRuntime, {
    name: 'node',
    onFail: 'download',
    version: state.nvmrc.trim(),
  });
  assert.deepEqual(state.lockedRuntime, {
    specifier: `runtime:${state.nvmrc.trim()}`,
    version: `runtime:${state.nvmrc.trim()}`,
  });
});

test('the hosted range cannot silently admit an unrelated runtime', () => {
  const state = loadActualState();
  const engines = [{ manifest: 'apps/web/package.json', range: '>=24.20.0 <25 || >=26.8.2 <27' }];
  assert.deepEqual(collectViolations({ ...state, engines }), []);
  assert.ok(
    collectViolations({
      ...state,
      engines: [{ ...engines[0], range: `${engines[0].range} || >=25.0.0 <26` }],
    }).length > 0
  );
});

for (const manifest of APPLICATION_ENGINE_MANIFESTS) {
  test(`${manifest} retains the deployed runtime alongside the toolchain`, () => {
    const state = loadActualState();
    const engines = state.engines.map((entry) =>
      entry.manifest === manifest ? { ...entry, range: '>=26.8.2 <27' } : entry
    );
    assert.match(
      collectViolations({ ...state, engines }).join('\n'),
      /must include the deployed Node/u
    );
  });
}
