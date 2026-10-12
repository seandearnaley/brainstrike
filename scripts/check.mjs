#!/usr/bin/env node
/**
 * `pnpm check` — the local mirror of the CI gate set (BST-1009).
 *
 * `.github/workflows/test.yml` is the SOURCE OF TRUTH; this file conforms to
 * it. The default plan reproduces the five REQUIRED status checks — Static,
 * Unit, Build, Web E2E, Desktop E2E — plus the always-on (non-required)
 * Browser tests lane, step for step.
 *
 * Why this was rewritten: the previous plan claimed to be "the repo check"
 * while running a SECOND, divergent definition of CI. It ran
 * `test:coverage:split`, whose `test:coverage:base` is
 * `pnpm -r --filter '!@brainstrike/db' ... run test:coverage` — so a green
 * `pnpm check` had never executed `packages/db`, the largest suite in the repo
 * and the one turbo task that can never be replayed from cache. It also
 * omitted three Static gates outright (`secrets:scan`, `turbo boundaries`,
 * and `test:scripts`), including the guard-script gate
 * that exists to catch exactly this class of false green (BST-836). And its
 * lint step WROTE to the working tree (`biome check . --fix`) where CI's
 * `lint:ci` is read-only.
 *
 * Two rules keep it honest:
 *
 * 1. Every command below mirrors a `run:` step of a gating job in test.yml.
 *    Where CI uses turbo, this uses turbo — so the two cannot drift on
 *    selection semantics the way a `pnpm -r` filter list can.
 * 2. A CI gate this plan does NOT run is declared in
 *    `CI_GATES_NOT_RUN_LOCALLY` with a reason, printed at the top of every
 *    run, and audited by `scripts/__tests__/check-ci-parity.test.mjs`. That
 *    test parses test.yml and fails if any gating `run:` step is neither
 *    mapped to a plan step nor listed as an exclusion — so a new CI gate
 *    cannot be silently missed. NO SILENT FALLBACKS.
 *
 * Modes:
 *   default   the required-check mirror (+ Browser tests), with install
 *   --fast    the same, minus the runner-heavy lanes (Browser tests, E2E)
 *   --full    the default plan PLUS the advisory/nightly gates that are not
 *             required checks: nightly-coverage.yml's threshold gate and the
 *             web/desktop full E2E regression lanes. Additive, never a swap.
 *
 * Flags:
 *   --no-install   Skip pnpm install
 *   --no-e2e       Skip the E2E lanes (smoke and, under --full, regression)
 *   --no-coverage  Skip the coverage gate (only reachable under --full)
 *   --fix-lint     Run the WRITING lint chain (`lint-all`) instead of the
 *                  read-only `lint:ci` CI uses. Opt-in on purpose: a gate must
 *                  not rewrite the tree it is judging.
 *   --headless     Run headless display setup before the checks (Linux)
 *   --verbose      Show step start banners
 *
 * `turbo boundaries` scans build output as well as source and offers no way to
 * exclude it, which used to make this plan non-idempotent: green on a clean
 * tree, then phantom violations against `dist/` the second time you ran it.
 * The gate is now `pnpm run boundaries` (scripts/turbo-boundaries.mjs), which
 * judges only findings in files git does not ignore, so a repeat run on a
 * built tree reaches the same verdict CI does
 * (docs/agents/ci-quality.md, BST-967 + the 2026-07-30 cache-poisoning note).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const BLUE = '\u001b[34m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

/**
 * CI `run:` steps this plan deliberately does not execute. Each entry names
 * the exact `<job> › <step>` it opts out of and why. The parity test refuses
 * to let anything else go unmapped, so this list is the complete, auditable
 * set of what a green `pnpm check` has NOT proven.
 */
