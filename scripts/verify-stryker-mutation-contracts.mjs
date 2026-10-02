#!/usr/bin/env node
// Mutation-lane contract guard (BST-1331).
//
// The Stryker lane is advisory/on-demand, so a rotted config or a drifted
// runner invocation stays invisible until someone runs `pnpm mutation` —
// the "instrument that cannot fail is not evidence" class from PR #2475's
// review. This guard discovers every workspace package declaring a `mutation`
// script plus its Stryker config at run time (no hand-written package list),
// then asserts:
//
//   1. The `mutation` script invokes exactly the installed workspace binary:
//      `stryker run ...` (arguments allowed). This is an ALLOWLIST — anything
//      else fails: `npx @stryker-mutator/core run` resolves from the registry
//      and ignores the catalog pin (BST-1287), `npx stryker run` keeps the
//      registry in the path, and neutered commands (`echo skipped`, `true`)
//      kill the lane invisibly. The package must also declare
//      @stryker-mutator/core in its dependencies — that declaration is what
//      puts the `stryker` bin inside the package's own node_modules/.bin
//      under pnpm's isolated layout.
//   2. Exactly one Stryker config resolves, using Stryker 10's own
//      precedence (@stryker-mutator/core SUPPORTED_CONFIG_FILE_NAMES order),
//      so the file validated here is precisely the file a real mutation run
//      loads. Two or more candidates present is itself a violation.
//   3. The config LOADS under the repository's ESM/CJS semantics, the same
//      way Stryker loads it (.json parsed, .cjs required, everything else
//      import()ed; packages are `"type": "module"`, so `.js` configs must be
//      ESM — `file-system` deliberately ships `.cjs`).
//   4. Its reporters stay inside the agreed set. Those values are STRYKER
//      reporter names (not Vitest reporters); the set is a deliberate house
//      roster, not a Vitest 4 capability claim. A NON-array `reporters` value
//      is itself a violation — never coerced into "nothing to validate"
//      (AGENTS.md: NO SILENT FALLBACKS).
//   5. It keeps pointing at the package's own `vitest.mutation.config.ts`,
//      and that file still exists.
//
// Discovery is workspace-driven: the globs in pnpm-workspace.yaml (apps/*,
// packages/*, packages/config/* today) are expanded and every resulting
// package directory is scanned, so widening the workspace widens the guard.
// An unparseable package.json under a scanned root is a loud error (it could
// be hiding a mutation script), and zero discovered contracts is itself a
// thrown failure — the guard cannot report green over an empty scan.
//
// Run via `pnpm test:scripts` (Static job) through
// scripts/__tests__/verify-stryker-mutation-contracts.test.mjs.

import { readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Stryker config candidates in EXACTLY @stryker-mutator/core 10's own
 * precedence order (src/config/config-file-formats.ts combines prefixes
 * ['', '.'] x suffixes ['.conf', '.config'] x extensions ['json', 'js',
 * 'mjs', 'cjs']). The FIRST existing file is the one a real mutation run
 * loads, so the guard evaluates that same file — and treats a second
 * candidate as a violation instead of hoping the stale one stays stale.
 */
export const STRYKER_CONFIG_PRECEDENCE = Object.freeze(
  ['', '.'].flatMap((prefix) =>
    ['.conf', '.config'].flatMap((suffix) =>
      ['json', 'js', 'mjs', 'cjs'].map((extension) => `${prefix}stryker${suffix}.${extension}`)
    )
  )
);

/**
 * Reporters this repo's mutation lane agrees to run (BST-1331).
 *
 * These are STRYKER reporter names, not Vitest reporters. The set is a
 * deliberate house roster — the four this repo uses — NOT a capability
 * boundary: Stryker 10 ships other built-ins (`dots`, `event-recorder`,
 * `dashboard`) that are perfectly legal upstream, and widening this set is a
 * reviewed decision, not an omission. Historical note: the Vitest 4 bump
 * removed `basic` from @stryker-mutator/vitest-runner's supported Vitest
 * reporters, which is how the #2475 lane rotted — hence `basic` staying out.
 */
export const SUPPORTED_REPORTERS = new Set(['clear-text', 'html', 'json', 'progress']);

/** Expected filename of the package's mutation Vitest config. */
export const MUTATION_VITEST_CONFIG = 'vitest.mutation.config.ts';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the workspace package globs from pnpm-workspace.yaml. A tiny
 * deliberate YAML subset: a top-level `packages:` key followed by `- item`
 * scalars (optionally quoted, optionally with a trailing comment). Anything
 * else fails loudly instead of being skipped — a guard that half-reads its
 * own scope is the vacuous-green class this file exists to prevent.
 */
async function readWorkspacePackageGlobs(repoRoot) {
  const filePath = path.join(repoRoot, 'pnpm-workspace.yaml');
  let yaml;
  try {
    yaml = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => /^packages:\s*(?:#.*)?$/.test(line));
  if (start === -1) {
    throw new Error(`pnpm-workspace.yaml at ${repoRoot} has no top-level \`packages:\` mapping.`);
  }
  const globs = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s+(.+?)\s*(?:#.*)?$/.exec(line);
    if (!item) {
      break;
    }
    let value = item[1];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    globs.push(value);
  }
  if (globs.length === 0) {
    throw new Error(`pnpm-workspace.yaml at ${repoRoot} declares an empty \`packages:\` mapping.`);
  }
  return globs;
}

/** Expand one workspace glob ('apps/*', 'packages/config/*', or a literal). */
async function expandWorkspaceGlob(repoRoot, glob) {
  const star = glob.indexOf('*');
  if (star === -1) {
    return [path.resolve(repoRoot, glob)];
  }
  const tail = glob.slice(star + 1);
  if (tail.includes('*')) {
    throw new Error(`Unsupported pnpm-workspace.yaml glob "${glob}": expected one trailing *.`);
  }
  const parent = path.resolve(repoRoot, glob.slice(0, star));
  const dirs = [];
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (tail === '' || entry.name.endsWith(tail)) {
      dirs.push(path.join(parent, entry.name));
    }
  }
  return dirs;
}

/**
 * Discover every workspace package (per pnpm-workspace.yaml globs expanded
 * from `repoRoot`) that declares a `mutation` script. Returns one contract
 * descriptor per package: `configPath` is resolved by Stryker's own
 * precedence (undefined when absent so the evaluator fails loudly),
 * `configCandidates` lists every candidate present (length > 1 is itself a
 * violation), and `strykerCorePin` carries the dependency declaration the
 * local-bin invocation relies on.
 */
export async function discoverMutationContracts({ repoRoot = process.cwd() } = {}) {
  const globs = await readWorkspacePackageGlobs(repoRoot);
  const packageDirs = [];
  for (const glob of globs) {
    packageDirs.push(...(await expandWorkspaceGlob(repoRoot, glob)));
  }
  const contracts = [];
  for (const packageDir of packageDirs.sort()) {
    let manifestText;
    try {
      manifestText = await readFile(path.join(packageDir, 'package.json'), 'utf8');
    } catch (error) {
      if (isObject(error) && error.code === 'ENOENT') {
        continue; // glob matched a directory that is not a package
      }
      throw error;
    }
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch (error) {
      throw new Error(
        `Failed to parse ${path.relative(repoRoot, path.join(packageDir, 'package.json'))}: ` +
          `${error instanceof Error ? error.message : String(error)} — a broken manifest could ` +
          'hide a mutation script from this guard, so it is not skipped silently.'
      );
    }
    const script = manifest?.scripts?.['mutation'];
    if (typeof script !== 'string') {
      continue;
    }
    const presentFiles = new Set(
      (await readdir(packageDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
    );
    const configCandidates = STRYKER_CONFIG_PRECEDENCE.filter((name) => presentFiles.has(name));
    contracts.push({
      configCandidates,
      configPath:
        configCandidates[0] === undefined ? undefined : path.join(packageDir, configCandidates[0]),
      packageDir,
      packageName: manifest.name ?? path.basename(packageDir),
      script,
      strykerCorePin:
        manifest.devDependencies?.['@stryker-mutator/core'] ??
        manifest.dependencies?.['@stryker-mutator/core'],
    });
  }
  return contracts.sort((left, right) => left.packageName.localeCompare(right.packageName));
}

/**
 * Load a Stryker config the same way @stryker-mutator/core 10 does: JSON
 * files are parsed, everything else goes through import() (createRequire is
 * only a .cjs shortcut — Node's ESM loader would interop it identically).
 */
async function loadStrykerConfig(configPath) {
  if (configPath.endsWith('.json')) {
    return { config: JSON.parse(await readFile(configPath, 'utf8')) };
  }
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
  const configName =
    contract.configPath === undefined ? undefined : path.basename(contract.configPath);

  // 1a. Local-binary invocation, allowlisted: the ONLY accepted shape is
  //     `stryker run ...`. Denying just the literal `npx @stryker-mutator/core`
  //     string would wave through neutered scripts (`echo skipped`) and other
  //     registry resolutions (`npx stryker run`) — a lane that silently stops
  //     running is exactly the rot class this guard exists to catch.
  if (!/^stryker\s+run\b/.test(contract.script.trim())) {
    violations.push(
      `${where}: mutation script "${contract.script}" must invoke the installed workspace binary ` +
        'via `stryker run` — `npx` variants resolve @stryker-mutator/core from the registry and ' +
        'ignore the catalog pin (BST-1287), and any other command silently neuters the lane.'
    );
  }

  // 1b. The dependency declaration is what puts the `stryker` bin inside the
  //     package's own node_modules/.bin under pnpm's isolated layout; a
  //     copied script without it dies with `stryker: command not found` at
  //     mutation runtime.
  if (typeof contract.strykerCorePin !== 'string') {
    violations.push(
      `${where}: declares a mutation script but no @stryker-mutator/core dependency — without it ` +
        "the `stryker` bin never lands in this package's node_modules/.bin and `pnpm mutation` " +
        'dies with `stryker: command not found`.'
    );
  }

  // 2. Unambiguous config, selected by Stryker's own precedence so the file
  //    validated here is the file a real mutation run loads.
  if (contract.configCandidates.length > 1) {
    violations.push(
      `${where}: ${contract.configCandidates.length} stryker config files present ` +
        `(${contract.configCandidates.join(', ')}) — Stryker loads "${configName}" by its fixed ` +
        'precedence while the others linger; keep exactly one config so the guarded file is ' +
        'unambiguous.'
    );
  }

  // 3. Config presence + loadability under repo ESM/CJS semantics.
  if (configName === undefined) {
    violations.push(
      `${where}: no stryker config found next to the mutation script (searched stryker.conf.*, ` +
        'stryker.config.*, and their dot-prefixed variants in Stryker precedence order).'
    );
    return violations;
  }
  let config;
  try {
    ({ config } = await loadStrykerConfig(contract.configPath));
  } catch (error) {
    violations.push(
      `${where}: ${configName} failed to load under its ` +
        `ESM/CJS semantics: ${error instanceof Error ? error.message : String(error)}`
    );
    return violations;
  }
  if (!isObject(config)) {
    violations.push(`${where}: ${configName} must default-export an options object.`);
    return violations;
  }

  // 4. Reporter compatibility. A NON-array `reporters` must be a loud
  //    violation, never coerced into "nothing to validate": `reporters:
  //    'basic'` is exactly the rot shape, and coercing it would read green
  //    BECAUSE the input is broken. Leaving `reporters` absent is allowed —
  //    Stryker's defaults (clear-text/progress/html) are all inside the set.
  if (config.reporters !== undefined && !Array.isArray(config.reporters)) {
    violations.push(
      `${where}: ${configName} reporters must be an array, got ${JSON.stringify(config.reporters)}.`
    );
  } else {
    const reporters = Array.isArray(config.reporters) ? config.reporters : [];
    for (const reporter of reporters) {
      const name = typeof reporter === 'string' ? reporter : reporter?.name;
      if (!SUPPORTED_REPORTERS.has(name)) {
        violations.push(
          `${where}: reporter ${JSON.stringify(name ?? reporter)} is outside the agreed ` +
            `mutation-reporter set (${[...SUPPORTED_REPORTERS].sort().join(', ')}); widen ` +
            'SUPPORTED_REPORTERS deliberately if a Stryker built-in is intended.'
        );
      }
    }
  }

  // 5. Per-package mutation Vitest wiring must survive refactors.
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
 * Discover and evaluate every mutation contract in the pnpm workspace rooted
 * at `repoRoot`. Throws (instead of reporting green) when discovery is empty,
 * and returns one line per violation otherwise.
 */
export async function verifyMutationContracts({ repoRoot = process.cwd() } = {}) {
  const contracts = await discoverMutationContracts({ repoRoot });
  if (contracts.length === 0) {
    throw new Error(`No package mutation scripts found across the pnpm workspace at ${repoRoot}.`);
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
 * a refusal. `repoRoot` wins; `directory` is honored as the same repo-root
 * anchor so the generic BST-836 harness drives this guard uniformly. With
 * neither, the current working directory is checked.
 */
export async function main({ directory, repoRoot } = {}) {
  const root = repoRoot ?? directory ?? process.cwd();
  const { contracts, violations } = await verifyMutationContracts({ repoRoot: root });
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
