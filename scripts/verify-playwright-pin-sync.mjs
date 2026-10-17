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
//  - a pin's version does not equal package.json's `@playwright/test` version, or
//  - `@playwright/test` is declared as `catalog:` but has no catalog entry to
//    resolve (skipping instead would silently disable this guard).
//
// `@playwright/test` is catalogued (Series C R8), so package.json declares
// `"catalog:"` and the version is resolved through pnpm-workspace.yaml via the
// shared resolveCatalogReference() — see verify-catalog-references.mjs. `bump the
// catalog entry` is therefore the fix when this guard reports a mismatch.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse the single tested pnpm-workspace.yaml catalog parser rather than
// hand-rolling a second one here (Series C R8 catalogued `@playwright/test`, so
// package.json now reads "catalog:" instead of a literal). Two independent
// parsers of the same file is the drift shape both guards exist to prevent.
import { resolveCatalogReference } from './verify-catalog-references.mjs';

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
  // `@playwright/test` is catalogued, so rawRange is normally "catalog:" and the
  // real range lives in pnpm-workspace.yaml. resolveCatalogReference() follows
  // that indirection (and throws if the reference has no catalog entry rather
  // than letting this guard skip silently); a literal range passes straight
  // through without reading pnpm-workspace.yaml at all.
  const expectedVersion = bareVersion(
    resolveCatalogReference('@playwright/test', rawRange, { repoRoot })
  );

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

/** Verify each web job provisions CfT on the official Playwright engine fleet.
 * @param {{ repoRoot?: string }} options
 */
export function checkWebChromiumProvisioning(options = {}) {
  const repoRoot = options.repoRoot ?? resolve(HERE, '..');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const versions = ['@playwright/test', 'playwright'].map((name) => {
    const spec = pkg.devDependencies?.[name] ?? pkg.dependencies?.[name];
    if (typeof spec !== 'string') {
      throw new Error(`Missing Playwright driver dependency: ${name}`);
    }
    const version = resolveCatalogReference(name, spec, { repoRoot });
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`Playwright driver ${name} must use an exact pin: ${version}`);
    }
    return version;
  });
  if (versions[0] !== versions[1]) {
    throw new Error('Playwright driver pins disagree');
  }
  for (const [file, job] of [
    ['.github/workflows/test.yml', 'web-e2e'],
    ['.github/workflows/web-e2e.yml', 'web-full-regression'],
    ['.github/workflows/performance.yml', 'web-perf'],
  ]) {
    const workflow = readFileSync(join(repoRoot, file), 'utf8');
    const content = new RegExp(
      `^  ${job}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`,
      'm'
    ).exec(workflow)?.[1];
    if (!content) {
      throw new Error(`Missing web Chromium job: ${file}/${job}`);
    }
    const image =
      /image: mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@sha256:[a-f0-9]{64}\s*$/m.exec(
        content
      );
    if (!image || image[1] !== versions[0]) {
      throw new Error(`Web Chromium job ${file} requires the matching immutable official base`);
    }
    for (const step of ['Install web test system tools', 'Provision qualified web Chromium']) {
      if (!content.includes(`- name: ${step}\n        shell: bash\n`)) {
        throw new Error(`Web Chromium provisioning step ${file}/${step} requires explicit bash`);
      }
    }
    for (const required of [
      'options: --user 0',
      'node-version-file: .nvmrc',
      'apt-get install -y --no-install-recommends unzip lsof procps',
      'test "$(node --version)" = "v$(cat .nvmrc)"',
      'node scripts/provision-web-chromium.mjs "$BRAINSTRIKE_WEB_CHROMIUM_DIR"',
    ]) {
      if (!content.includes(required)) {
        throw new Error(`Web Chromium job ${file} is missing explicit provisioning: ${required}`);
      }
    }
    // BST-2066: `jobs.<id>.env` cannot read the `runner` context (GitHub's
    // context-availability table), and a `${{ runner.temp }}` there invalidates
    // the workflow. The provisioning step exports the directory instead, so
    // every later step reads it from $GITHUB_ENV.
    const jobEnv = /^ {4}env:\n((?: {6}.*\n)+)/m.exec(content)?.[1] ?? '';
    if (/\$\{\{\s*runner\./.test(jobEnv)) {
      throw new Error(`Web Chromium job ${file}: job-level env cannot read the runner context`);
    }
    const provisioning =
      /^ {6}- name: Provision qualified web Chromium\n([\s\S]*?)(?=^ {6}- |(?![\s\S]))/m.exec(
        content
      )?.[1] ?? '';
    for (const exported of [
      'BRAINSTRIKE_WEB_CHROMIUM_DIR="$RUNNER_TEMP/web-chromium"',
      'echo "BRAINSTRIKE_WEB_CHROMIUM_DIR=$BRAINSTRIKE_WEB_CHROMIUM_DIR" >> "$GITHUB_ENV"',
    ]) {
      if (!provisioning.includes(exported)) {
        throw new Error(
          `Web Chromium job ${file} is missing explicit provisioning: the Provision qualified web Chromium step must export ${exported}`
        );
      }
    }
  }
}

/**
 * @param {{ repoRoot?: string }} options — threaded so the BST-836 entrypoint
 *   contract test can drive this guard against a tree where it must not pass.
 */
export function main(options = {}) {
  const { expectedVersion, mismatches } = checkPlaywrightPinSync(options);
  checkWebChromiumProvisioning(options);

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