export const CI_GATES_NOT_RUN_LOCALLY = [
  {
    reason:
      'PR-only turbo change-set check that decides whether CI runs the MCP representative verification step. A local run has no PR range and always runs that step (plan step `mcp-verification`).',
    step: 'static › Detect MCP lab changes',
  },
  {
    reason:
      'Windows-only: node-gyp + MSVC on windows-latest. It cannot run on a macOS or Linux workstation at all.',
    step: 'native-windows › Build and test secure filesystem capability',
  },
  {
    reason:
      'Windows-only: the Job Object addon exists solely for win32 and its test asserts Windows process-tree semantics.',
    step: 'native-windows › Build and test Agent DevTools process ownership',
  },
  {
    reason:
      'Windows-only runner for a suite the unit lane already runs locally (`pnpm --filter @brainstrike/sqlite-native test`, plan step `unit-tests`); this step exists to prove the win32-x64 prebuilds of better-sqlite3 and sqlite-vec load, which no macOS or Linux workstation can show.',
    step: 'native-windows › Test SQLite native prebuilds',
  },
  {
    reason:
      'Part of the Native Electron Package job, excluded as a unit — see the "Package the desktop application" entry.',
    step: 'native-electron › Build desktop dependency graph',
  },
  {
    reason:
      'Linux-x64 CI provisioning for the Native Electron Package job; the deterministic workflow contract covers its retry, verification, ordering, and archive-reuse semantics locally.',
    step: 'native-electron › Provision Electron binary',
  },
  {
    reason:
      'Part of the Native Electron Package job, excluded as a unit — see the "Package the desktop application" entry.',
    step: 'native-electron › Load the native capability in Electron',
  },
  {
    reason:
      "Non-required check that runs electron-builder for the RUNNER's platform. A local run would package a macOS/dev-OS artifact and prove nothing about the Linux x64 package CI gates, while costing a full electron-builder toolchain and ~25 minutes. Run `pnpm --filter @brainstrike/desktop run pack` by hand when touching packaging.",
    step: 'native-electron › Package the desktop application',
  },
  {
    reason:
      'Part of the Native Electron Package job, excluded as a unit — see the "Package the desktop application" entry.',
    step: 'native-electron › Load the packaged native capability in Electron',
  },
  {
    reason:
      'Part of the Native Electron Package job, excluded as a unit — see the "Package the desktop application" entry.',
    step: 'native-electron › Load the native SQLite prebuilds in Electron',
  },
  {
    reason:
      'Part of the Native Electron Package job, excluded as a unit — see the "Package the desktop application" entry. Run `pnpm --filter @brainstrike/sqlite-native test:packaged` after a hand-run `pnpm --filter @brainstrike/desktop run pack` to prove the current developer platform.',
    step: 'native-electron › Load the packaged native SQLite prebuilds',
  },
  {
    reason:
      'Part of the Native Electron Package job, excluded as a unit — see the "Package the desktop application" entry.',
    step: 'native-electron › Load the packaged @parcel/watcher binding in Electron (BST-568)',
  },
  {
    reason:
      'Part of the platform-specific Native Electron Package job, excluded as a unit — run `pnpm --filter @brainstrike/desktop run test:e2e:mcp-packaged` to build and verify the current developer-platform package explicitly.',
    step: 'native-electron › Verify packaged MCP core lifecycle',
  },
  {
    reason:
      'Part of the platform-specific Native Electron Package job, excluded as a unit — run `pnpm --filter @brainstrike/desktop run test:e2e:lane:packaged-mcp-apps-bridge` against a developer-platform package explicitly.',
    step: 'native-electron › Verify packaged MCP Apps bridge',
  },
  {
    reason:
      'Part of the platform-specific Native Electron Package job, excluded as a unit — package with VITE_MCP_TASK_HARNESS=1 and run `pnpm --filter @brainstrike/desktop run test:e2e:lane:packaged-mcp-tasks` against that developer-platform package explicitly.',
    step: 'native-electron › Verify packaged MCP Tasks lifecycle',
  },
  {
    reason:
      'Part of the platform-specific Native Electron Package job, excluded as a unit — run `pnpm --filter @brainstrike/desktop run test:e2e:lane:packaged-mcp-apps` against a developer-platform package explicitly.',
    step: 'native-electron › Verify packaged MCP Apps lifecycle',
  },
];

