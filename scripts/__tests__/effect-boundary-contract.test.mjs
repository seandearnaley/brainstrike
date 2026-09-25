// Guard for docs/agents/effect-boundary.md (ADR-0004). Every rule the contract
// names this file for is checked here against the real tree, and each check
// asserts it saw at least one subject so it cannot pass vacuously.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRepoFile = (filePath) => readFileSync(path.join(repoRoot, filePath), 'utf8');

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u;
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
// The diagnostics run on the widest program the package type-checks:
// tsconfig.test.json when it has one, else tsconfig.json.
const DIAGNOSTICS_COMMAND =
  /effect-tsgo diagnostics --project (tsconfig\.test\.json|tsconfig\.json) --strict$/u;
const LANGUAGE_SERVICE_PLUGIN = '@effect/language-service';
// The one package allowed to run effects: it IS the Promise boundary.
const RUNNER_OWNER_PREFIX = 'packages/effect-kit/src/';
// Every v4 runner, `...With` variants included: runPromise, runSyncExitWith, ...
const RAW_RUNNER_METHOD = /^run[A-Z]/u;
const isEffectPackage = (name) => name === 'effect' || name.startsWith('@effect/');
const isEffectModule = (specifier) => specifier === 'effect' || specifier.startsWith('effect/');
// The contract's import surface: the barrel and the test kit. Everything else
// (`effect/unstable/*`, deep `effect/Schema`-style paths) needs a contract change.
const ALLOWED_EFFECT_MODULES = new Set(['effect', 'effect/testing']);

const trackedFiles = (...patterns) =>
  execFileSync('git', ['ls-files', '-z', '--', ...patterns], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file.length > 0);

const isProductionSource = (file) =>
  /\.(?:ts|tsx|mts|cts)$/u.test(file) &&
  !file.endsWith('.d.ts') &&
  !/(?:^|\/)(?:__tests__|e2e|test|tests)\//u.test(file) &&
  !/\.(?:test|spec|integration\.test|integration\.spec|stories)\.[cm]?tsx?$/u.test(file);

/** The effective compiler options, `extends` chain included, of the config diagnostics runs on. */
const effectiveCompilerOptions = (file) => {
  const failures = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(repoRoot, file),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => failures.push(diagnostic),
    }
  );
  if (!parsed || failures.length > 0) {
    throw new Error(`${file} could not be resolved as a tsconfig`);
  }
  return parsed.options;
};

const effectConsumers = () =>
  trackedFiles('apps/*/package.json', 'packages/*/package.json', 'packages/config/*/package.json')
    .map((file) => ({ file, manifest: JSON.parse(readRepoFile(file)) }))
    .filter(({ manifest }) =>
      DEPENDENCY_FIELDS.some((field) => Object.keys(manifest[field] ?? {}).some(isEffectPackage))
    );

/**
 * Reads one module's use of `effect` from its AST, so an aliased import
 * (`import { Effect as Fx }`, `import * as E`) cannot slip past a text match
 * and an unrelated `runtime.runPromise` is not mistaken for one. A runner counts
 * wherever it is referenced (`pipe(program, Effect.runPromise)`,
 * `Effect['runSync']`, `const { runFork } = Effect`), not only where called.
 * Dynamic imports and re-exports of `effect` are reported separately: either
 * would hand a runner to code this scan cannot follow.
 */
