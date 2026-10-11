#!/usr/bin/env node
// Guard the R10/BST-1014 build ruling:
//
//   * non-native typed TypeScript libraries build with `tsc -b`/`tsc --build`;
//   * every src-to-dist library prunes stale emit without erasing `.tsbuildinfo`;
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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { packageManifestPaths } from './verify-catalog-references.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSC_BUILD_RE = /\btsc\s+(?:-b\b|--build\b)/;
const TSUP_INVOCATION_RE = /(?:^|[\s(/])tsup(?:\s|$)/;
const NATIVE_BUILD_RE = /\bnode-gyp\s+rebuild\b/;
const STALE_OUTPUT_PRUNER = 'node ../../scripts/prune-stale-dist.mjs';
const CANONICAL_TSUP_CONFIG = 'tsup.config.ts';
const TSUP_CONFIG_BASENAMES = Object.freeze([
  CANONICAL_TSUP_CONFIG,
  'tsup.config.mts',
  'tsup.config.cts',
  'tsup.config.js',
  'tsup.config.mjs',
  'tsup.config.cjs',
  'tsup.config.json',
]);

// Anti-vacuity floors. Lowering one is a deliberate architecture change, not a
// way to make a broken discovery pass.
export const MIN_TYPED_BUILD_PACKAGES = 41;
export const MIN_TSC_LIBRARY_PACKAGES = 31;
export const MIN_PRUNED_TSC_LIBRARY_PACKAGES = 30;
export const MIN_NODE_ESM_LIBRARY_PACKAGES = 14;
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

const diagnosticHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => REPO_ROOT,
  getNewLine: () => '\n',
};

function readTypeScriptConfig(tsconfigPath) {
  const host = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.formatDiagnostic(diagnostic, diagnosticHost));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, host);
  if (!parsed) {
    throw new Error(`verify-package-build-strategies.mjs could not parse ${tsconfigPath}.`);
  }
  if (parsed.errors.length > 0) {
    throw new Error(ts.formatDiagnostics(parsed.errors, diagnosticHost));
  }
  return parsed;
}

function isNodeNextConfig(parsedConfig) {
  return (
    parsedConfig.options.module === ts.ModuleKind.NodeNext &&
    parsedConfig.options.moduleResolution === ts.ModuleResolutionKind.NodeNext
  );
}

function configuredCodeOutputs(parsedConfig) {
  const outputs = new Set();
  for (const fileName of parsedConfig.fileNames) {
    for (const output of ts.getOutputFileNames(
      parsedConfig,
      fileName,
      !ts.sys.useCaseSensitiveFileNames
    )) {
      if (/\.(?:js|mjs|cjs)$/u.test(output)) {
        outputs.add(path.resolve(output));
      }
    }
  }
  return outputs;
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
    const tsupConfigPaths = TSUP_CONFIG_BASENAMES.map((basename) =>
      path.join(packageDir, basename)
    ).filter(existsSync);
    const parsedConfig = existsSync(tsconfigPath) ? readTypeScriptConfig(tsconfigPath) : null;
    const tsupScriptEntries = Object.entries(manifest.scripts ?? {}).filter(
      ([, script]) => typeof script === 'string' && TSUP_INVOCATION_RE.test(script)
    );

    packages.push({
      buildScript,
      codeOutputs: parsedConfig === null ? new Set() : configuredCodeOutputs(parsedConfig),
      devScript,
      hasNodeLibraryConfig: parsedConfig !== null && isNodeNextConfig(parsedConfig),
      hasTscBuild: TSC_BUILD_RE.test(buildScript),
      hasTsupConfig: tsupConfigPaths.length > 0,
      hasTsupDependency:
        manifest.dependencies?.tsup !== undefined || manifest.devDependencies?.tsup !== undefined,
      hasTsupInvocation: TSUP_INVOCATION_RE.test(buildScript),
      hasTsupManifestConfig: manifest.tsup !== undefined,
      isNative: manifest.gypfile === true || NATIVE_BUILD_RE.test(buildScript),
      manifest,
      manifestPath: relativeManifestPath,
      name: manifest.name ?? path.relative(repoRoot, packageDir),
      packageDir,
      sourceFileCount: parsedConfig?.fileNames.length ?? 0,
      supportsStaleOutputPruner:
        parsedConfig !== null &&
        path.resolve(parsedConfig.options.rootDir ?? '') === path.join(packageDir, 'src') &&
        path.resolve(parsedConfig.options.outDir ?? '') === path.join(packageDir, 'dist'),
      tsconfigPath,
      tsupConfigPaths,
      tsupScriptEntries,
      usesStaleOutputPruner: buildScript.includes(STALE_OUTPUT_PRUNER),
    });
  }
  return packages;
}