/** CI run steps covered by each local plan step. */
export const CI_GATE_PLAN_IDS = new Map([
  ['static › Lockfile catalog conformance (pre-install)', ['lockfile-catalog-conformance']],
  ['static › Secret scan', ['secrets-scan']],
  ['static › Package boundaries', ['boundaries']],
  ['static › Script tests', ['script-tests']],
  ['static › Lint', ['lint']],
  ['static › Type check', ['type-check']],
  ['static › MCP representative verification', ['mcp-verification']],
  ['unit-shard › Pull request affected unit tests', ['unit-tests']],
  ['unit-shard › Pull request affected integration tests', ['integration-tests']],
  ['unit-shard › Push and manual unit tests', ['unit-tests']],
  ['unit-shard › Push and manual integration tests', ['integration-tests']],
  ['build › Build', ['build']],
  ['build › Validate CSS bundle', ['validate-css-bundle']],
  ['browser-tests › Run browser tests', ['browser-tests']],
  ['web-e2e › Run web smoke', ['web-e2e-smoke']],
  ['desktop-e2e-smoke › Run desktop smoke', ['desktop-e2e-smoke']],
  ['desktop-e2e-delegated › Run desktop delegated smoke', ['desktop-e2e-delegated-smoke']],
]);

/**
 * Returns every CI gate this exact plan does not cover. Static exclusions are
 * intentional platform limitations; the remaining entries are selected by
 * flags and must be reported rather than silently omitted.
 */
export function uncoveredCiGates(plan) {
  const planIds = new Set(plan.map((step) => step.id));
  const skippedByFlags = [];

  for (const [step, requiredIds] of CI_GATE_PLAN_IDS) {
    if (!requiredIds.every((id) => planIds.has(id))) {
      skippedByFlags.push({
        reason:
          'Skipped by the flags passed to this run; run pnpm check without that mode to cover it.',
        step,
      });
    }
  }

  return [...CI_GATES_NOT_RUN_LOCALLY, ...skippedByFlags];
}

/**
 * A Playwright lane, run under CI environment semantics — and ONLY this
 * command.
 *
 * Both `playwright.config.mts` files branch on `config.isCI` (which reads
 * `CI`/`GITHUB_ACTIONS`) for `forbidOnly`, `fullyParallel`, `globalTimeout`,
 * `retries`, `workers`, `reporter`, the Chromium launch args, and `trace`; the
 * `e2e/utils` helpers key their own wait budgets off `CI` too. Without it the
 * lane loads in local mode, so a stray `test.only` in an `@web-smoke` test
 * makes this "pass" by running one test while the required Web E2E job rejects
 * the same source — precisely the false green this script exists to remove.
 *
 * Playwright's `--forbid-only` flag was considered and REJECTED: it repairs one
 * of roughly ten CI-conditioned divergences, so it would leave the same class
 * of gap alive under a name that claims otherwise. `CI=true` mirrors all of
 * them at once.
 *
 * SCOPE IS LOAD-BEARING — do not hoist this to the whole run (BST-1050). A
 * process-wide `CI` would change the workload of the unit/integration steps,
 * not just their environment: `packages/vector-management`'s base vitest
 * config turns on coverage with a 70% line threshold when `CI === 'true'`.
 * Those steps use the dedicated `TEST_TIMEOUT_MULTIPLIER` to match CI's
 * timeout policy without inheriting its other behavior, so `CI` belongs to
 * these Playwright invocations and nothing else.
 */