function analyzeEffectUsage(fileName, sourceText) {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const effectLocals = new Set();
  const namespaceLocals = new Set();
  const usage = {
    disallowedImports: [],
    dynamicImports: [],
    importsEffect: false,
    managedRuntime: false,
    namespaceEscapes: [],
    reexports: [],
    runnerUses: [],
  };
  for (const statement of sourceFile.statements) {
    const specifier = statement.moduleSpecifier;
    if (!(specifier && ts.isStringLiteral(specifier) && isEffectModule(specifier.text))) {
      continue;
    }
    usage.importsEffect = true;
    if (!ALLOWED_EFFECT_MODULES.has(specifier.text)) {
      usage.disallowedImports.push(specifier.text);
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      usage.reexports.push(specifier.text);
    }
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
    if (!clause || clause.isTypeOnly || !clause.namedBindings) {
      continue;
    }
    if (ts.isNamespaceImport(clause.namedBindings)) {
      namespaceLocals.add(clause.namedBindings.name.text);
      continue;
    }
    for (const element of clause.namedBindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (element.isTypeOnly) {
        continue;
      }
      if (imported === 'Effect') {
        effectLocals.add(element.name.text);
      }
      if (imported === 'ManagedRuntime') {
        usage.managedRuntime = true;
      }
    }
  }
  const effectBindings = new Set([...effectLocals, ...namespaceLocals]);
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      !statement.isTypeOnly &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const local = (element.propertyName ?? element.name).text;
        if (!element.isTypeOnly && effectBindings.has(local)) {
          usage.reexports.push(local);
        }
      }
    }
    if (
      ts.isExportAssignment(statement) &&
      ts.isIdentifier(statement.expression) &&
      effectBindings.has(statement.expression.text)
    ) {
      usage.reexports.push(statement.expression.text);
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteralLike(statement.moduleReference.expression) &&
      isEffectModule(statement.moduleReference.expression.text)
    ) {
      usage.importsEffect = true;
      usage.dynamicImports.push(statement.moduleReference.expression.text);
    }
  }
  const isEffectNamespace = (node) =>
    (ts.isIdentifier(node) && effectLocals.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === 'Effect' &&
      ts.isIdentifier(node.expression) &&
      namespaceLocals.has(node.expression.text));
  // An Effect namespace used as a value rather than through a member (`const
  // Fx = Effect`, `helper(Effect)`, `{ ...Effect }`) would carry its runners past
  // this scan, so any bare use counts. Destructuring is read member by member
  // above, and import/export specifiers are handled with the declarations.
  const isEscapingNamespace = (node) => {
    const bare =
      (ts.isIdentifier(node) && effectBindings.has(node.text)) ||
      (ts.isPropertyAccessExpression(node) && isEffectNamespace(node));
    if (!bare) {
      return false;
    }
    const { parent } = node;
    if (
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isExportAssignment(parent) ||
      ts.isQualifiedName(parent) ||
      ts.isTypeQueryNode(parent)
    ) {
      return false;
    }
    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === node
    ) {
      return false;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
      return false;
    }
    // Destructuring the Effect namespace is read member by member above;
    // destructuring a module namespace (`const { Effect: Fx } = E`) is not.
    return !(
      isEffectNamespace(node) &&
      ts.isVariableDeclaration(parent) &&
      parent.initializer === node &&
      ts.isObjectBindingPattern(parent.name)
    );
  };
  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'ManagedRuntime' &&
      ts.isIdentifier(node.expression) &&
      namespaceLocals.has(node.expression.text)
    ) {
      usage.managedRuntime = true;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      RAW_RUNNER_METHOD.test(node.name.text) &&
      isEffectNamespace(node.expression)
    ) {
      usage.runnerUses.push(node.getText(sourceFile));
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      RAW_RUNNER_METHOD.test(node.argumentExpression.text) &&
      isEffectNamespace(node.expression)
    ) {
      usage.runnerUses.push(node.getText(sourceFile));
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isEffectNamespace(node.initializer)
    ) {
      for (const element of node.name.elements) {
        const property = element.propertyName ?? element.name;
        if (ts.isIdentifier(property) && RAW_RUNNER_METHOD.test(property.text)) {
          usage.runnerUses.push(`${node.initializer.getText(sourceFile)}.${property.text}`);
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      isEffectModule(node.arguments[0].text)
    ) {
      usage.importsEffect = true;
      usage.dynamicImports.push(node.arguments[0].text);
      if (!ALLOWED_EFFECT_MODULES.has(node.arguments[0].text)) {
        usage.disallowedImports.push(node.arguments[0].text);
      }
    }
    if (isEscapingNamespace(node)) {
      usage.namespaceEscapes.push(node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return usage;
}

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
        if (isEffectPackage(name)) {
          assert.equal(spec, 'catalog:', `${file} ${field}.${name} must use catalog:`);
        }
      }
    }
    assert.equal(
      manifest.devDependencies?.['@effect/tsgo'],
      'catalog:',
      `${file} must list @effect/tsgo as a catalog: devDependency`
    );
    const project = manifest.scripts?.['type-check']?.match(DIAGNOSTICS_COMMAND)?.[1];
    assert.ok(project, `${file} type-check must end with a match for ${DIAGNOSTICS_COMMAND}`);
    const widest = existsSync(path.join(repoRoot, directory, 'tsconfig.test.json'))
      ? 'tsconfig.test.json'
      : 'tsconfig.json';
    assert.equal(project, widest, `${file} must run the diagnostics on ${widest}`);
    // The EFFECTIVE options of that project must carry the plugin, whether
    // declared there or inherited through `extends`.
    const plugins = effectiveCompilerOptions(`${directory}/${project}`).plugins ?? [];
    assert.ok(
      plugins.some((plugin) => plugin?.name === LANGUAGE_SERVICE_PLUGIN),
      `${directory}/${project} must resolve the ${LANGUAGE_SERVICE_PLUGIN} plugin; ` +
        'without it effect-tsgo diagnostics checks 0 files and passes'
    );
  }
});

