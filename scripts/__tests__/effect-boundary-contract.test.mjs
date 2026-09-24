// Guard for docs/agents/effect-boundary.md (ADR-0004). Every rule the contract
// names this file for is checked here against the real tree, and each check
// asserts it saw at least one subject so it cannot pass vacuously.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRepoFile = (filePath) => readFileSync(path.join(repoRoot, filePath), 'utf8');

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'];
const DIAGNOSTICS_COMMAND = 'effect-tsgo diagnostics --project tsconfig.test.json --strict';
const LANGUAGE_SERVICE_PLUGIN = '@effect/language-service';
// The one module allowed to call the raw runner: it IS the Promise boundary.
const RUNNER_OWNER_PREFIX = 'packages/effect-kit/src/';
const RAW_RUNNER_CALL = /\bEffect\.run(?:Promise|PromiseExit|Sync|SyncExit|Fork|Callback)\b/u;
const UNSTABLE_IMPORT = /['"]effect\/unstable(?:\/[^'"]*)?['"]/u;

const trackedFiles = (...patterns) =>
  execFileSync('git', ['ls-files', '-z', '--', ...patterns], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file.length > 0);

const isProductionSource = (file) =>
  /\.(?:ts|tsx|mts|cts)$/u.test(file) &&
  !file.endsWith('.d.ts') &&
  !/(?:^|\/)(?:__tests__|e2e|test|tests)\//u.test(file) &&
  !/\.(?:test|spec|integration\.test|integration\.spec|stories)\.[cm]?tsx?$/u.test(file);

const readTsconfig = (file) => {
  const parsed = ts.parseConfigFileTextToJson(file, readRepoFile(file));
  if (parsed.error) {
    throw new Error(
      `${file} is not parseable: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n')}`
    );
  }
  return parsed.config;
};

const effectConsumers = () =>
  trackedFiles('apps/*/package.json', 'packages/*/package.json')
    .map((file) => ({ file, manifest: JSON.parse(readRepoFile(file)) }))
    .filter(({ manifest }) =>
      DEPENDENCY_FIELDS.some((field) => Object.hasOwn(manifest[field] ?? {}, 'effect'))
    );

test('effect and every @effect/* package are catalogued at one exact version', () => {
  const catalog = parseYaml(readRepoFile('pnpm-workspace.yaml')).catalog ?? {};
  const pins = Object.entries(catalog).filter(
    ([name]) => name === 'effect' || name.startsWith('@effect/')
  );
  assert.ok(
    pins.some(([name]) => name === 'effect'),
    'pnpm-workspace.yaml catalogues effect'
  );
  for (const [name, version] of pins) {
    assert.match(String(version), EXACT_VERSION, `${name} must be pinned exactly, not ${version}`);
  }
});

test('every package that depends on effect runs the Effect diagnostics in type-check', () => {
  const consumers = effectConsumers();
  assert.ok(consumers.length > 0, 'at least one workspace package depends on effect');
  for (const { file, manifest } of consumers) {
    const directory = path.dirname(file);
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (name === 'effect' || name.startsWith('@effect/')) {
          assert.equal(spec, 'catalog:', `${file} ${field}.${name} must use catalog:`);
        }
      }
    }
    assert.equal(
      manifest.devDependencies?.['@effect/tsgo'],
      'catalog:',
      `${file} must list @effect/tsgo as a catalog: devDependency`
    );
    assert.ok(
      manifest.scripts?.['type-check']?.endsWith(DIAGNOSTICS_COMMAND),
      `${file} type-check must end with "${DIAGNOSTICS_COMMAND}"`
    );
    const plugins = readTsconfig(`${directory}/tsconfig.json`).compilerOptions?.plugins ?? [];
    assert.ok(
      plugins.some((plugin) => plugin?.name === LANGUAGE_SERVICE_PLUGIN),
      `${directory}/tsconfig.json must declare the ${LANGUAGE_SERVICE_PLUGIN} plugin; ` +
        'without it effect-tsgo diagnostics checks 0 files and passes'
    );
  }
});

test('production code imports no effect/unstable module and calls Effect.run* only in effect-kit', () => {
  const sources = trackedFiles('apps', 'packages').filter(isProductionSource);
  let effectImporters = 0;
  let ownerRunnerCalls = 0;
  const failures = [];
  for (const file of sources) {
    const source = readRepoFile(file);
    if (!/['"]effect(?:\/[^'"]*)?['"]/u.test(source)) {
      continue;
    }
    effectImporters += 1;
    if (UNSTABLE_IMPORT.test(source)) {
      failures.push(`${file} imports effect/unstable/*; the contract must change first`);
    }
    if (RAW_RUNNER_CALL.test(source)) {
      if (file.startsWith(RUNNER_OWNER_PREFIX)) {
        ownerRunnerCalls += 1;
      } else {
        failures.push(
          `${file} calls Effect.run*; use runAtPromiseBoundary from @brainstrike/effect-kit`
        );
      }
    }
  }
  assert.ok(effectImporters > 0, 'the scan saw at least one module importing effect');
  assert.ok(ownerRunnerCalls > 0, 'the scan recognised the runner call inside effect-kit');
  assert.deepEqual(failures, []);
});

test('the raw-runner and unstable-import detectors fire on known violations', () => {
  assert.match('await Effect.runPromise(program, { signal })', RAW_RUNNER_CALL);
  assert.match('Effect.runSync(program)', RAW_RUNNER_CALL);
  assert.doesNotMatch('runtime.runPromise(program)', RAW_RUNNER_CALL);
  assert.match("import { Rpc } from 'effect/unstable/rpc';", UNSTABLE_IMPORT);
  assert.doesNotMatch("import { Effect } from 'effect';", UNSTABLE_IMPORT);
  assert.equal(isProductionSource('packages/x/src/a.ts'), true);
  assert.equal(isProductionSource('packages/x/src/__tests__/a.test.ts'), false);
  assert.equal(isProductionSource('packages/x/src/a.integration.test.ts'), false);
});

test('AGENTS.md routes the effect boundary contract exactly once', () => {
  const agents = readRepoFile('AGENTS.md');
  assert.equal(agents.split('docs/agents/effect-boundary.md').length - 1, 1);
});
