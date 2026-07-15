// Guard: the Playwright container image tag hard-coded in
// .github/workflows/{test.yml,web-e2e.yml,performance.yml} (`container.image:
// mcr.microsoft.com/playwright:vX.Y.Z-noble`) must equal the `@playwright/test`
// devDependency version pinned at the repo root. `container.image:` cannot
// consume a workflow `env:`/expression in a way that works across these
// trigger types (schedule, workflow_dispatch, pull_request, push), so the tag
// stays a hand-written literal in all three files — this script is the single
// source of verification instead of a fragile interpolation. Wired into the
// Static job in test.yml via the existing `pnpm test:scripts` step (this
// file's paired test in scripts/__tests__/).
//
// FAILS when (NO SILENT FALLBACKS — Series C task-2 brief: "must not pass
// vacuously", the class that has bitten four other Series C tasks):
//  - any of the three workflow files no longer contains a
//    `mcr.microsoft.com/playwright:vX.Y.Z-noble` pin at all (a rename/removal
//    this guard would otherwise silently miss by finding zero violations), or
//  - a pin's version does not equal package.json's `@playwright/test` version.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Workflow files that must carry the Playwright container image pin. */
export const PINNED_WORKFLOWS = Object.freeze([
  '.github/workflows/test.yml',
  '.github/workflows/web-e2e.yml',
  '.github/workflows/performance.yml',
]);

const IMAGE_PIN_PATTERN = /mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble/g;

/** Strip a semver range prefix (`^`, `~`, exact) down to the bare X.Y.Z version. */
function bareVersion(range) {
  const match = /(\d+\.\d+\.\d+)/.exec(range);
  if (!match) {
    throw new Error(`verify-playwright-pin-sync: cannot parse a version out of '${range}'`);
  }
  return match[1];
}

/**
 * Compare the Playwright container image pins across PINNED_WORKFLOWS against
 * the repo's `@playwright/test` version.
 *
 * @param {{ repoRoot?: string }} options
 * @returns {{ expectedVersion: string, mismatches: { file: string, foundVersions: string[] }[] }}
 * @throws if package.json has no `@playwright/test` dependency, or if any
 *   pinned workflow file no longer contains the image-pin pattern at all
 *   (a structural precondition failure, not a reportable mismatch — this
 *   guard must not pass vacuously).
 */
export function checkPlaywrightPinSync(options = {}) {
  const repoRoot = options.repoRoot ?? resolve(HERE, '..');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const rawRange =
    pkg.devDependencies?.['@playwright/test'] ?? pkg.dependencies?.['@playwright/test'];
  if (typeof rawRange !== 'string') {
    throw new Error(
      'verify-playwright-pin-sync: package.json has no @playwright/test dependency to pin against'
    );
  }
  const expectedVersion = bareVersion(rawRange);

  const mismatches = [];
  for (const relPath of PINNED_WORKFLOWS) {
    const filePath = join(repoRoot, relPath);
    const content = readFileSync(filePath, 'utf8');
    const foundVersions = [...content.matchAll(IMAGE_PIN_PATTERN)].map((m) => m[1]);
    if (foundVersions.length === 0) {
      throw new Error(
        `verify-playwright-pin-sync: no 'mcr.microsoft.com/playwright:vX.Y.Z-noble' pin found in ` +
          `${relPath} — this guard must not pass vacuously. Add the pin back, or if the file no ` +
          'longer needs one, remove it from PINNED_WORKFLOWS deliberately.'
      );
    }
    const uniqueVersions = [...new Set(foundVersions)];
    if (uniqueVersions.length !== 1 || uniqueVersions[0] !== expectedVersion) {
      mismatches.push({ file: relPath, foundVersions: uniqueVersions });
    }
  }

  return { expectedVersion, mismatches };
}

function main() {
  const { expectedVersion, mismatches } = checkPlaywrightPinSync();

  if (mismatches.length > 0) {
    const detail = mismatches
      .map((m) => `  - ${m.file}: found ${m.foundVersions.join(', ')}, expected ${expectedVersion}`)
      .join('\n');
    throw new Error(
      `verify-playwright-pin-sync: ${mismatches.length} file(s) out of sync with ` +
        `@playwright/test@${expectedVersion}:\n${detail}`
    );
  }

  process.stdout.write(
    `verify-playwright-pin-sync: OK (@playwright/test@${expectedVersion} across ${PINNED_WORKFLOWS.length} workflows)\n`
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
