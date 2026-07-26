// Guard: no Codecov commit status may claim to be a merge gate, because none of
// them is one.
//
// The repository ruleset requires exactly five contexts — Static, Unit, Build,
// Web E2E, Desktop E2E — every one produced by .github/workflows/test.yml.
// `codecov/patch` and `codecov/project` are NOT among them, so a failing
// Codecov status cannot block a merge; it only renders a red X and an UNSTABLE
// merge box, which reads as a broken build to a human reviewer.
//
// That mismatch was live: codecov.yml said "Keep patch coverage blocking
// instead" while test.yml and docs/agents/ci-quality.md both said coverage is
// advisory. Two sources and the ruleset agreed; codecov.yml was the outlier.
// This guard exists so the three cannot drift apart again silently.
//
// A status context is NON-GATING only when it is disabled (`off`/`false`/null)
// or carries `informational: true` — Codecov's documented mechanism for "post
// the number, never fail the status"
// (https://docs.codecov.com/docs/commit-status).
//
// TWO FAILURE MODES THIS GUARD MUST AVOID, and the first review of it found
// SIX instances of the first:
//   - passing vacuously, i.e. reporting OK because it found nothing it
//     understood (an empty/array status block, settings written flat without a
//     `default:` wrapper, a scalar context like `default: true`); and
//   - failing on a VALID config, which is worse than the red X this removed —
//     `pnpm test:scripts` runs in the Static job, a REQUIRED check, so a false
//     positive here blocks every merge.
//
// The second is why unknown keys under `coverage.status` are REPORTED but not
// fatal. Codecov publishes exactly three status contexts — `codecov/project`,
// `codecov/patch`, `codecov/changes` — so no other key can produce a gating
// check; keys like `default_rules` are configuration, not statuses. Throwing on
// them bought no safety and risked blocking merges on a valid file.
//
// THE FIX when this fails is deliberately NOT "add informational: true and move
// on". Making a Codecov status gate again is a two-part change:
//   1. PR coverage uploads must become complete — today they are affected-only,
//      which understates patch coverage (measured on PR #2024: Codecov reported
//      27.86% where the changed files were 97-98% covered), and a stacked PR has
//      no BASE report to compare against at all; and
//   2. the context must be added to the ruleset's required checks, otherwise it
//      still cannot block anything and only produces a misleading red X.
// Do one without the other and you have re-created the contradiction.
//
// The authoritative threshold gate remains nightly-coverage.yml ->
// `pnpm coverage:enforce` (scripts/enforce-coverage.mjs): full, unfiltered
// coverage with ratcheted per-package thresholds.
//
// Wired into the Static job in test.yml via the existing `pnpm test:scripts`
// step (this file's paired test in scripts/__tests__/).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Every location Codecov reads repository config from: the project root, `dev/`
 * and `.github/`, each as `codecov.yml` or `.codecov.yml`
 * (https://docs.codecov.com/docs/codecov-yaml).
 *
 * Checking only the root would have let a `.github/codecov.yml` with a gating
 * status take effect at Codecov while this guard stayed green on an untouched
 * root file — precisely the silent drift it exists to prevent.
 */
export const CODECOV_CONFIG_PATHS = Object.freeze([
  'codecov.yml',
  '.codecov.yml',
  '.github/codecov.yml',
  '.github/.codecov.yml',
  'dev/codecov.yml',
  'dev/.codecov.yml',
]);

/**
 * The only keys under `coverage.status` that produce a commit status. Anything
 * else there is configuration and cannot gate, so it is reported for visibility
 * rather than failing the build.
 */
export const STATUS_CONTEXT_KEYS = Object.freeze(['project', 'patch', 'changes']);

function isPlainMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True for the values Codecov accepts to switch a status off.
 *
 * `yaml` v2 parses with the YAML 1.2 core schema, where ONLY `true`/`false` are
 * booleans — bare `off` stays the STRING `'off'`, in any capitalisation. So the
 * string branch is what actually disables `project: off` in codecov.yml; the
 * `false` branch covers an explicit `project: false`.
 */
function isDisabled(value) {
  if (value === false || value === null || value === undefined) {
    return true;
  }
  return typeof value === 'string' && value.trim().toLowerCase() === 'off';
}

/**
 * Collects every gating (enabled, not-informational) status context.
 *
 * Codecov reads `coverage.status.<type>` as a MAP OF CONTEXTS (`default` plus
 * any custom names), not as a settings object. Every child of an enabled status
 * is therefore treated as a context and must itself be disabled or explicitly
 * informational. That single rule covers the shapes the review found slipping
 * through: settings written flat (`patch: {target: 70%}`), a scalar context
 * (`patch: {default: true}`), and a status-level `informational:` shorthand
 * that is NOT documented per-context and would otherwise have waved through a
 * still-gating `default`.
 */
export function findGatingStatuses(config) {
  const status = config?.coverage?.status;

  if (!isPlainMapping(status) || Object.keys(status).length === 0) {
    throw new Error(
      'no `coverage.status` block found (or it is empty / not a mapping). This guard verifies ' +
        'that every Codecov status is non-gating; with nothing to inspect it would pass ' +
        'vacuously. If Codecov statuses were intentionally dropped, delete this guard and its ' +
        'test in the same change.'
    );
  }

  const gating = [];
  const ignored = [];

  for (const [statusKey, statusValue] of Object.entries(status)) {
    if (!STATUS_CONTEXT_KEYS.includes(statusKey)) {
      // Configuration, not a status — cannot produce a commit status, so it is
      // surfaced rather than failed on (see the header note on false positives).
      ignored.push(statusKey);
      continue;
    }
    if (isDisabled(statusValue)) {
      continue;
    }
    if (!isPlainMapping(statusValue)) {
      gating.push(
        `${statusKey} (enabled as \`${JSON.stringify(statusValue)}\`, not a context map)`
      );
      continue;
    }
    if (Object.keys(statusValue).length === 0) {
      gating.push(`${statusKey} (empty mapping — Codecov applies its gating defaults)`);
      continue;
    }

    for (const [contextKey, contextValue] of Object.entries(statusValue)) {
      if (isDisabled(contextValue)) {
        continue;
      }
      if (!isPlainMapping(contextValue)) {
        gating.push(
          `${statusKey}.${contextKey} (\`${JSON.stringify(contextValue)}\` is not a context map, ` +
            'so it cannot carry `informational: true`)'
        );
        continue;
      }
      if (contextValue.informational !== true) {
        gating.push(`${statusKey}.${contextKey}`);
      }
    }
  }

  return { gating, ignored };
}

/**
 * Locates the single Codecov config. Zero matches means this guard cannot
 * verify anything; two or more means the effective config is ambiguous (which
 * of the locations wins is not documented), and an unverified second file is
 * exactly the drift this guard exists to catch. Both are hard failures.
 */
export function resolveCodecovConfigPath(repoRoot) {
  const found = CODECOV_CONFIG_PATHS.filter((candidate) => existsSync(join(repoRoot, candidate)));

  if (found.length === 0) {
    throw new Error(
      `no Codecov config found in any of: ${CODECOV_CONFIG_PATHS.join(', ')}. This guard cannot ` +
        'verify a config that is not there; restore the file or remove the guard deliberately.'
    );
  }
  if (found.length > 1) {
    throw new Error(
      `multiple Codecov configs found (${found.join(', ')}). Codecov reads one of the root, ` +
        '`dev/` and `.github/` locations and which wins is not documented, so a second file can ' +
        'silently change the effective config. Keep exactly one.'
    );
  }
  return join(repoRoot, found[0]);
}

export function verifyCodecovStatusContract(repoRoot = resolve(HERE, '..')) {
  const configPath = resolveCodecovConfigPath(repoRoot);
  const config = parseYaml(readFileSync(configPath, 'utf8'));
  const { gating, ignored } = findGatingStatuses(config);

  const problems = [];
  if (gating.length > 0) {
    problems.push(
      `These Codecov status contexts are configured to FAIL builds: ${gating.join(', ')}.\n` +
        "None of them is in the ruleset's required checks (Static, Unit, Build, Web E2E, " +
        'Desktop E2E), so a failure cannot block a merge — it only shows a red X and marks the ' +
        'merge box UNSTABLE.\n' +
        "Expected shape: `coverage.status.<type>.<context>.informational: true` (Codecov's " +
        'documented non-gating mode, which still reports the percentage), or the status set to ' +
        '`off`.\n' +
        'If you genuinely want this to gate: make PR uploads complete AND add the context to the ' +
        'ruleset in the same change. Full rationale: codecov.yml and docs/agents/ci-quality.md.'
    );
  }

  return { ignored, problems };
}

/**
 * Script entrypoint, per the `scripts/verify-*.mjs` contract pinned by
 * `verify-script-entrypoints.test.mjs`: it must THROW (or exit non-zero) rather
 * than report success on a root it cannot actually verify. Pointed at an empty
 * directory this throws on the missing config, which is the property that
 * meta-test exists to enforce.
 */
export function main(options = {}) {
  const { ignored, problems } = verifyCodecovStatusContract(options.repoRoot);

  if (problems.length > 0) {
    throw new Error(`verify-codecov-status-contract:\n\n${problems.join('\n\n')}`);
  }

  const note =
    ignored.length > 0
      ? ` (ignored non-status key(s) under coverage.status: ${ignored.join(', ')} — these cannot ` +
        'produce a commit status)'
      : '';
  process.stdout.write(`verify-codecov-status-contract: OK (no gating Codecov statuses)${note}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
