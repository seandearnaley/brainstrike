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
// A Codecov status is considered NON-GATING when it is either disabled
// (`off`/`false`) or `informational: true` — the latter is Codecov's documented
// mechanism for "post the number, never fail the status"
// (https://docs.codecov.com/docs/commit-status).
//
// FAILS when (NO SILENT FALLBACKS — this guard must not pass vacuously):
//  - codecov.yml is missing or unparseable, or
//  - the `coverage.status` block is absent entirely (a removal this guard would
//    otherwise "pass" by finding zero violations), or
//  - any configured status is enabled without `informational: true`.
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
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));

export const CODECOV_CONFIG_PATH = 'codecov.yml';

/**
 * Status keys Codecov supports under `coverage.status`. Listed explicitly so a
 * NEW status type added to the config is reported as unknown rather than
 * silently skipped — skipping is how a gating status would sneak back.
 */
export const KNOWN_STATUS_KEYS = Object.freeze(['project', 'patch', 'changes']);

function isDisabled(value) {
  // Codecov accepts `off`, `false`, and `null` to disable a status. The YAML
  // parser turns bare `off` into the boolean false, so both land here.
  return value === false || value === null || value === 'off';
}

/**
 * Collects every gating (non-informational, enabled) status in a parsed config.
 *
 * A status may be declared directly (`patch: {...}`) or per-context under
 * `default:`/named keys. Any context that is enabled and not explicitly
 * informational counts as gating.
 */
export function findGatingStatuses(config) {
  const status = config?.coverage?.status;
  if (status === undefined || status === null || typeof status !== 'object') {
    throw new Error(
      `${CODECOV_CONFIG_PATH}: no \`coverage.status\` block found. This guard verifies that every ` +
        'Codecov status is non-gating; with the block removed it would pass vacuously. If Codecov ' +
        'statuses were intentionally dropped, delete this guard and its test in the same change.'
    );
  }

  const gating = [];
  const unknown = [];

  for (const [statusKey, statusValue] of Object.entries(status)) {
    if (!KNOWN_STATUS_KEYS.includes(statusKey)) {
      unknown.push(statusKey);
      continue;
    }
    if (isDisabled(statusValue)) {
      continue;
    }
    if (typeof statusValue !== 'object') {
      gating.push(`${statusKey} (enabled as \`${String(statusValue)}\`, not informational)`);
      continue;
    }

    // A status object is either one context's settings or a map of named
    // contexts. `informational` at the top level applies to all of them.
    if (statusValue.informational === true) {
      continue;
    }
    for (const [contextKey, contextValue] of Object.entries(statusValue)) {
      if (contextKey === 'informational') {
        continue;
      }
      if (isDisabled(contextValue) || typeof contextValue !== 'object') {
        continue;
      }
      if (contextValue.informational !== true) {
        gating.push(`${statusKey}.${contextKey}`);
      }
    }
  }

  return { gating, unknown };
}

export function verifyCodecovStatusContract(repoRoot = resolve(HERE, '..')) {
  const configPath = join(repoRoot, CODECOV_CONFIG_PATH);

  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (cause) {
    throw new Error(
      `${CODECOV_CONFIG_PATH} could not be read (${cause.message}). This guard cannot verify a ` +
        'config that is not there; restore the file or remove the guard deliberately.'
    );
  }

  const config = parseYaml(raw);
  const { gating, unknown } = findGatingStatuses(config);

  const problems = [];
  if (unknown.length > 0) {
    problems.push(
      `Unrecognised Codecov status key(s): ${unknown.join(', ')}. Add them to KNOWN_STATUS_KEYS ` +
        'and decide explicitly whether they gate — an unhandled key would be skipped silently.'
    );
  }
  if (gating.length > 0) {
    problems.push(
      `These Codecov statuses are configured to FAIL builds: ${gating.join(', ')}.\n` +
        "None of them is in the ruleset's required checks (Static, Unit, Build, Web E2E, " +
        'Desktop E2E), so a failure cannot block a merge — it only shows a red X and marks the ' +
        'merge box UNSTABLE.\n' +
        "Either set `informational: true` (Codecov's documented non-gating mode, which still " +
        'reports the percentage), or — if you genuinely want this to gate — make PR uploads ' +
        'complete AND add the context to the ruleset in the same change.\n' +
        'Full rationale: codecov.yml and docs/agents/ci-quality.md.'
    );
  }

  return problems;
}

/**
 * Script entrypoint, per the `scripts/verify-*.mjs` contract pinned by
 * `verify-script-entrypoints.test.mjs`: it must THROW (or exit non-zero) rather
 * than report success on a root it cannot actually verify. Pointed at an empty
 * directory this throws on the missing `codecov.yml`, which is the property that
 * meta-test exists to enforce.
 */
export function main(options = {}) {
  const problems = verifyCodecovStatusContract(options.repoRoot);

  if (problems.length > 0) {
    throw new Error(`verify-codecov-status-contract:\n\n${problems.join('\n\n')}`);
  }

  process.stdout.write('verify-codecov-status-contract: OK (no gating Codecov statuses)\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
