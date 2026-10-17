import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  checkPlaywrightPinSync,
  checkWebChromiumProvisioning,
  PINNED_WORKFLOWS,
} from '../verify-playwright-pin-sync.mjs';

// Guard: the Playwright container image tag hard-coded in
// .github/workflows/{test.yml,web-e2e.yml,performance.yml} must match
// @playwright/test's version pinned at the repo root — `container.image:`
// cannot consume a workflow expression, so the tag stays a literal in all
// three files and this script is the single source of drift verification.
test('real tree: all three Playwright container pins match @playwright/test', () => {
  const { expectedVersion, mismatches } = checkPlaywrightPinSync();
  assert.deepEqual(
    mismatches,
    [],
    `Playwright container image pin(s) out of sync with @playwright/test@${expectedVersion}:\n` +
      mismatches.map((m) => `  - ${m.file}: found ${m.foundVersions.join(', ')}`).join('\n')
  );
});

/**
 * Build a throwaway repo root with a package.json pinning `@playwright/test`
 * and one workflow file per PINNED_WORKFLOWS whose content is supplied by
 * `workflowContents` (relative path -> file text). Returns the repoRoot.
 */
async function writeFixture(playwrightRange, workflowContents) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'playwright-pin-guard-'));
  await writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ devDependencies: { '@playwright/test': playwrightRange } })
  );
  for (const relPath of PINNED_WORKFLOWS) {
    const full = path.join(repoRoot, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, workflowContents[relPath] ?? '');
  }
  return repoRoot;
}

const pinnedLine = (version) =>
  `    container:\n      image: mcr.microsoft.com/playwright:v${version}-noble\n`;

test('passes when every pinned workflow matches the package.json version exactly', async () => {
  const repoRoot = await writeFixture('^1.61.1', {
    '.github/workflows/performance.yml': pinnedLine('1.61.1'),
    '.github/workflows/test.yml': pinnedLine('1.61.1'),
    '.github/workflows/web-e2e.yml': pinnedLine('1.61.1'),
  });

  const { expectedVersion, mismatches } = checkPlaywrightPinSync({ repoRoot });
  assert.equal(expectedVersion, '1.61.1');
  assert.deepEqual(mismatches, []);
});

test('MUST FAIL: a workflow pinned to a different version than package.json', async () => {
  const repoRoot = await writeFixture('^1.61.1', {
    '.github/workflows/performance.yml': pinnedLine('1.61.1'),
    '.github/workflows/test.yml': pinnedLine('1.61.1'),
    '.github/workflows/web-e2e.yml': pinnedLine('1.60.0'), // stale, forgot to bump
  });

  const { mismatches } = checkPlaywrightPinSync({ repoRoot });
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].file, '.github/workflows/web-e2e.yml');
  assert.deepEqual(mismatches[0].foundVersions, ['1.60.0']);
});

test('MUST THROW (not pass vacuously): a pinned workflow has no image-pin line at all', async () => {
  // The exact regression this guard exists to catch: someone reworks
  // web-e2e.yml (e.g. drops the container) and the pin silently disappears
  // instead of tripping a "0 violations found" false green.
  const repoRoot = await writeFixture('^1.61.1', {
    '.github/workflows/performance.yml': pinnedLine('1.61.1'),
    '.github/workflows/test.yml': pinnedLine('1.61.1'),
    '.github/workflows/web-e2e.yml': '# no container/image line here\n',
  });

  assert.throws(() => checkPlaywrightPinSync({ repoRoot }), /no .* pin found in .*web-e2e\.yml/);
});

test('MUST THROW: package.json has no @playwright/test dependency', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'playwright-pin-guard-'));
  await writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({ devDependencies: {} }));
  for (const relPath of PINNED_WORKFLOWS) {
    const full = path.join(repoRoot, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, pinnedLine('1.61.1'));
  }

  assert.throws(() => checkPlaywrightPinSync({ repoRoot }), /no @playwright\/test dependency/);
});

/**
 * Write a fixture whose package.json uses a `catalog:` reference, plus a
 * pnpm-workspace.yaml carrying `catalogEntry` (omit it for the no-entry case).
 */
async function writeCatalogFixture(spec, catalogEntry, workflowContents) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'playwright-pin-guard-'));
  await writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ devDependencies: { '@playwright/test': spec } })
  );
  await writeFile(
    path.join(repoRoot, 'pnpm-workspace.yaml'),
    `packages:\n  - packages/*\ncatalog:\n${catalogEntry ? `  '@playwright/test': ${catalogEntry}\n` : '  typescript: ^6.0.3\n'}`
  );
  for (const relPath of PINNED_WORKFLOWS) {
    const full = path.join(repoRoot, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, workflowContents[relPath] ?? '');
  }
  return repoRoot;
}

