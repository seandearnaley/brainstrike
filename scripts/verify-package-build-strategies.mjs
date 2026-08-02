#!/usr/bin/env node
// Guard the R10/BST-1014 build ruling:
//
//   * non-native typed TypeScript libraries build with `tsc -b`/`tsc --build`;
//   * tsup is reserved for packages that deliberately produce bundled runtime
//     artifacts, and every tsup invocation has one package-local config;
//   * package-local tsup configs, dependencies, and watch commands may not stay
//     behind after a library moves to TypeScript emit;
//   * libraries using the shared node-library config emit Node-compatible ESM.
//
// The bundled-package budget is a count, not a package registry. The build
// command remains the single source of truth for classification. Growing the
// budget requires a reviewed architectural decision, while renames and package
// moves do not require updating a second identity list.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { packageManifestPaths } from './verify-catalog-references.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSC_BUILD_RE = /\btsc\s+(?:-b\b|--build\b)/;
const TSUP_INVOCATION_RE = /(?:^|[\s(/])tsup(?:\s|$)/;
const NATIVE_BUILD_RE = /\bnode-gyp\s+rebuild\b/;
const NODE_LIBRARY_CONFIG = path.join('packages', 'config', 'tsconfig', 'node-library.json');
const TS_SOURCE_EXTENSIONS = Object.freeze(['.ts', '.tsx', '.mts', '.cts']);

// Anti-vacuity floors. Lowering one is a deliberate architecture change, not a
// way to make a broken discovery pass.
export const MIN_TYPED_BUILD_PACKAGES = 41;
export const MIN_TSC_LIBRARY_PACKAGES = 31;
export const MIN_NODE_ESM_LIBRARY_PACKAGES = 15;
export const EXPECTED_BUNDLED_PACKAGES = 8;

function parseJsonFile(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `verify-package-build-strategies.mjs could not parse ${label}: ${error.message}. ` +
        'An unreadable build declaration is an unknown state, not a clean one.'
    );
  }
}

function exportTreeDeclaresTypes(value) {
  if (Array.isArray(value)) {
    return value.some(exportTreeDeclaresTypes);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return Object.entries(value).some(
    ([key, child]) => key === 'types' || exportTreeDeclaresTypes(child)
  );
}

function isTypedBuildPackage(manifest) {
  return (
    typeof manifest.scripts?.build === 'string' &&
    (typeof manifest.types === 'string' || exportTreeDeclaresTypes(manifest.exports))
  );
}

function resolvesToSharedNodeLibraryConfig(packageDir, repoRoot, tsconfig) {
  if (typeof tsconfig.extends !== 'string') {
    return false;
  }
  const resolved = path.resolve(packageDir, tsconfig.extends);
  return resolved === path.join(repoRoot, NODE_LIBRARY_CONFIG);
}

/** Discover the typed build surface from workspace manifests, never a registry. */
export function discoverPackageBuildStrategies(repoRoot = REPO_ROOT) {
  const packages = [];
  for (const manifestPath of packageManifestPaths(repoRoot)) {
    const relativeManifestPath = path.relative(repoRoot, manifestPath);
    const manifest = parseJsonFile(manifestPath, relativeManifestPath);
    if (!isTypedBuildPackage(manifest)) {
      continue;
    }

    const packageDir = path.dirname(manifestPath);
    const buildScript = manifest.scripts.build;
    const devScript = manifest.scripts?.dev ?? '';
    const tsconfigPath = path.join(packageDir, 'tsconfig.json');
    const tsupConfigPath = path.join(packageDir, 'tsup.config.ts');
    const tsconfig = existsSync(tsconfigPath)
      ? parseJsonFile(tsconfigPath, path.relative(repoRoot, tsconfigPath))
      : null;

    packages.push({
      buildScript,
      devScript,
      hasNodeLibraryConfig:
        tsconfig !== null && resolvesToSharedNodeLibraryConfig(packageDir, repoRoot, tsconfig),
      hasTscBuild: TSC_BUILD_RE.test(buildScript),
      hasTsupConfig: existsSync(tsupConfigPath),
      hasTsupDependency:
        manifest.dependencies?.tsup !== undefined || manifest.devDependencies?.tsup !== undefined,
      hasTsupInvocation: TSUP_INVOCATION_RE.test(buildScript),
      isNative: manifest.gypfile === true || NATIVE_BUILD_RE.test(buildScript),
      manifest,
      manifestPath: relativeManifestPath,
      name: manifest.name ?? path.relative(repoRoot, packageDir),
      packageDir,
      tsconfigPath,
      tsupConfigPath,
    });
  }
  return packages;
}

function readConfiguredSourceFiles(tsconfigPath) {
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.formatDiagnostic(read.error, diagnosticHost));
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfigPath));
  if (parsed.errors.length > 0) {
    throw new Error(ts.formatDiagnostics(parsed.errors, diagnosticHost));
  }
  return parsed.fileNames.filter((file) => TS_SOURCE_EXTENSIONS.includes(path.extname(file)));
}

const diagnosticHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => REPO_ROOT,
  getNewLine: () => '\n',
};

