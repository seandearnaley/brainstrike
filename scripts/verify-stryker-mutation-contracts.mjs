#!/usr/bin/env node
// Mutation-lane contract guard (BST-1331).
//
// The Stryker lane is advisory/on-demand, so a rotted config or a drifted
// runner invocation stays invisible until someone runs `pnpm mutation` —
// the "instrument that cannot fail is not evidence" class from PR #2475's
// review. This guard discovers every current package mutation script and its
// Stryker config at run time (no hand-written package list), then asserts:
//
//   1. The `mutation` script invokes the INSTALLED workspace binary
//      (`stryker run`), never `npx @stryker-mutator/core run`, whose
//      registry resolution silently ignores the catalog pin (BST-1287).
//   2. The Stryker config LOADS under the repository's ESM/CJS semantics
//      (packages are `"type": "module"`, so `.js` configs must be ESM;
//      `file-system` deliberately ships `.cjs`).
//   3. Its reporters stay inside the Vitest-4-supported set (Vitest 4
//      dropped Stryker's `basic` reporter — the exact rot #2475 fixed).
//   4. It keeps pointing at the package's own `vitest.mutation.config.ts`,
//      and that file still exists.
//
// Run via `pnpm test:scripts` (Static job) through
// scripts/__tests__/verify-stryker-mutation-contracts.test.mjs.

import { readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STRYKER_CONFIG_CANDIDATES = ['stryker.config.js', 'stryker.config.cjs', 'stryker.config.mjs'];

/**
 * Reporters the Vitest-4 mutation lane supports (BST-1287 / #2475):
 * Vitest 4 removed Stryker's legacy `basic` reporter, so a config still
 * naming it would break at mutation runtime, not at config-review time.
 */
export const SUPPORTED_REPORTERS = new Set(['clear-text', 'html', 'json', 'progress']);

/** Expected filename of the package's mutation Vitest config. */
export const MUTATION_VITEST_CONFIG = 'vitest.mutation.config.ts';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Discover every workspace package under `packagesRoot` that declares a
 * `mutation` script. Returns one contract descriptor per package; the
 * Stryker config path is resolved by convention (`stryker.config.{js,cjs,mjs}`)
 * and recorded as `undefined` when absent so the evaluator can fail loudly.
 */
export async function discoverMutationContracts({ packagesRoot = path.resolve('packages') } = {}) {
  const contracts = [];
  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDir = path.join(packagesRoot, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const script = manifest?.scripts?.['mutation'];
    if (typeof script !== 'string') {
      continue;
    }
    let configPath;
    for (const candidate of STRYKER_CONFIG_CANDIDATES) {
      const full = path.join(packageDir, candidate);
      try {
        if ((await stat(full)).isFile()) {
          configPath = full;
          break;
        }
      } catch {
        // keep probing candidates
      }
    }
    contracts.push({
      configPath,
      packageDir,
      packageName: manifest.name ?? entry.name,
      script,
    });
  }
  return contracts.sort((left, right) => left.packageName.localeCompare(right.packageName));
}

async function loadStrykerConfig(configPath) {
  if (configPath.endsWith('.cjs')) {
    const require = createRequire(import.meta.url);
    return { config: require(configPath) };
  }
  const imported = await import(pathToFileURL(configPath).href);
  return { config: imported.default };
}

/**
 * Evaluate one discovered contract. Returns a list of human-readable
 * violations; an empty list means the package's mutation lane is sound.
 */
export async function evaluateMutationContract(contract) {
  const violations = [];
  const where = `${contract.packageName} (${path.relative(process.cwd(), contract.packageDir)})`;

  // 1. Local-binary invocation: `npx` resolves from the registry and ignores
  //    the catalog pin; the installed workspace bin keeps the pin load-bearing.
  if (/\.run$|@stryker-mutator\/core/.test(contract.script.trim())) {
    violations.push(
      `${where}: mutation script "${contract.script}" resolves @stryker-mutator/core ` +
        'from the registry instead of the installed workspace binary. Use `stryker run`.'
    );
  }

  // 2. Config presence + loadability.
  if (!contract.configPath) {
    violations.push(`${where}: no stryker.config.{js,cjs,mjs} found next to the mutation script.`);
    return violations;
  }
  let config;
  try {
    ({ config } = await loadStrykerConfig(contract.configPath));
  } catch (error) {
    violations.push(
      `${where}: ${path.basename(contract.configPath)} failed to load under its ` +
        `ESM/CJS semantics: ${error instanceof Error ? error.message : String(error)}`
    );
    return violations;
  }
  if (!isObject(config)) {
    violations.push(
      `${where}: ${path.basename(contract.configPath)} must default-export an options object.`
    );
    return violations;
  }

  // 3. Reporter compatibility with the Vitest 4 lane.
  const reporters = Array.isArray(config.reporters) ? config.reporters : [];
  for (const reporter of reporters) {
    const name = typeof reporter === 'string' ? reporter : reporter?.name;
    if (!SUPPORTED_REPORTERS.has(name)) {
      violations.push(
        `${where}: reporter ${JSON.stringify(name ?? reporter)} is not in the supported ` +
          `set (${[...SUPPORTED_REPORTERS].sort().join(', ')}) for the Vitest 4 mutation lane.`
      );
    }
  }

  // 4. Per-package mutation Vitest wiring must survive refactors.
  const vitestConfig = config.vitest?.configFile;
  if (
    typeof vitestConfig !== 'string' ||
    path.posix.basename(vitestConfig) !== MUTATION_VITEST_CONFIG
  ) {
    violations.push(
      `${where}: stryker config must point vitest.configFile at ${MUTATION_VITEST_CONFIG}.`
    );
  } else {
    try {
      await stat(path.join(contract.packageDir, vitestConfig));
    } catch {
      violations.push(
        `${where}: referenced mutation vitest config "${vitestConfig}" does not exist.`
      );
    }
  }

  return violations;
}

/**
 * Discover and evaluate every mutation contract under `packagesRoot`.
 * Exits non-zero with one line per violation when anything rotted.
 */
export async function verifyMutationContracts({ packagesRoot } = {}) {
  const contracts = await discoverMutationContracts({ packagesRoot });
  if (contracts.length === 0) {
    throw new Error(`No package mutation scripts found under ${packagesRoot}.`);
  }
  const violations = [];
  for (const contract of contracts) {
    violations.push(...(await evaluateMutationContract(contract)));
  }
  return { contracts, violations };
}

/**
 * BST-836 entrypoint contract: every verify-* script exports main() so the
 * entrypoint control-test can point it at a root it cannot verify and demand
 * a refusal. `directory` (a packages root) wins over `repoRoot` (a repo root
 * whose `packages/` child is used); with neither, the real repo is checked.
 */
export async function main({ directory, repoRoot } = {}) {
  const packagesRoot =
    directory ?? (repoRoot ? path.join(repoRoot, 'packages') : path.resolve('packages'));
  const { contracts, violations } = await verifyMutationContracts({ packagesRoot });
  console.log(`Checked ${contracts.length} package mutation contract(s).`);
  if (violations.length > 0) {
    console.error('Mutation-lane contract violations:');
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    process.exitCode = 1;
  }
}

/* CLI entry: `node scripts/verify-stryker-mutation-contracts.mjs`. */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