// Series C R8 catalogued `@playwright/test`, so the root package.json declares
// "catalog:" and this guard must follow the indirection into
// pnpm-workspace.yaml. Before that, it crashed: "cannot parse a version out of
// 'catalog:'" — a real cross-PR integration failure Static caught.
test('resolves a catalog: reference to the catalog version', async () => {
  const repoRoot = await writeCatalogFixture('catalog:', '^1.61.1', {
    '.github/workflows/performance.yml': pinnedLine('1.61.1'),
    '.github/workflows/test.yml': pinnedLine('1.61.1'),
    '.github/workflows/web-e2e.yml': pinnedLine('1.61.1'),
  });

  const { expectedVersion, mismatches } = checkPlaywrightPinSync({ repoRoot });
  assert.equal(expectedVersion, '1.61.1');
  assert.deepEqual(mismatches, []);
});

test('resolves catalog:default the same as catalog:', async () => {
  const repoRoot = await writeCatalogFixture('catalog:default', '^1.61.1', {
    '.github/workflows/performance.yml': pinnedLine('1.61.1'),
    '.github/workflows/test.yml': pinnedLine('1.61.1'),
    '.github/workflows/web-e2e.yml': pinnedLine('1.61.1'),
  });

  assert.equal(checkPlaywrightPinSync({ repoRoot }).expectedVersion, '1.61.1');
});

test('MUST FAIL: a catalog-resolved version still detects a stale container pin', async () => {
  // The guard must not merely stop crashing — it must keep BITING through the
  // indirection. A guard that resolves catalog: but no longer detects drift
  // would be worse than the crash it replaced.
  const repoRoot = await writeCatalogFixture('catalog:', '^1.61.1', {
    '.github/workflows/performance.yml': pinnedLine('1.61.1'),
    '.github/workflows/test.yml': pinnedLine('1.61.1'),
    '.github/workflows/web-e2e.yml': pinnedLine('1.60.0'),
  });

  const { expectedVersion, mismatches } = checkPlaywrightPinSync({ repoRoot });
  assert.equal(expectedVersion, '1.61.1');
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].file, '.github/workflows/web-e2e.yml');
  assert.deepEqual(mismatches[0].foundVersions, ['1.60.0']);
});

test('MUST THROW (not skip): catalog: reference with no catalog entry', async () => {
  // Falling back to skipping would silently disable this guard entirely — the
  // exact failure class it exists to prevent.
  const repoRoot = await writeCatalogFixture('catalog:', null, {
    '.github/workflows/performance.yml': pinnedLine('1.61.1'),
    '.github/workflows/test.yml': pinnedLine('1.61.1'),
    '.github/workflows/web-e2e.yml': pinnedLine('1.61.1'),
  });

  assert.throws(
    () => checkPlaywrightPinSync({ repoRoot }),
    /has NO entry in the pnpm-workspace\.yaml/
  );
});

test('MUST THROW: a named-catalog reference is not modelled', async () => {
  const repoRoot = await writeCatalogFixture('catalog:legacy', '^1.61.1', {
    '.github/workflows/performance.yml': pinnedLine('1.61.1'),
    '.github/workflows/test.yml': pinnedLine('1.61.1'),
    '.github/workflows/web-e2e.yml': pinnedLine('1.61.1'),
  });

  assert.throws(() => checkPlaywrightPinSync({ repoRoot }), /named-catalog reference/);
});

test('a literal range never reads pnpm-workspace.yaml (fixtures without one still work)', async () => {
  // Lazy resolution is load-bearing: C2's original fixtures write only a
  // package.json. Reading the workspace file eagerly would ENOENT on all of them.
  const repoRoot = await writeFixture('^1.61.1', {
    '.github/workflows/performance.yml': pinnedLine('1.61.1'),
    '.github/workflows/test.yml': pinnedLine('1.61.1'),
    '.github/workflows/web-e2e.yml': pinnedLine('1.61.1'),
  });

  assert.equal(checkPlaywrightPinSync({ repoRoot }).expectedVersion, '1.61.1');
});

test('tolerates multiple identical pins in one file but flags disagreeing duplicates', async () => {
  const repoRoot = await writeFixture('^1.61.1', {
    '.github/workflows/performance.yml': pinnedLine('1.61.1'),
    '.github/workflows/test.yml': pinnedLine('1.61.1') + pinnedLine('1.61.1'), // web-e2e + smoke jobs, same pin
    '.github/workflows/web-e2e.yml': pinnedLine('1.61.1'),
  });

  const { mismatches } = checkPlaywrightPinSync({ repoRoot });
  assert.deepEqual(mismatches, []);
});

