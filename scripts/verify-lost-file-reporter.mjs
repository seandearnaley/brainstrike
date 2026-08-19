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
import { loadConfigFromFile } from 'vite';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories whose immediate children are workspace packages. */
const WORKSPACE_DIRS = ['packages', 'apps'];

/** The base config each package runs its `test` script against. */
const BASE_CONFIG_NAME = 'vitest.config.mts';

/**
 * Class name of a registered reporter instance.
 *
 * Matched on `constructor.name` of an entry in the LOADED config's effective
 * `reporters`, deliberately not on `instanceof`: `packages/test-utils` and
 * `packages/types` import the reporter by relative path while everyone else
 * uses the package specifier, and tying the check to module identity would make
 * the guard's verdict depend on how the import was spelled.
 */
const REPORTER_CLASS_NAME = 'LostTestFileReporter';

/** Module id naming the reporter on a vitest CLI `--reporter=` flag. */
const REPORTER_MODULE_ID = '@brainstrike/test-utils/vitest-lost-file-reporter';

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
 * Does this LOADED config actually register the reporter?
 *
 * Entries may be a bare name ('default'), a [name, options] tuple, or a reporter
 * INSTANCE — only the last can be ours. Duck-typing the instance (right class
 * name AND an `onTestRunEnd` hook) keeps a stray same-named object from
 * satisfying the guard.
 */
export function registersReporter(reporters) {
  if (!Array.isArray(reporters)) {
    return false;
  }
  return reporters.some(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      entry.constructor?.name === REPORTER_CLASS_NAME &&
      typeof entry.onTestRunEnd === 'function'
  );
}

/** The `test.reporters` vitest would actually use for this config file. */
export async function loadEffectiveReporters(configPath) {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, configPath);
  if (!loaded?.config) {
    throw new Error(`verify-lost-file-reporter: vite could not load ${configPath}`);
  }
  return loaded.config.test?.reporters;
}

/**
 * Configs that do not REGISTER the reporter, minus the domain exemption.
 *
 * This LOADS each config and inspects the effective `reporters` array rather
 * than grepping the source. An earlier version matched the module name as a
 * substring, which an unused import, a commented-out registration, or even a
 * passing mention in a comment satisfied while `test.reporters` omitted the
 * reporter entirely — a guard that could not fail, protecting nothing. See the
 * "cannot fail is not evidence" cases in the paired spec.
 *
 * `exemptPackageNames` defaults to empty so unit tests can drive miniature
 * workspaces that carry no domain map; `main()` supplies the real set.
 */
export async function findConfigsMissingReporter(
  repoRoot,
  configs,
  exemptPackageNames = new Set()
) {
  const eligible = configs.filter(
    (configPath) => !exemptPackageNames.has(packageNameForConfig(repoRoot, configPath))
  );
  // Loading a vite config costs a TS transform each; run them concurrently so
  // the guard stays seconds rather than a minute.
  const verdicts = await Promise.all(
    eligible.map(async (configPath) => ({
      configPath,
      registered: registersReporter(await loadEffectiveReporters(join(repoRoot, configPath))),
    }))
  );
  return verdicts.filter((verdict) => !verdict.registered).map((verdict) => verdict.configPath);
}

/**
 * Scripts that invoke vitest with a CLI `--reporter`, which OVERRIDES the
 * config's `reporters` array and therefore drops the lost-file guarantee for
 * that lane. vitest 4.1.10 has no additive `--additional-reporter` flag, so the
 * only fix is to name this reporter among them too — `--reporter` accepts a
 * module id, so `--reporter=@brainstrike/test-utils/vitest-lost-file-reporter`
 * works alongside `default`/`blob`/`verbose`.
 *
 * Without this check the gap reopens SILENTLY the next time someone adds a
 * `--reporter` script: config registration would still look complete while the
 * lane that actually runs had no protection at all.
 *
 * @returns {{ packageName: string, script: string }[]}
 */
export function findScriptsOverridingReporters(repoRoot, exemptPackageNames = new Set()) {
  const offenders = [];
  for (const workspaceDir of WORKSPACE_DIRS) {
    const absoluteWorkspace = join(repoRoot, workspaceDir);
    if (!existsSync(absoluteWorkspace)) {
      continue;
    }
    for (const entry of readdirSync(absoluteWorkspace).sort()) {
      const packageJsonPath = join(absoluteWorkspace, entry, 'package.json');
      if (!existsSync(packageJsonPath)) {
        continue;
      }
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      if (exemptPackageNames.has(pkg.name)) {
        continue;
      }
      for (const [scriptName, command] of Object.entries(pkg.scripts ?? {})) {
        if (
          typeof command === 'string' &&
          command.includes('vitest') &&
          command.includes('--reporter=') &&
          !command.includes(REPORTER_MODULE_ID)
        ) {
          offenders.push({ packageName: pkg.name, script: scriptName });
        }
      }
    }
  }
  return offenders;
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
  const missing = await findConfigsMissingReporter(repoRoot, configs, exemptPackageNames);
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

  const overriding = findScriptsOverridingReporters(repoRoot, exemptPackageNames);
  if (overriding.length > 0) {
    process.exitCode = 1;
    process.stderr.write(
      `verify-lost-file-reporter: ${overriding.length} package script(s) pass a CLI ` +
        "`--reporter`, which OVERRIDES the config's `reporters` and drops the lost-file " +
        'guarantee for that lane (BST-1221):\n' +
        `${overriding.map((o) => `  - ${o.packageName} -> ${o.script}`).join('\n')}\n\n` +
        `Append \`--reporter=${REPORTER_MODULE_ID}\` to those invocations.\n`
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
