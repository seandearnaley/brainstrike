import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rootPackagePath = path.join(repoRoot, 'package.json');
const workspacePath = path.join(repoRoot, 'pnpm-workspace.yaml');
const sourceExtensions = new Set(['.cjs', '.js', '.mjs', '.ts', '.tsx']);
const typescriptImport = /(?:from\s+|require\(\s*|import\(\s*)['"]typescript['"]/u;

function readMajor(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
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

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(entryPath));
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
}

function classicApiConsumers() {
  const files = ['apps', 'packages', 'scripts']
    .flatMap((group) => sourceFiles(path.join(repoRoot, group)))
    .filter((file) => typescriptImport.test(readFileSync(file, 'utf8')));

  return files.map((file) => {
    const compiler = createRequire(file)('typescript');
    const major = Number.parseInt(String(compiler.version).split('.')[0] ?? '', 10);
    return { file: path.relative(repoRoot, file), major };
  });
}

function collectViolations(state) {
  const violations = [];
  if (state.rootPackage.devDependencies?.['@typescript/native'] !== 'catalog:') {
    violations.push('root must depend on the native compiler through @typescript/native: catalog:');
  }
  if (!/^\s{2}'@typescript\/native': 'npm:typescript@7\.0\.2'\s*$/mu.test(state.workspace)) {
    violations.push('catalog must pin @typescript/native to npm:typescript@7.0.2');
  }
  if (!/^\s{2}typescript: 'npm:@typescript\/typescript6@6\.0\.2'\s*$/mu.test(state.workspace)) {
    violations.push('catalog must alias typescript to @typescript/typescript6@6.0.2');
  }
  if (state.nativePackage.name !== 'typescript' || state.nativePackage.bin?.tsc !== './bin/tsc') {
    violations.push('the native package must expose the tsc bin');
  }
  if (
    state.compatPackage.name !== '@typescript/typescript6' ||
    state.compatPackage.bin?.tsc6 !== './bin/tsc6' ||
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
        .map((consumer) => consumer.file)
        .join(', ')}`
    );
  }
  return violations;
}

const rootPackage = JSON.parse(readFileSync(rootPackagePath, 'utf8'));
const workspace = readFileSync(workspacePath, 'utf8');
const nativePackage = JSON.parse(
  readFileSync(path.join(repoRoot, 'node_modules/@typescript/native/package.json'), 'utf8')
);
const compatPackage = JSON.parse(
  readFileSync(path.join(repoRoot, 'node_modules/typescript/package.json'), 'utf8')
);
const manifests = workspaceManifests();
const actualState = {
  compatMajor: readMajor(path.join(repoRoot, 'node_modules/.bin/tsc6'), ['--version']),
  compatPackage,
  consumers: classicApiConsumers(),
  leafNativeMajor: readMajor(
    'pnpm',
    ['exec', 'tsc', '--version'],
    path.join(repoRoot, 'packages/ui')
  ),
  nativeMajor: readMajor(path.join(repoRoot, 'node_modules/.bin/tsc'), ['--version']),
  nativePackage,
  rootPackage,
  typeCheckPackageCount: manifests.filter((manifest) =>
    /\btsc\b/u.test(manifest.json.scripts?.['type-check'] ?? '')
  ).length,
  workspace,
};

test('real workspace uses the official TS7/TS6 side-by-side compiler wiring', () => {
  assert.deepEqual(collectViolations(actualState), []);
});

test('money test: a TS6 API consumer resolving to the native compiler fails loudly', () => {
  const consumers = actualState.consumers.map((consumer, index) =>
    index === 0 ? { ...consumer, major: 7 } : consumer
  );
  assert.match(
    collectViolations({ ...actualState, consumers }).join('\n'),
    /classic TypeScript API consumers must resolve major 6/u
  );
});

test('money test: a compatibility package that shadows tsc fails loudly', () => {
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
  assert.match(
    collectViolations({ ...actualState, nativeMajor: 6 }).join('\n'),
    /native tsc must report major 7/u
  );
  assert.match(
    collectViolations({ ...actualState, compatMajor: 7 }).join('\n'),
    /compatibility tsc6 must report major 6/u
  );
});
