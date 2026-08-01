import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createSpawnInvocation } from '../spawn-command.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const editorSettingsPath = path.join(repoRoot, '.vscode/settings.json');
const rootPackagePath = path.join(repoRoot, 'package.json');
const workspacePath = path.join(repoRoot, 'pnpm-workspace.yaml');
const sourceExtensions = new Set(['.cjs', '.js', '.mjs', '.ts', '.tsx']);
const typescriptImport = /(?:from\s+|require\(\s*|import\(\s*)['"]typescript['"]/u;
// Exact patches are load-bearing: changing any compiler invalidates the
// diagnostic/timing evidence in docs/series-c-ts7-parity-findings.md. The
// guard must stay red until that parity sweep is rerun and these pins move with
// the recorded baseline.
const EXPECTED_COMPAT_CATALOG = 'npm:@typescript/typescript6@6.0.2';
const EXPECTED_LSP_CATALOG = 'npm:typescript@6.0.3';
const EXPECTED_NATIVE_CATALOG = 'npm:typescript@7.0.2';

function runCommand(command, args, cwd = repoRoot) {
  const invocation = createSpawnInvocation(command, args);
  return spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: 'utf8',
    shell: invocation.shell,
  });
}

function readMajor(command, args, cwd = repoRoot) {
  const result = runCommand(command, args, cwd);
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed: ${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim()}`
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const version = /Version\s+(?<major>\d+)\.\d+\.\d+/u.exec(output);
  assert.ok(version?.groups, `Could not parse a compiler version from: ${output.trim()}`);
  return Number(version.groups.major);
}

function workspaceManifests() {
  const manifests = [];
  for (const group of ['apps', 'packages']) {
    const groupPath = path.join(repoRoot, group);
    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packagePath = path.join(groupPath, entry.name, 'package.json');
      if (existsSync(packagePath)) {
        manifests.push({
          directory: path.dirname(packagePath),
          json: JSON.parse(readFileSync(packagePath, 'utf8')),
        });
      }
    }
  }
  return manifests;
}

function trackedSourceFiles() {
  const result = runCommand('git', ['ls-files', '-z', '--', 'apps', 'packages', 'scripts']);
  assert.ifError(result.error);
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr.trim()}`);
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .filter((file) => sourceExtensions.has(path.extname(file)))
    .map((file) => path.join(repoRoot, file));
}

