import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The Browser tests CI job (test.yml) runs `pnpm test:browser` with an
 * explicit `--filter` per browser-test package, because an unfiltered root
 * turbo run scopes all workspace packages and builds the desktop native
 * addons — which the toolchain-less Playwright container cannot compile
 * (BST-994; proven by the lane's first run failing on `make: not found`).
 *
 * The cost of an explicit list is drift: a package that gains a
 * `test:browser` script without being added to the workflow filter would run
 * its browser tests NOWHERE in CI — the exact silent blind spot BST-994
 * closed (ui's and storage's suites sat unwired for months). This contract
 * pins the filter list to the set of packages actually defining the script.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The suffix every browser suite carries: what createBrowserProject and mcp-app-host select. */
const BROWSER_SUITE = /\.browser\.test\.[cm]?[jt]sx?$/u;

function workspacePackages() {
  const found = [];
  for (const dir of ['packages', 'apps']) {
    const base = path.join(repoRoot, dir);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageDir = path.join(base, entry.name);
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      found.push({ dir: packageDir, manifest });
    }
  }
  return found;
}

function packagesDefiningTestBrowser() {
  return workspacePackages()
    .filter(({ manifest }) => manifest.scripts?.['test:browser'])
    .map(({ manifest }) => manifest.name)
    .sort();
}

function holdsBrowserSuite(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() ? holdsBrowserSuite(full) : BROWSER_SUITE.test(entry.name)) {
      return true;
    }
  }
  return false;
}

/** Packages whose tests include browser suites, which only the Browser tests lane can run. */
function packagesHoldingBrowserSuites() {
  return workspacePackages()
    .filter(({ dir }) => holdsBrowserSuite(dir))
    .map(({ manifest }) => manifest.name)
    .sort();
}

function workflowFilterList() {
  const workflow = readFileSync(path.join(repoRoot, '.github/workflows/test.yml'), 'utf8');
  const runLine = workflow.match(/^\s*run: (pnpm test:browser .*)$/m);
  assert.ok(
    runLine,
    'Could not find the Browser tests run line in test.yml. If the job was ' +
      'renamed or restructured, teach this contract the new shape.'
  );
  return [...runLine[1].matchAll(/--filter=(\S+)/gu)].map((match) => match[1]).sort();
}

function embeddingWorkerScripts() {
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'packages/embedding-worker/package.json'), 'utf8')
  );
  return manifest.scripts ?? {};
}

test('embedding-worker separates unit and browser Vitest projects', () => {
  const scripts = embeddingWorkerScripts();
  assert.equal(scripts.test, 'vitest run --project unit');
  assert.equal(scripts['test:browser'], 'vitest run --project browser');
});

// BST-2086: the reverse gap. A package that holds browser suites but has no
// `test:browser` runs them from `test` and `test:coverage`, so the Node lanes
// try to launch a Chromium they never installed, and the Browser tests lane,
// which has one, never selects the package.
test('every package holding browser suites defines test:browser', () => {
  const holders = packagesHoldingBrowserSuites();
  const defining = new Set(packagesDefiningTestBrowser());
  assert.deepEqual(
    holders.filter((name) => !defining.has(name)),
    [],
    'These packages hold *.browser.test.* suites but define no test:browser. Use the ' +
      'convention: "test": "vitest run --project unit", "test:browser": "vitest run ' +
      '--project browser", and "test:coverage": "pnpm run test --coverage …".'
  );
  // Anti-vacuity: a walker that stopped finding suites would pass forever.
  assert.ok(
    holders.length >= 9,
    `expected at least 9 browser-suite packages, found ${holders.length}`
  );
});

test('the Browser tests CI filter list equals the packages defining test:browser', () => {
  assert.deepEqual(
    workflowFilterList(),
    packagesDefiningTestBrowser(),
    'A package defines test:browser but is missing from (or stale in) the ' +
      'Browser tests job filter list in test.yml — its browser suites would ' +
      'silently run nowhere in CI. Update the --filter list.'
  );
});