function playwrightLane(pkg, script) {
  // Keep synthetic CI semantics in Playwright without changing pnpm's local
  // dependency-store defaults. pnpm 11 otherwise refuses the installed workspace
  // because CI flips enableGlobalVirtualStore; dependency verification stays on.
  return `node scripts/run-env.mjs CI=true pnpm_config_ci=false -- pnpm -s --filter ${pkg} run ${script}`;
}

const KNOWN_FLAGS = new Set([
  '--fast',
  '--full',
  '--routine',
  '--stress',
  '--no-install',
  '--no-e2e',
  '--no-coverage',
  '--fix-lint',
  '--headless',
  '--verbose',
]);

export function parseFlags(argv) {
  for (const arg of argv) {
    if (!KNOWN_FLAGS.has(arg)) {
      throw new Error(
        `Unknown flag: ${arg}. Supported: ${[...KNOWN_FLAGS].join(' ')}. ` +
          'Refusing to run a plan you did not ask for.'
      );
    }
  }

  const args = new Set(argv);
  if (args.has('--routine') && (args.has('--full') || args.has('--fast'))) {
    throw new Error('--routine is a separate plan; do not combine it with --full or --fast.');
  }
  if (args.has('--fast') && args.has('--full')) {
    throw new Error('--fast and --full select different plans; pass one.');
  }
  if (args.has('--no-coverage') && !args.has('--full')) {
    throw new Error('--no-coverage only applies with --full.');
  }
  if (args.has('--stress') && (!args.has('--full') || args.has('--no-e2e'))) {
    throw new Error('--stress requires --full with E2E enabled.');
  }

  return {
    coverage: !args.has('--no-coverage'),
    e2e: !args.has('--no-e2e'),
    fast: args.has('--fast'),
    fixLint: args.has('--fix-lint'),
    full: args.has('--full'),
    headless: args.has('--headless'),
    install: !args.has('--no-install'),
    routine: args.has('--routine'),
    stress: args.has('--stress'),
    verbose: args.has('--verbose'),
  };
}

/**
 * @returns {{ id: string, label: string, command: string }[]}
 */
