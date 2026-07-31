#!/usr/bin/env node
/**
 * Affected-build selection for the Build job (BST-1005, R09).
 *
 * The Build job used to run `pnpm run build` unfiltered on every pull request
 * and gate both E2E jobs. On a representative PR only 20 of 47 packages are
 * actually affected, so the unfiltered run rebuilt more than half the
 * workspace for nothing — and then both E2E jobs ran regardless of whether
 * their app was touched at all.
 *
 * This module answers ONE question from turbo's own `--dry=json` output: which
 * of the two E2E apps are in the affected set? The workflow uses that to skip
 * the E2E job whose app was not built.
 *
 * FAIL-CLOSED BY CONSTRUCTION. `Build`, `Web E2E`, and `Desktop E2E` are
 * required contexts in the repo's active ruleset, and GitHub treats a SKIPPED
 * required check as satisfied. A selection bug that reported "nothing
 * affected" would therefore merge untested code behind a green board. Every
 * unparseable or unexpected payload throws, which fails the Build job and
 * keeps the required checks red. There is deliberately no default-to-empty
 * path — see affected-build-selection.test.mjs.
 */

/** The two apps whose E2E jobs are gated on the affected set. */
export const E2E_APP_PACKAGES = {
  desktop: '@brainstrike/desktop',
  web: '@brainstrike/web',
};

/**
 * Read the selected package list out of a `turbo run build --dry=json`
 * payload. Throws on anything that is not a well-formed package list.
 *
 * Note that `{ packages: ['//'] }` is VALID and means "nothing affected" —
 * turbo always includes the workspace root. That legitimate empty answer is
 * the only way this module reports an empty selection.
 */
export function parseTurboDryRunPackages(stdout) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse turbo --dry=json output as JSON: ${detail}`);
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('turbo --dry=json output was not a JSON object.');
  }
  const packages = payload.packages;
  if (!Array.isArray(packages)) {
    throw new Error('turbo --dry=json output has no `packages` array.');
  }
  for (const entry of packages) {
    if (typeof entry !== 'string') {
      throw new Error(
        `turbo --dry=json packages[] contained a non-string entry: ${JSON.stringify(entry)}`
      );
    }
  }
  return packages;
}

/**
 * Which E2E apps are present in the affected package list.
 */
export function resolveE2eSelection(selectedPackages) {
  const selected = new Set(selectedPackages);
  return {
    desktop: selected.has(E2E_APP_PACKAGES.desktop),
    web: selected.has(E2E_APP_PACKAGES.web),
  };
}

/**
 * Render the selection as GitHub Actions `key=value` output lines.
 */
export function formatSelectionOutputs(selection) {
  return `web=${selection.web}\ndesktop=${selection.desktop}\n`;
}

/**
 * CLI: reads a turbo `--dry=json` payload on STDIN and writes the GitHub
 * Actions output lines to STDOUT. The workflow owns the turbo invocation —
 * this module must never spawn turbo itself, because only
 * run-turbo-command.mjs may name the turbo binary (that invariant is swept by
 * run-turbo-command.test.mjs).
 *
 * Any parse failure exits non-zero, which fails the Build job and keeps the
 * required E2E contexts red rather than silently skipping them.
 */
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const packages = parseTurboDryRunPackages(Buffer.concat(chunks).toString('utf8'));
  process.stdout.write(formatSelectionOutputs(resolveE2eSelection(packages)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
