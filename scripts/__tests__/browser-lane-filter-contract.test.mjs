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

function packagesDefiningTestBrowser() {
  const found = [];
  for (const dir of ['packages', 'apps']) {
    const base = path.join(repoRoot, dir);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(path.join(base, entry.name, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      if (manifest.scripts?.['test:browser']) {
        found.push(manifest.name);
      }
    }
  }
  return found.sort();
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

test('the Browser tests CI filter list equals the packages defining test:browser', () => {
  assert.deepEqual(
    workflowFilterList(),
    packagesDefiningTestBrowser(),
    'A package defines test:browser but is missing from (or stale in) the ' +
      'Browser tests job filter list in test.yml — its browser suites would ' +
      'silently run nowhere in CI. Update the --filter list.'
  );
});