export function buildPlan(options = {}) {
  const {
    fast = false,
    full = false,
    install = true,
    e2e = true,
    coverage = true,
    fixLint = false,
    headless = false,
    stress = false,
    routine = false,
  } = options;

  // `--fast` drops the runner-heavy lanes CI fans out across separate
  // machines; everything a single Static/Unit/Build runner does still runs.
  const runBrowser = !fast;
  const runE2E = e2e && !fast;

  const plan = [];

  if (headless) {
    plan.push({
      command: 'pnpm -s run setup:headless',
      id: 'setup-headless',
      label: 'setup:headless',
    });
  }

  if (install) {
    plan.push({
      // `--frozen-lockfile`, exactly as `.github/actions/setup-workspace`
      // installs. A plain `pnpm install` SILENTLY UPDATES pnpm-lock.yaml when a
      // workspace manifest has drifted from it and then carries on green, while
      // CI rejects that same input — a false green in the install step of the
      // script whose whole purpose is to stop false greens.
      command: 'pnpm -s install --frozen-lockfile',
      id: 'install',
      label: 'install',
    });
  }

  // --- Static ------------------------------------------------------------
  plan.push({
    command: 'pnpm -s run secrets:scan',
    id: 'secrets-scan',
    label: 'secrets:scan',
  });
  // Ordering mirrors Static: boundaries BEFORE anything that can materialize
  // dist/ (type-check dependsOn build). Since scripts/turbo-boundaries.mjs
  // scopes the verdict to non-git-ignored files, that ordering now only buys a
  // cheaper scan — it is no longer what keeps the gate honest.
  plan.push({
    command: 'pnpm -s run boundaries',
    id: 'boundaries',
    // Not "turbo boundaries": a failing step's label is what a developer
    // reruns by hand, and the bare subcommand gives back the non-idempotent
    // verdict this step exists to avoid.
    label: 'boundaries',
  });
  // BST-1324: mirrors the Static job's pre-install seat. Locally node_modules
  // already exists, so ordering is immaterial here — the CI placement (before
  // `pnpm install --frozen-lockfile`) is what lets it fire on a merged-broken
  // lockfile; this step keeps `pnpm check` an honest mirror of that gate.
  plan.push({
    command: 'node scripts/verify-lockfile-catalog-conformance.mjs',
    id: 'lockfile-catalog-conformance',
    label: 'lockfile catalog conformance',
  });
  plan.push({
    command: 'pnpm -s run test:scripts',
    id: 'script-tests',
    label: 'test:scripts',
  });
  plan.push({
    command: fixLint ? 'pnpm -s run lint-all' : 'pnpm -s run lint:ci',
    id: 'lint',
    label: fixLint ? 'lint-all (writes)' : 'lint:ci',
  });
  plan.push({
    // CI additionally caps TURBO_CONCURRENCY=4 for the arm64 runner's memory
    // budget; that cap is deliberately a CI-invocation property and is not
    // imposed on local developer defaults (docs/agents/ci-quality.md).
    command: 'pnpm -s run type-check',
    id: 'type-check',
    label: 'type-check',
  });
  plan.push({
    command: 'pnpm run verify:mcp -- --profile pr --output artifacts/pr-evidence.json',
    id: 'mcp-verification',
    label: 'MCP representative verification',
  });

  // --- Build -------------------------------------------------------------
  plan.push({
    // Invoked through the turbo wrapper directly, NOT `pnpm run build -- …`:
    // pnpm preserves the `--`, turbo then treats the flags as pass-through
    // args and appends them to every package's own build script (measured on
    // BST-1005; it killed tsup and node-gyp). `--continue` only affects
    // turbo's scheduling — the wrapper still exits non-zero, and `runStep()`
    // below rejects on any non-zero exit, so the whole check still fails.
    command:
      'node scripts/run-env.mjs TAILWIND_DEBUG=1 -- node scripts/run-turbo-command.mjs -- run build --summarize --log-order=grouped --continue=dependencies-successful',
    id: 'build',
    label: 'build',
  });
  plan.push({
    command: 'node scripts/validate-css-bundle.mjs',
    id: 'validate-css-bundle',
    label: 'validate CSS bundle',
  });

  // --- Unit --------------------------------------------------------------
  // Unfiltered on purpose: CI's three shards are an affected-set PARTITION of
  // the same two turbo tasks, and their union is the whole workspace. Running
  // unfiltered locally is that union — packages/db very much included.
  // TURBO_TEST_MODE=unit keeps the cache key identical to CI's; the two-phase
  // split with the same concurrency caps mirrors the CI phase split.
  plan.push({
    command:
      'node scripts/run-env.mjs TURBO_TEST_MODE=unit COVERAGE=false TEST_TIMEOUT_MULTIPLIER=2 -- node scripts/run-test-command.mjs -- node scripts/run-turbo-command.mjs --windows-concurrency=1 -- run test --concurrency=4 --summarize --log-order=grouped',
    id: 'unit-tests',
    label: 'test',
  });
  const integrationCommand =
    'node scripts/run-env.mjs TURBO_TEST_MODE=unit COVERAGE=false TEST_TIMEOUT_MULTIPLIER=2 -- node scripts/run-test-command.mjs -- node scripts/run-turbo-command.mjs --windows-concurrency=1 -- run test:integration --concurrency=2 --summarize --log-order=grouped';
  if (routine) {
    // The 92-minute baseline spent 22 minutes in these two integration matrices.
    // Keep all other packages, plus explicit real-process core scenarios below.
    // --full still executes both complete matrices without these filters.
    plan.push({
      command: `${integrationCommand} --filter=!@brainstrike/desktop --filter=!@brainstrike/agent-host`,
      id: 'routine-integration-packages',
      label: 'integration tests outside desktop/agent-host',
    });
    for (const pkg of ['agent-host', 'desktop']) {
      plan.push({
        command: `node scripts/run-env.mjs TEST_TIMEOUT_MULTIPLIER=2 -- node scripts/run-test-command.mjs -- pnpm --filter @brainstrike/${pkg} run test:integration:routine`,
        id: `${pkg}-routine-integration`,
        label: `${pkg} core integration scenarios`,
      });
    }
  } else {
    plan.push({ command: integrationCommand, id: 'integration-tests', label: 'test:integration' });
  }

  // --- Browser tests -----------------------------------------------------
  // CI filters to db/storage/ui because its Playwright container has no C
  // toolchain; a workstation has one, so the unfiltered root script is a
  // superset of the CI selection.
  if (runBrowser) {
    plan.push({
      command: 'node scripts/run-env.mjs TEST_TIMEOUT_MULTIPLIER=2 -- pnpm -s run test:browser',
      id: 'browser-tests',
      label: 'test:browser',
    });
  }

  // --- Web E2E / Desktop E2E ---------------------------------------------
  if (runE2E) {
    plan.push({
      command: playwrightLane('@brainstrike/web', 'test:e2e:lane:smoke'),
      id: 'web-e2e-smoke',
      label: 'web e2e smoke',
    });
    plan.push({
      // CI wraps this in `dbus-run-session` purely to silence Chromium's
      // missing-bus noise on the Linux runner; the tests pass without it.
      command: playwrightLane('@brainstrike/desktop', 'test:e2e:lane:smoke'),
      id: 'desktop-e2e-smoke',
      label: 'desktop e2e smoke',
    });
    plan.push({
      // CI runs this lane on its own runner beside desktop-e2e-smoke (BST-1762);
      // locally the two lanes run one after the other.
      command: playwrightLane('@brainstrike/desktop', 'test:e2e:lane:smoke-delegated'),
      id: 'desktop-e2e-delegated-smoke',
      label: 'desktop e2e delegated smoke',
    });
  }

  // --- --full: the advisory / nightly gates ------------------------------
  if (full && coverage) {
    // nightly-coverage.yml's threshold gate. Its six package shards plus the
    // dedicated db shard exist for CI timeout/failure domains; one unfiltered
    // turbo run is the same task set, db included.
    plan.push({
      command:
        'node scripts/run-env.mjs TURBO_TEST_MODE=coverage COVERAGE=true TEST_TIMEOUT_MULTIPLIER=2 -- node scripts/run-turbo-command.mjs --windows-concurrency=1 -- run test:coverage --concurrency=4 --summarize --log-order=grouped',
      id: 'coverage',
      label: 'test:coverage',
    });
    plan.push({
      command: 'pnpm -s run coverage:prepare-workspace',
      id: 'coverage-prepare',
      label: 'coverage:prepare-workspace',
    });
    plan.push({
      command: 'pnpm -s run coverage:enforce',
      id: 'coverage-enforce',
      label: 'coverage:enforce',
    });
  }

  if (full && runE2E) {
    plan.push({
      command: playwrightLane('@brainstrike/web', 'test:e2e:lane:full-regression'),
      id: 'web-e2e-full-regression',
      label: 'web e2e full regression',
    });
    plan.push({
      command: playwrightLane('@brainstrike/desktop', 'test:e2e:lane:full-regression'),
      id: 'desktop-e2e-full-regression',
      label: 'desktop e2e full regression',
    });
  }

  if (stress) {
    // These local model/soak workloads must not inherit CI=true: some explicitly
    // refuse CI execution. Each command owns its opt-in and retains all assertions.
    for (const [id, command] of [
      ['lock-stress', 'pnpm --filter @brainstrike/state-store run test:stress'],
      ['desktop-stress', 'pnpm --filter @brainstrike/desktop run test:e2e:stress'],
      [
        'desktop-native-retirement',
        'pnpm --filter @brainstrike/desktop run test:e2e:qualification:native-retirement',
      ],
    ]) {
      plan.push({ command, id, label: id });
    }
  }

  return plan;
}