function relativeSpecifierTargetsTypescript(sourcePath, specifier) {
  const withoutQuery = specifier.split(/[?#]/u, 1)[0];
  const absolute = path.resolve(path.dirname(sourcePath), withoutQuery);
  const direct = TS_SOURCE_EXTENSIONS.some((extension) => existsSync(`${absolute}${extension}`));
  const indexed =
    existsSync(absolute) &&
    statSync(absolute).isDirectory() &&
    TS_SOURCE_EXTENSIONS.some((extension) => existsSync(path.join(absolute, `index${extension}`)));
  return direct || indexed;
}

function collectRelativeModuleSpecifiers(sourcePath) {
  const source = readFileSync(sourcePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const specifiers = [];
  const add = (literal) => {
    if (literal && ts.isStringLiteralLike(literal) && literal.text.startsWith('.')) {
      specifiers.push({
        line: sourceFile.getLineAndCharacterOfPosition(literal.getStart()).line + 1,
        text: literal.text,
      });
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function findNodeLibrarySpecifierViolations(pkg, repoRoot) {
  const violations = [];
  const configPaths = [pkg.tsconfigPath, path.join(pkg.packageDir, 'tsconfig.test.json')].filter(
    existsSync
  );
  const sourceFiles = new Set(configPaths.flatMap(readConfiguredSourceFiles));
  for (const sourcePath of sourceFiles) {
    for (const specifier of collectRelativeModuleSpecifiers(sourcePath)) {
      if (!relativeSpecifierTargetsTypescript(sourcePath, specifier.text)) {
        continue;
      }
      violations.push({
        kind: 'extensionless-node-esm',
        location: `${path.relative(repoRoot, sourcePath)}:${specifier.line}`,
        packageName: pkg.name,
        value: specifier.text,
      });
    }
  }
  return violations;
}

function distCodeTargets(value, found = []) {
  if (typeof value === 'string') {
    if (value.startsWith('./dist/') && /\.(?:mjs|cjs)$/u.test(value)) {
      found.push(value);
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      distCodeTargets(child, found);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      distCodeTargets(child, found);
    }
  }
  return found;
}

/** Return every build-strategy violation; floors throw before a vacuous scan. */
export function findPackageBuildStrategyViolations({
  enforceBudget = true,
  enforceFloors = true,
  repoRoot = REPO_ROOT,
} = {}) {
  const packages = discoverPackageBuildStrategies(repoRoot);
  const bundled = packages.filter((pkg) => pkg.hasTsupInvocation);
  const tscLibraries = packages.filter(
    (pkg) => !pkg.isNative && pkg.hasTscBuild && !pkg.hasTsupInvocation
  );
  const nodeLibraries = packages.filter((pkg) => pkg.hasNodeLibraryConfig);

  if (enforceFloors && packages.length < MIN_TYPED_BUILD_PACKAGES) {
    throw new Error(
      `Refusing to run: discovered ${packages.length} typed build package(s), below the floor of ` +
        `${MIN_TYPED_BUILD_PACKAGES}. A collapsed workspace scan would report a vacuous green.`
    );
  }
  if (enforceFloors && tscLibraries.length < MIN_TSC_LIBRARY_PACKAGES) {
    throw new Error(
      `Refusing to run: discovered ${tscLibraries.length} tsc-only typed library package(s), below the floor ` +
        `of ${MIN_TSC_LIBRARY_PACKAGES}. The canonical library class may not disappear silently.`
    );
  }
  if (enforceFloors && nodeLibraries.length < MIN_NODE_ESM_LIBRARY_PACKAGES) {
    throw new Error(
      `Refusing to run: discovered ${nodeLibraries.length} node-library tsconfig consumer(s), below the floor ` +
        `of ${MIN_NODE_ESM_LIBRARY_PACKAGES}. Node-compatible ESM checks would otherwise inspect too little.`
    );
  }

  const violations = [];
  if (enforceBudget && bundled.length !== EXPECTED_BUNDLED_PACKAGES) {
    violations.push({
      kind: 'bundled-package-count',
      location: 'workspace package manifests',
      packageName: 'workspace',
      value: `${bundled.length} (expected ${EXPECTED_BUNDLED_PACKAGES})`,
    });
  }

  for (const pkg of packages) {
    if (!(pkg.isNative || pkg.hasTscBuild || pkg.hasTsupInvocation)) {
      violations.push({
        kind: 'unsupported-build',
        location: `${pkg.manifestPath} [scripts.build]`,
        packageName: pkg.name,
        value: pkg.buildScript,
      });
    }
    if (pkg.hasTsupConfig && !pkg.hasTsupInvocation) {
      violations.push({
        kind: 'orphan-tsup-config',
        location: path.relative(repoRoot, pkg.tsupConfigPath),
        packageName: pkg.name,
        value: 'tsup.config.ts',
      });
    }
    if (pkg.hasTsupInvocation && !pkg.hasTsupConfig) {
      violations.push({
        kind: 'missing-tsup-config',
        location: `${pkg.manifestPath} [scripts.build]`,
        packageName: pkg.name,
        value: pkg.buildScript,
      });
    }
    if (pkg.hasTsupInvocation && !pkg.hasTsupDependency) {
      violations.push({
        kind: 'missing-tsup-dependency',
        location: pkg.manifestPath,
        packageName: pkg.name,
        value: 'tsup dependency',
      });
    }
    if (!pkg.hasTsupInvocation && pkg.hasTsupDependency) {
      violations.push({
        kind: 'orphan-tsup-dependency',
        location: pkg.manifestPath,
        packageName: pkg.name,
        value: 'tsup dependency',
      });
    }
    if (!pkg.hasTsupInvocation && TSUP_INVOCATION_RE.test(pkg.devScript)) {
      violations.push({
        kind: 'orphan-tsup-dev-script',
        location: `${pkg.manifestPath} [scripts.dev]`,
        packageName: pkg.name,
        value: pkg.devScript,
      });
    }

    if (!pkg.hasNodeLibraryConfig) {
      continue;
    }
    if (pkg.manifest.type !== 'module' || !pkg.hasTscBuild || pkg.hasTsupInvocation) {
      violations.push({
        kind: 'invalid-node-library-class',
        location: pkg.manifestPath,
        packageName: pkg.name,
        value: `type=${pkg.manifest.type ?? '(absent)'}, build=${pkg.buildScript}`,
      });
    }
    for (const target of distCodeTargets([
      pkg.manifest.exports,
      pkg.manifest.main,
      pkg.manifest.module,
    ])) {
      violations.push({
        kind: 'bundled-export-in-node-library',
        location: pkg.manifestPath,
        packageName: pkg.name,
        value: target,
      });
    }
    if (/dist\/chunk-/u.test(JSON.stringify(pkg.manifest.sideEffects ?? null))) {
      violations.push({
        kind: 'bundled-residue-in-node-library',
        location: pkg.manifestPath,
        packageName: pkg.name,
        value: JSON.stringify(pkg.manifest.sideEffects),
      });
    }
    violations.push(...findNodeLibrarySpecifierViolations(pkg, repoRoot));
  }
  return violations;
}

export function formatPackageBuildStrategyViolations(violations) {
  return violations
    .map((violation) => {
      switch (violation.kind) {
        case 'bundled-package-count':
          return `${violation.location} — found ${violation.value} package(s) invoking tsup. Bundling is an explicit architectural budget; migrate ordinary libraries to tsc -b or justify changing the budget.`;
        case 'unsupported-build':
          return `${violation.location} — ${violation.packageName} is a typed non-native package but its build is neither tsc -b nor tsup: ${violation.value}`;
        case 'orphan-tsup-config':
        case 'orphan-tsup-dependency':
        case 'orphan-tsup-dev-script':
          return `${violation.location} — ${violation.packageName} no longer bundles, but still carries ${violation.value}. Remove the script-shaped tsup residue instead of leaving misleading configuration.`;
        case 'missing-tsup-config':
          return `${violation.location} — ${violation.packageName} invokes tsup without a package-local tsup.config.ts. Put real bundling semantics in an explicit config; inline one-off flag sets are not a third strategy.`;
        case 'missing-tsup-dependency':
          return `${violation.location} — ${violation.packageName} invokes tsup without declaring it. Add the catalog-pinned package dependency; a root-hoisted binary is not part of this package's build contract.`;
        case 'invalid-node-library-class':
          return `${violation.location} — ${violation.packageName} extends the node-library config but is not a type=module tsc-only library (${violation.value}).`;
        case 'bundled-export-in-node-library':
          return `${violation.location} — ${violation.packageName} is tsc-only but still exports bundled artifact ${violation.value}. Point import/require at the emitted .js module.`;
        case 'bundled-residue-in-node-library':
          return `${violation.location} — ${violation.packageName} is tsc-only but still declares bundler chunk side effects ${violation.value}. TypeScript emits per-source modules; remove the stale chunk pattern.`;
        default:
          return `${violation.location} — ${violation.packageName} imports ${violation.value} without a runtime extension. TypeScript Bundler resolution accepts that spelling but Node ESM does not; use the source-level .js specifier.`;
      }
    })
    .join('\n');
}

export function main(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const violations = findPackageBuildStrategyViolations({ repoRoot });
  if (violations.length > 0) {
    console.error('package build strategy violations:');
    console.error(formatPackageBuildStrategyViolations(violations));
    process.exitCode = 1;
    return;
  }
  const packages = discoverPackageBuildStrategies(repoRoot);
  const bundled = packages.filter((pkg) => pkg.hasTsupInvocation).length;
  const tscOnly = packages.filter(
    (pkg) => !pkg.isNative && pkg.hasTscBuild && !pkg.hasTsupInvocation
  ).length;
  const nodeLibraries = packages.filter((pkg) => pkg.hasNodeLibraryConfig).length;
  const native = packages.filter((pkg) => pkg.isNative).length;
  console.log(
    `Package build strategies hold: ${tscOnly} typed libraries use tsc-only builds, ${bundled} packages ` +
      `perform explicit bundling, ${native} packages build native addons, and ${nodeLibraries} node-library ` +
      'packages have Node-compatible ESM specifiers.'
  );
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main();
}