test('production code imports only effect and effect/testing and runs effects only in effect-kit', () => {
  const sources = trackedFiles('apps', 'packages').filter(isProductionSource);
  let effectImporters = 0;
  let ownerRunnerCalls = 0;
  const failures = [];
  for (const file of sources) {
    const source = readRepoFile(file);
    if (!source.includes('effect')) {
      continue;
    }
    const usage = analyzeEffectUsage(file, source);
    if (!usage.importsEffect) {
      continue;
    }
    effectImporters += 1;
    for (const specifier of usage.disallowedImports) {
      failures.push(
        `${file} imports ${specifier}; only effect and effect/testing are allowed until the contract changes`
      );
    }
    if (file.startsWith(RUNNER_OWNER_PREFIX)) {
      ownerRunnerCalls += usage.runnerUses.length;
      continue;
    }
    for (const use of usage.runnerUses) {
      failures.push(`${file} uses ${use}; use runAtPromiseBoundary from @brainstrike/effect-kit`);
    }
    for (const specifier of usage.dynamicImports) {
      failures.push(`${file} imports ${specifier} dynamically; import it statically`);
    }
    for (const namespaceEscape of usage.namespaceEscapes) {
      failures.push(
        `${file} passes ${namespaceEscape} around as a value; reference its members directly`
      );
    }
    for (const specifier of usage.reexports) {
      failures.push(`${file} re-exports ${specifier}; import effect where it is used`);
    }
    if (usage.managedRuntime) {
      failures.push(
        `${file} uses ManagedRuntime; runtimes are built only in @brainstrike/effect-kit`
      );
    }
  }
  assert.ok(effectImporters > 0, 'the scan saw at least one module importing effect');
  assert.ok(ownerRunnerCalls > 0, 'the scan recognised the runner call inside effect-kit');
  assert.deepEqual(failures, []);
});