function banner(message, verbose) {
  if (verbose) {
    console.log(`${BLUE}${BOLD}› ${message}${RESET}`);
  }
}

/**
 * Runs one plan step. Exported so the parity test can prove the failure
 * semantics directly: ANY non-zero exit rejects, which is what stops a
 * `--continue=dependencies-successful` turbo run from being swallowed.
 */
export async function runStep(step, verbose, spawnCommand = spawn) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    banner(`Starting ${step.label}`, verbose);
    const child = spawnCommand(step.command, { cwd: REPO_ROOT, shell: true, stdio: 'inherit' });
    child.on('error', (error) => {
      const ms = Math.round(performance.now() - started);
      console.error(`${RED}✖ ${step.label} could not start${RESET} ${YELLOW}(${ms} ms)${RESET}`);
      reject(Object.assign(error, { code: 1, label: step.label, ms }));
    });
    child.on('exit', (code) => {
      const ms = Math.round(performance.now() - started);
      if (code === 0) {
        console.log(`${GREEN}✔ ${step.label}${RESET} ${YELLOW}(${ms} ms)${RESET}`);
        resolve({ label: step.label, ms });
        return;
      }
      console.error(`${RED}✖ ${step.label} failed${RESET} ${YELLOW}(${ms} ms)${RESET}`);
      reject(Object.assign(new Error(`${step.label} failed`), { code, label: step.label, ms }));
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseFlags(argv);
  const startedAll = performance.now();
  const steps = buildPlan(options);

  console.log(`${BOLD}Running ${steps.length} step(s):${RESET}`);
  for (const step of steps) {
    console.log(`  - ${step.label}`);
  }
  console.log('');
  if (options.routine) {
    console.log(
      'Routine plan: all units, all other package integrations, desktop/agent-host core integrations, browser tests and E2E smoke. Complete integration matrices, full E2E, coverage and stress are not included.'
    );
    console.log('Acceptance requirement: finish in under 30 minutes.');
  }
  console.log(`${BOLD}CI gates this run does NOT cover:${RESET}`);
  for (const gate of uncoveredCiGates(steps)) {
    console.log(`  - ${gate.step}`);
    console.log(`    ${YELLOW}${gate.reason}${RESET}`);
  }
  console.log('');

  const results = [];
  try {
    for (const step of steps) {
      results.push(await runStep(step, options.verbose));
    }
  } catch (err) {
    const totalMs = Math.round(performance.now() - startedAll);
    console.log('');
    console.log(`${RED}${BOLD}Check failed${RESET} after ${YELLOW}${totalMs} ms${RESET}`);
    if (results.length) {
      console.log(`${BOLD}Completed steps:${RESET}`);
      for (const result of results) {
        console.log(`  - ${result.label} (${result.ms} ms)`);
      }
    }
    return typeof err.code === 'number' ? err.code : 1;
  }

  const totalMs = Math.round(performance.now() - startedAll);
  console.log('');
  const overRoutineBudget = options.routine && totalMs >= 30 * 60 * 1000;
  console.log(
    `${GREEN}${BOLD}Selected correctness checks passed${RESET} in ${YELLOW}${totalMs} ms${RESET}`
  );
  console.log(`${BOLD}Step timings:${RESET}`);
  for (const result of results) {
    console.log(`  - ${result.label} (${result.ms} ms)`);
  }
  if (overRoutineBudget) {
    console.error(
      'Routine validation exceeded the required 30 minutes. Turnaround acceptance failed.'
    );
    return 1;
  }
  return 0;
}

// Only orchestrate when executed directly. Importing this module (the parity
// test does) must never launch the gate.
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`${RED}${error instanceof Error ? error.message : String(error)}${RESET}`);
      process.exitCode = 1;
    });
}
