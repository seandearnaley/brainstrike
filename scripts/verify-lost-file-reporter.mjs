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
 * Packages exempt from the requirement, each with a reason.
 *
 * Deliberately empty: there is no principled reason for a Node-pool test lane
 * to opt out of "a file with no verdict is not a pass". Kept as an explicit,
 * documented seam so that any future exemption has to be written down here
 * rather than quietly omitted from a config.
 */
const EXEMPT_PACKAGES = new Map();

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

/** Configs that do not reference the reporter, minus documented exemptions. */
export function findConfigsMissingReporter(repoRoot, configs) {
  return configs.filter((configPath) => {
    const packageName = configPath.split('/').slice(0, 2).join('/');
    if (EXEMPT_PACKAGES.has(packageName)) {
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

  const missing = findConfigsMissingReporter(repoRoot, configs);
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

  process.stdout.write(
    `verify-lost-file-reporter: OK (${configs.length} vitest configs register LostTestFileReporter)\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