function distCodeTargets(value, found = []) {
  if (typeof value === 'string') {
    if (/^(?:\.\/)?dist\/.*\.(?:js|mjs|cjs)$/u.test(value)) {
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

function noncanonicalRuntimeConditions(value, found = []) {
  if (Array.isArray(value)) {
    for (const child of value) {
      noncanonicalRuntimeConditions(child, found);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'import' || key === 'require') {
        found.push(key);
      }
      noncanonicalRuntimeConditions(child, found);
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
  const prunedTscLibraries = tscLibraries.filter(
    (pkg) => pkg.supportsStaleOutputPruner && pkg.usesStaleOutputPruner
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
  if (enforceFloors && prunedTscLibraries.length < MIN_PRUNED_TSC_LIBRARY_PACKAGES) {
    throw new Error(
      `Refusing to run: discovered ${prunedTscLibraries.length} incremental-safe pruned tsc library ` +
        `build(s), below the floor of ${MIN_PRUNED_TSC_LIBRARY_PACKAGES}. Clean builds must not erase ` +
        'TypeScript project-reference state silently.'
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
    if (
      !pkg.isNative &&
      pkg.hasTscBuild &&
      !pkg.hasTsupInvocation &&
      pkg.supportsStaleOutputPruner &&
      !pkg.usesStaleOutputPruner
    ) {
      violations.push({
        kind: 'noncanonical-tsc-clean',
        location: `${pkg.manifestPath} [scripts.build]`,
        packageName: pkg.name,
        value: pkg.buildScript,
      });
    }
    for (const configPath of pkg.tsupConfigPaths) {
      const basename = path.basename(configPath);
      if (!pkg.hasTsupInvocation) {
        violations.push({
          kind: 'orphan-tsup-config',
          location: path.relative(repoRoot, configPath),
          packageName: pkg.name,
          value: basename,
        });
      } else if (basename !== CANONICAL_TSUP_CONFIG) {
        violations.push({
          kind: 'noncanonical-tsup-config',
          location: path.relative(repoRoot, configPath),
          packageName: pkg.name,
          value: basename,
        });
      }
    }
    if (pkg.hasTsupManifestConfig) {
      violations.push({
        kind: 'noncanonical-tsup-config',
        location: pkg.manifestPath,
        packageName: pkg.name,
        value: 'package.json `tsup` block',
      });
    }
    if (pkg.hasTsupInvocation && !pkg.hasTsupConfig && !pkg.hasTsupManifestConfig) {
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
    for (const [scriptName, script] of pkg.tsupScriptEntries) {
      if (scriptName === 'build' || scriptName === 'dev') {
        continue;
      }
      violations.push({
        kind: 'noncanonical-tsup-script',
        location: `${pkg.manifestPath} [scripts.${scriptName}]`,
        packageName: pkg.name,
        value: script,
      });
    }

    if (!pkg.hasNodeLibraryConfig) {
      continue;
    }
    if (pkg.sourceFileCount === 0) {
      throw new Error(
        `Refusing to run: ${pkg.name} is a NodeNext library but its resolved TypeScript program ` +
          'contains zero source files. An empty program cannot certify emitted exports.'
      );
    }
    if (pkg.manifest.type !== 'module' || !pkg.hasTscBuild || pkg.hasTsupInvocation) {
      violations.push({
        kind: 'invalid-node-library-class',
        location: pkg.manifestPath,
        packageName: pkg.name,
        value: `type=${pkg.manifest.type ?? '(absent)'}, build=${pkg.buildScript}`,
      });
    }
    for (const target of new Set(
      distCodeTargets([pkg.manifest.exports, pkg.manifest.main, pkg.manifest.module])
    )) {
      const resolvedTarget = path.resolve(pkg.packageDir, target);
      const emitted = resolvedTarget.includes('*')
        ? [...pkg.codeOutputs].some((output) => path.matchesGlob(output, resolvedTarget))
        : pkg.codeOutputs.has(resolvedTarget);
      if (!emitted) {
        violations.push({
          kind: 'non-tsc-export-target',
          location: pkg.manifestPath,
          packageName: pkg.name,
          value: target,
        });
      }
    }
    if (/dist\/chunk-/u.test(JSON.stringify(pkg.manifest.sideEffects ?? null))) {
      violations.push({
        kind: 'bundled-residue-in-node-library',
        location: pkg.manifestPath,
        packageName: pkg.name,
        value: JSON.stringify(pkg.manifest.sideEffects),
      });
    }
    for (const condition of new Set(noncanonicalRuntimeConditions(pkg.manifest.exports))) {
      violations.push({
        kind: 'noncanonical-node-library-condition',
        location: pkg.manifestPath,
        packageName: pkg.name,
        value: condition,
      });
    }
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
        case 'noncanonical-tsc-clean':
          return `${violation.location} — ${violation.packageName} has the canonical src-to-dist TypeScript layout but its build discards incremental state: ${violation.value}. Run ${STALE_OUTPUT_PRUNER} before tsc instead.`;
        case 'orphan-tsup-config':
        case 'orphan-tsup-dependency':
        case 'orphan-tsup-dev-script':
          return `${violation.location} — ${violation.packageName} no longer bundles, but still carries ${violation.value}. Remove the script-shaped tsup residue instead of leaving misleading configuration.`;
        case 'noncanonical-tsup-script':
          return `${violation.location} — ${violation.packageName} invokes tsup outside scripts.build/scripts.dev: ${violation.value}. Keep the bundle writer in the declared build strategy; lifecycle hooks must not hide a second emitter.`;
        case 'missing-tsup-config':
          return `${violation.location} — ${violation.packageName} invokes tsup without a package-local tsup.config.ts. Put real bundling semantics in an explicit config; inline one-off flag sets are not a third strategy.`;
        case 'noncanonical-tsup-config':
          return `${violation.location} — ${violation.packageName} declares ${violation.value}. BST-1014 accepts one explicit tsup configuration shape: tsup.config.ts.`;
        case 'missing-tsup-dependency':
          return `${violation.location} — ${violation.packageName} invokes tsup without declaring it. Add the catalog-pinned package dependency; a root-hoisted binary is not part of this package's build contract.`;
        case 'invalid-node-library-class':
          return `${violation.location} — ${violation.packageName} extends the node-library config but is not a type=module tsc-only library (${violation.value}).`;
        case 'non-tsc-export-target':
          return `${violation.location} — ${violation.packageName} is tsc-only but exports ${violation.value}, which is not emitted by its TypeScript program. Point the export at a configured source output or restore a real bundle boundary.`;
        case 'bundled-residue-in-node-library':
          return `${violation.location} — ${violation.packageName} is tsc-only but still declares bundler chunk side effects ${violation.value}. TypeScript emits per-source modules; remove the stale chunk pattern.`;
        case 'noncanonical-node-library-condition':
          return `${violation.location} — ${violation.packageName} is an ESM-only NodeNext library but declares a ${violation.value} export condition. Use types + default for one truthful runtime artifact; a require condition must point to a real CJS build.`;
        default:
          return `${violation.location} — ${violation.packageName} has unsupported build-strategy drift: ${violation.value}`;
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
  const prunedTscOnly = packages.filter(
    (pkg) =>
      !pkg.isNative &&
      pkg.hasTscBuild &&
      !pkg.hasTsupInvocation &&
      pkg.supportsStaleOutputPruner &&
      pkg.usesStaleOutputPruner
  ).length;
  console.log(
    `Package build strategies hold: ${tscOnly} typed libraries use tsc-only builds (${prunedTscOnly} ` +
      `src-to-dist libraries preserve incremental state), ${bundled} packages perform explicit bundling, ` +
      `${native} packages build native addons, and ${nodeLibraries} node-library packages use ` +
      'TypeScript-enforced NodeNext ESM.'
  );
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main();
}