test('the effect usage detector fires on known violations and ignores look-alikes', () => {
  const runnerCalls = (source) => analyzeEffectUsage('probe.ts', source).runnerUses;
  assert.deepEqual(
    runnerCalls("import { Effect } from 'effect';\nawait Effect.runPromise(program, { signal });"),
    ['Effect.runPromise']
  );
  assert.deepEqual(runnerCalls("import { Effect as Fx } from 'effect';\nFx.runSync(program);"), [
    'Fx.runSync',
  ]);
  assert.deepEqual(runnerCalls("import * as E from 'effect';\nE.Effect.runFork(program);"), [
    'E.Effect.runFork',
  ]);
  assert.deepEqual(
    runnerCalls("import { Effect } from 'effect';\nruntime.runPromise(Effect.gen(work));"),
    []
  );
  assert.deepEqual(runnerCalls('const Effect = local;\nEffect.runPromise(program);'), []);
  assert.deepEqual(
    runnerCalls(
      [
        "import { Effect } from 'effect';",
        'Effect.runPromiseWith(services)(program);',
        'program.pipe(Effect.runPromise);',
        "Effect['runSyncExit'](program);",
        'const { runFork, succeed } = Effect;',
        'const { runCallbackWith: callback } = Effect;',
      ].join('\n')
    ),
    [
      'Effect.runPromiseWith',
      'Effect.runPromise',
      "Effect['runSyncExit']",
      'Effect.runFork',
      'Effect.runCallbackWith',
    ]
  );
  assert.deepEqual(runnerCalls("import { Effect } from 'effect';\nEffect.runtime;"), []);
  const probe = (source) => analyzeEffectUsage('probe.ts', source);
  assert.deepEqual(probe("import { Schema } from 'effect/Schema';").disallowedImports, [
    'effect/Schema',
  ]);
  assert.deepEqual(probe("import { TestClock } from 'effect/testing';").disallowedImports, []);
  assert.deepEqual(
    probe(
      [
        "import { Effect } from 'effect';",
        'const Fx = Effect;',
        'helper(Effect);',
        'Effect.succeed(1);',
        'const { succeed } = Effect;',
        'type Program = Effect.Effect<number>;',
      ].join('\n')
    ).namespaceEscapes,
    ['Effect', 'Effect']
  );
  assert.deepEqual(
    probe("import * as E from 'effect';\nconst { Effect: Fx } = E;\nE.Effect.succeed(1);")
      .namespaceEscapes,
    ['E']
  );
  assert.deepEqual(
    probe("import { Effect } from 'effect';\nexport { Effect };\nexport { Effect as Fx };")
      .reexports,
    ['Effect', 'Effect']
  );
  assert.deepEqual(probe("import E = require('effect');").dynamicImports, ['effect']);
  assert.deepEqual(probe("const E = require('effect/Schema');").disallowedImports, [
    'effect/Schema',
  ]);
  assert.deepEqual(
    analyzeEffectUsage('probe.ts', "const { Effect } = await import('effect');").dynamicImports,
    ['effect']
  );
  assert.deepEqual(
    analyzeEffectUsage(
      'probe.ts',
      "export { Effect } from 'effect';\nexport type { Schema } from 'effect';"
    ).reexports,
    ['effect']
  );
  assert.equal(
    analyzeEffectUsage('probe.ts', "import { ManagedRuntime } from 'effect';").managedRuntime,
    true
  );
  assert.equal(
    analyzeEffectUsage('probe.ts', "import * as E from 'effect';\nE.ManagedRuntime.make(layer);")
      .managedRuntime,
    true
  );
  assert.deepEqual(
    analyzeEffectUsage('probe.ts', "import { Rpc } from 'effect/unstable/rpc';").disallowedImports,
    ['effect/unstable/rpc']
  );
  assert.equal(
    analyzeEffectUsage('probe.ts', "const tag = 'effect';\nexport { tag };").importsEffect,
    false
  );
  assert.equal(isProductionSource('packages/x/src/a.ts'), true);
  assert.equal(isProductionSource('packages/x/src/__tests__/a.test.ts'), false);
  assert.equal(isProductionSource('packages/x/src/a.integration.test.ts'), false);
});

test('AGENTS.md routes the effect boundary contract exactly once', () => {
  const agents = readRepoFile('AGENTS.md');
  assert.equal(agents.split('docs/agents/effect-boundary.md').length - 1, 1);
});

test('desktop composition refactors keep lifecycle owners and require a separate Layer decision', () => {
  const contract = readRepoFile('docs/agents/effect-boundary.md');
  const section = contract.match(/### Desktop composition refactors\n([\s\S]*?)(?:\n### |$)/u)?.[1];
  assert.ok(section, 'effect boundary contract must have desktop composition refactor rules');
  assert.match(section, /pre-ready[\s\S]*app-ready/u);
  assert.match(section, /runShutdownSequence[\s\S]*factory reset/u);
  assert.match(section, /Layer[\s\S]*separate decision/u);
  assert.match(section, /current startup-failure, reset and stale DB-client behavior/u);
});