async function writeProvisioningFixture(
  spec = '1.63.0',
  driverSpec = spec,
  omit = '',
  edit = (content) => content
) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'web-chromium-pin-'));
  await writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({
      devDependencies: { '@playwright/test': spec, playwright: driverSpec },
    })
  );
  for (const [file, job] of [
    ['test.yml', 'web-e2e'],
    ['web-e2e.yml', 'web-full-regression'],
    ['performance.yml', 'web-perf'],
  ]) {
    const full = path.join(repoRoot, '.github/workflows', file);
    await mkdir(path.dirname(full), { recursive: true });
    const content = `jobs:
  ${job}:
    container:
      image: mcr.microsoft.com/playwright:v1.63.0-noble@sha256:${'a'.repeat(64)}
      options: --user 0
    steps:
      - uses: actions/setup-node@v6
        with:
          node-version-file: .nvmrc
      - name: Install web test system tools
        shell: bash
        run: |
          apt-get install -y --no-install-recommends unzip lsof procps
      - name: Provision qualified web Chromium
        shell: bash
        run: |
          BRAINSTRIKE_WEB_CHROMIUM_DIR="$RUNNER_TEMP/web-chromium"
          echo "BRAINSTRIKE_WEB_CHROMIUM_DIR=$BRAINSTRIKE_WEB_CHROMIUM_DIR" >> "$GITHUB_ENV"
          test "$(node --version)" = "v$(cat .nvmrc)"
          node scripts/provision-web-chromium.mjs "$BRAINSTRIKE_WEB_CHROMIUM_DIR"
      - name: Run web tests
        run: pnpm exec playwright test
`;
    await writeFile(full, edit(omit ? content.replace(omit, '') : content));
  }
  return repoRoot;
}

test('fixed Chromium jobs retain exact drivers and provision on the official base', async () => {
  checkWebChromiumProvisioning();
  checkWebChromiumProvisioning({ repoRoot: await writeProvisioningFixture() });
});

test('fixed Chromium jobs reject driver drift and missing provisioning requirements', async () => {
  for (const [spec, driver, message] of [
    ['^1.63.0', '1.63.0', /exact/],
    ['1.63.0', '1.62.0', /driver/],
    ['1.62.0', '1.62.0', /base/],
  ]) {
    const repoRoot = await writeProvisioningFixture(spec, driver);
    assert.throws(() => checkWebChromiumProvisioning({ repoRoot }), message);
  }
  for (const omitted of [
    `@sha256:${'a'.repeat(64)}`,
    'options: --user 0',
    'shell: bash',
    'node-version-file: .nvmrc',
    'BRAINSTRIKE_WEB_CHROMIUM_DIR="$RUNNER_TEMP/web-chromium"',
    'echo "BRAINSTRIKE_WEB_CHROMIUM_DIR=$BRAINSTRIKE_WEB_CHROMIUM_DIR" >> "$GITHUB_ENV"',
    'unzip lsof procps',
    'test "$(node --version)" = "v$(cat .nvmrc)"',
    'node scripts/provision-web-chromium.mjs',
  ]) {
    const repoRoot = await writeProvisioningFixture('1.63.0', '1.63.0', omitted);
    assert.throws(() => checkWebChromiumProvisioning({ repoRoot }), /base|provisioning|bash/);
  }
});

// BST-2066: `jobs.<id>.env` cannot read the `runner` context (GitHub's
// context-availability table), so a job-level `${{ runner.temp }}` makes the
// workflow invalid. The directory is exported from the provisioning step.
test('fixed Chromium jobs reject the job-level runner.temp export and an export outside provisioning', async () => {
  const jobLevel = await writeProvisioningFixture('1.63.0', '1.63.0', '', (content) =>
    content.replace(
      '    steps:\n',
      `    env:\n      BRAINSTRIKE_WEB_CHROMIUM_DIR: ${'$'}{{ runner.temp }}/web-chromium\n    steps:\n`
    )
  );
  assert.throws(
    () => checkWebChromiumProvisioning({ repoRoot: jobLevel }),
    /job-level env cannot read the runner context/
  );

  const misplaced = await writeProvisioningFixture('1.63.0', '1.63.0', '', (content) =>
    content
      .replace(
        '          echo "BRAINSTRIKE_WEB_CHROMIUM_DIR=$BRAINSTRIKE_WEB_CHROMIUM_DIR" >> "$GITHUB_ENV"\n',
        ''
      )
      .replace(
        '        run: pnpm exec playwright test\n',
        '        run: |\n          echo "BRAINSTRIKE_WEB_CHROMIUM_DIR=$BRAINSTRIKE_WEB_CHROMIUM_DIR" >> "$GITHUB_ENV"\n          pnpm exec playwright test\n'
      )
  );
  assert.throws(
    () => checkWebChromiumProvisioning({ repoRoot: misplaced }),
    /Provision qualified web Chromium step must export/
  );
});