function classicApiConsumers() {
  const files = trackedSourceFiles().filter((file) =>
    typescriptImport.test(readFileSync(file, 'utf8'))
  );

  return files.map((file) => {
    try {
      const compiler = createRequire(file)('typescript');
      const major = Number.parseInt(String(compiler.version).split('.')[0] ?? '', 10);
      return { file: path.relative(repoRoot, file), major };
    } catch (error) {
      return {
        file: path.relative(repoRoot, file),
        major: null,
        resolutionError: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function collectViolations(state) {
  const violations = [];
  if (state.rootPackage.devDependencies?.['@typescript/native'] !== 'catalog:') {
    violations.push('root must depend on the native compiler through @typescript/native: catalog:');
  }
  if (state.rootPackage.devDependencies?.['@typescript/old'] !== 'catalog:') {
    violations.push(
      'root must depend on @typescript/old through the catalog for a stable editor TSDK'
    );
  }
  if (state.nativeCatalog !== EXPECTED_NATIVE_CATALOG) {
    violations.push(
      `native compiler catalog pin changed from ${EXPECTED_NATIVE_CATALOG}; ` +
        'rerun TS6/TS7 parity and update the recorded baseline before accepting the new patch'
    );
  }
  if (state.compatCatalog !== EXPECTED_COMPAT_CATALOG) {
    violations.push(
      `compatibility compiler catalog pin changed from ${EXPECTED_COMPAT_CATALOG}; ` +
        'rerun TS6/TS7 parity and update the recorded baseline before accepting the new patch'
    );
  }
  if (state.lspCatalog !== EXPECTED_LSP_CATALOG) {
    violations.push(
      `LSP compiler catalog pin changed from ${EXPECTED_LSP_CATALOG}; ` +
        'rerun TS6/TS7 parity and the real-LSP controls before accepting the new patch'
    );
  }
  if (
    state.nativePackage.name !== 'typescript' ||
    normalizeBinEntry(state.nativePackage.bin?.tsc) !== 'bin/tsc'
  ) {
    violations.push('the native package must expose the tsc bin');
  }
  if (
    state.compatPackage.name !== '@typescript/typescript6' ||
    normalizeBinEntry(state.compatPackage.bin?.tsc6) !== 'bin/tsc6' ||
    'tsc' in (state.compatPackage.bin ?? {})
  ) {
    violations.push('the compatibility package must expose tsc6 without shadowing tsc');
  }
  if (state.nativeMajor !== 7 || state.leafNativeMajor !== 7) {
    violations.push('native tsc must report major 7 at both root and package scope');
  }
  if (state.compatMajor !== 6) {
    violations.push('compatibility tsc6 must report major 6');
  }
  if (state.editorTsdk !== 'node_modules/@typescript/old/lib') {
    violations.push('VS Code TSDK must point to node_modules/@typescript/old/lib');
  }
  if (!state.editorTsserverExists) {
    violations.push('VS Code TSDK must contain a resolvable tsserver.js');
  }
  if (state.typeCheckPackageCount < 40) {
    violations.push('type-check package discovery fell below the anti-vacuity floor of 40');
  }
  if (state.consumers.length < 8) {
    violations.push('classic TypeScript API consumer discovery fell below the floor of 8');
  }
  const wrongApiConsumers = state.consumers.filter((consumer) => consumer.major !== 6);
  if (wrongApiConsumers.length > 0) {
    violations.push(
      `classic TypeScript API consumers must resolve major 6: ${wrongApiConsumers
        .map((consumer) =>
          consumer.resolutionError
            ? `${consumer.file} (${consumer.resolutionError})`
            : `${consumer.file} (major ${String(consumer.major)})`
        )
        .join(', ')}`
    );
  }
  return violations;
}

function normalizeBinEntry(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/').replace(/^\.\//u, '') : null;
}

let cachedActualState;
function loadActualState() {
  if (cachedActualState) {
    return cachedActualState;
  }

  const editorSettings = JSON.parse(readFileSync(editorSettingsPath, 'utf8'));
  const editorTsdk = editorSettings['typescript.tsdk'];
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, 'utf8'));
  const workspaceCatalog = parseYaml(readFileSync(workspacePath, 'utf8')).catalog;
  const manifests = workspaceManifests();
  cachedActualState = {
    compatCatalog: workspaceCatalog?.typescript,
    compatMajor: readMajor('pnpm', ['exec', 'tsc6', '--version']),
    compatPackage: JSON.parse(
      readFileSync(path.join(repoRoot, 'node_modules/typescript/package.json'), 'utf8')
    ),
    consumers: classicApiConsumers(),
    editorTsdk,
    editorTsserverExists:
      typeof editorTsdk === 'string' &&
      existsSync(path.resolve(repoRoot, editorTsdk, 'tsserver.js')),
    leafNativeMajor: readMajor(
      'pnpm',
      ['exec', 'tsc', '--version'],
      path.join(repoRoot, 'packages/ui')
    ),
    lspCatalog: workspaceCatalog?.['@typescript/old'],
    nativeCatalog: workspaceCatalog?.['@typescript/native'],
    nativeMajor: readMajor('pnpm', ['exec', 'tsc', '--version']),
    nativePackage: JSON.parse(
      readFileSync(path.join(repoRoot, 'node_modules/@typescript/native/package.json'), 'utf8')
    ),
    rootPackage,
    typeCheckPackageCount: manifests.filter((manifest) =>
      /\btsc\b/u.test(manifest.json.scripts?.['type-check'] ?? '')
    ).length,
  };
  return cachedActualState;
}

test('real workspace uses the official TS7/TS6 side-by-side compiler wiring', () => {
  assert.deepEqual(collectViolations(loadActualState()), []);
});

test('money test: a TS6 API consumer resolving to the native compiler fails loudly', () => {
  const actualState = loadActualState();
  const consumers = actualState.consumers.map((consumer, index) =>
    index === 0 ? { ...consumer, major: 7 } : consumer
  );
  assert.match(
    collectViolations({ ...actualState, consumers }).join('\n'),
    /classic TypeScript API consumers must resolve major 6/u
  );
});

test('money test: a compatibility package that shadows tsc fails loudly', () => {
  const actualState = loadActualState();
  const compatPackage = {
    ...actualState.compatPackage,
    bin: { ...actualState.compatPackage.bin, tsc: './bin/tsc' },
  };
  assert.match(
    collectViolations({ ...actualState, compatPackage }).join('\n'),
    /without shadowing tsc/u
  );
});

test('money test: swapped compiler majors cannot report a valid installation', () => {
  const actualState = loadActualState();
  assert.match(
    collectViolations({ ...actualState, nativeMajor: 6 }).join('\n'),
    /native tsc must report major 7/u
  );
  assert.match(
    collectViolations({ ...actualState, compatMajor: 7 }).join('\n'),
    /compatibility tsc6 must report major 6/u
  );
});

test('money test: an unresolved classic API consumer is a readable violation', () => {
  const actualState = loadActualState();
  const consumers = actualState.consumers.map((consumer, index) =>
    index === 0
      ? { ...consumer, major: null, resolutionError: 'MODULE_NOT_FOUND: typescript' }
      : consumer
  );
  const report = collectViolations({ ...actualState, consumers }).join('\n');
  assert.match(report, /classic TypeScript API consumers must resolve major 6/u);
  assert.match(report, /MODULE_NOT_FOUND: typescript/u);
});

test('money test: compiler patch bumps require renewed parity evidence', () => {
  const actualState = loadActualState();
  assert.match(
    collectViolations({ ...actualState, nativeCatalog: 'npm:typescript@7.0.3' }).join('\n'),
    /rerun TS6\/TS7 parity/u
  );
  assert.match(
    collectViolations({ ...actualState, lspCatalog: 'npm:typescript@6.0.4' }).join('\n'),
    /real-LSP controls/u
  );
});

test('money test: editor TSDK drift cannot silently fall back to a bundled compiler', () => {
  const actualState = loadActualState();
  const report = collectViolations({
    ...actualState,
    editorTsdk: 'node_modules/typescript/lib',
    editorTsserverExists: false,
  }).join('\n');
  assert.match(report, /VS Code TSDK must point to node_modules\/@typescript\/old\/lib/u);
  assert.match(report, /VS Code TSDK must contain a resolvable tsserver\.js/u);
});
