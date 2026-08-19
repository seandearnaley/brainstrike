// BST-1221: every package/app vitest config must register LostTestFileReporter.
//
// The reporter fails a run in which a collected test file ended with NO verdict
// — the shape a worker killed by a V8 fatal or an OOM kill leaves behind.
// Without it, vitest calls such a run `reason: 'passed'` and prints
// `Test Files N passed (N+1)`; the process only exits non-zero through the
// separate unhandled-errors channel, which `dangerouslyIgnoreUnhandledErrors`
// switches off (measured: that single flag turns a lost test file into a fully
// green, exit-0 lane).
//
// The guarantee is therefore per-config, and a config that omits the reporter
// loses it SILENTLY — nothing else in the repo would notice. That is precisely
// the class this guard exists to prevent, so a new package's config is a
// violation until it opts in.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories whose immediate children are workspace packages. */
const WORKSPACE_DIRS = ['packages', 'apps'];

/** The base config each package runs its `test` script against. */
const BASE_CONFIG_NAME = 'vitest.config.mts';

/** Substring proving the config wired the reporter in. */
const REPORTER_SPECIFIER = 'vitest-lost-file-reporter';

/**
 * Anti-vacuous-green floor, in the style of MIN_VERIFY_SCRIPTS in
 * scripts/__tests__/verify-script-entrypoints.test.mjs. If discovery silently
 * returns nothing — a moved directory, a renamed config — every check below
 * passes while inspecting zero files. This ALSO makes the guard refuse an empty
 * root, which is the property the shared entrypoint money test control-tests.
 */
const MIN_VITEST_CONFIGS = 30;

/**
 * The ONE exemption, and it is an architectural rule rather than a preference.
 *
 * The reporter ships in `@brainstrike/test-utils`, which
 * `architecture/domain-map.json` places in the `shared-foundation` domain.
 * The `tooling` domain declares `mayDependOn: []`, so a tooling package
 * importing the reporter is a domain-boundary violation — caught for real by
 * `scripts/architecture-domain-boundaries.mjs`, which failed on exactly this
 * during development for `build-utils`, `config`, and `platform-utils`.
 *
 * Read from the domain map rather than hard-coded, so the exemption tracks the
 * contract: move a package out of `tooling` and it must register the reporter
 * on its next run. Relative-path imports were deliberately NOT used to dodge
 * the boundary check — the coupling would be identical, just hidden from the
 * guard that exists to see it.
 *
 * The residual exposure is small and bounded: these are pure-TypeScript
 * tooling packages with no WASM, no native addons and no PGlite, i.e. none of
 * the machinery implicated in the crash this reporter detects.
 */
const EXEMPT_DOMAIN = 'tooling';

/** Package names in the exempt domain, per architecture/domain-map.json. */
export function loadExemptPackageNames(repoRoot) {
  const contractPath = join(repoRoot, 'architecture', 'domain-map.json');
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const domain = contract.domains?.find((entry) => entry.id === EXEMPT_DOMAIN);
  if (!domain) {
    throw new Error(
      `verify-lost-file-reporter: architecture/domain-map.json declares no '${EXEMPT_DOMAIN}' ` +
        'domain, so the exemption set cannot be resolved.'
    );
  }
  return new Set(domain.packages);
}

/** Read `<pkgDir>/package.json`'s name for a repo-relative config path. */
function packageNameForConfig(repoRoot, configPath) {
  const packageDir = join(repoRoot, configPath, '..');
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).name;
}

/** Every `<workspace>/<pkg>/vitest.config.mts` that exists, repo-relative. */
export function findVitestConfigs(repoRoot) {
  const configs = [];
  for (const workspaceDir of WORKSPACE_DIRS) {
    const absoluteWorkspace = join(repoRoot, workspaceDir);
    if (!existsSync(absoluteWorkspace)) {
      continue;
    }
    for (const entry of readdirSync(absoluteWorkspace).sort()) {
      const packageDir = join(absoluteWorkspace, entry);
      if (!statSync(packageDir).isDirectory()) {
        continue;
      }
      const configPath = join(packageDir, BASE_CONFIG_NAME);
      if (existsSync(configPath)) {
        configs.push(relative(repoRoot, configPath));
      }
    }
  }
  return configs;
}

/**
 * Configs that do not reference the reporter, minus the domain exemption.
 *
 * `exemptPackageNames` defaults to empty so unit tests can drive miniature
 * workspaces that carry no domain map; `main()` supplies the real set.
 */
export function findConfigsMissingReporter(repoRoot, configs, exemptPackageNames = new Set()) {
  return configs.filter((configPath) => {
    if (exemptPackageNames.has(packageNameForConfig(repoRoot, configPath))) {
      return false;
    }
    return !readFileSync(join(repoRoot, configPath), 'utf8').includes(REPORTER_SPECIFIER);
  });
}

export async function main({ repoRoot = REPO_ROOT } = {}) {
  const configs = findVitestConfigs(repoRoot);

  if (configs.length < MIN_VITEST_CONFIGS) {
    throw new Error(
      `verify-lost-file-reporter: found only ${configs.length} vitest config(s) under ` +
        `${WORKSPACE_DIRS.join('/ and ')}/, below the floor of ${MIN_VITEST_CONFIGS}. Either ` +
        'discovery broke (in which case this guard was checking nothing) or the workspace ' +
        'layout changed and this script needs updating.'
    );
  }

  const exemptPackageNames = loadExemptPackageNames(repoRoot);
  const missing = findConfigsMissingReporter(repoRoot, configs, exemptPackageNames);
  if (missing.length > 0) {
    process.exitCode = 1;
    process.stderr.write(
      `verify-lost-file-reporter: ${missing.length} vitest config(s) do not register ` +
        'LostTestFileReporter, so a worker killed mid-run in those lanes can drop an entire ' +
        'test file without failing the lane (BST-1221):\n' +
        `${missing.map((configPath) => `  - ${configPath}`).join('\n')}\n\n` +
        "Add to the config's `test` block:\n" +
        "  import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';\n" +
        "  reporters: ['default', new LostTestFileReporter()],\n"
    );
    return;
  }

  // Report the two populations separately. A single "N configs OK" line would
  // credit the exempt packages with a guarantee they do not have.
  const exemptCount = configs.filter((configPath) =>
    exemptPackageNames.has(packageNameForConfig(repoRoot, configPath))
  ).length;
  process.stdout.write(
    `verify-lost-file-reporter: OK (${configs.length - exemptCount} of ${configs.length} vitest ` +
      `configs register LostTestFileReporter; ${exemptCount} exempt as '${EXEMPT_DOMAIN}' packages)\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
