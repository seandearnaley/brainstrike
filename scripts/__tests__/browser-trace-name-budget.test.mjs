import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Vitest browser mode copies each Playwright trace into `.vitest-attachments`
 * under a single flattened basename:
 *
 *   sanitizeFilePath(<package-relative trace path>) + '-' + sha1(40) + '.zip'
 *
 * Nothing upstream bounds it, so a long test name overflows the 255-byte
 * filesystem limit and the failed copy masks the real test failure
 * (vitest-dev/vitest#9168; observed on PR #2296 at 259 bytes).
 *
 * @brainstrike/config bounds the chunk name to MAX_TRACE_CHUNK_NAME_BYTES, but
 * that constant only buys headroom for the DIRECTORY PREFIX — a deeper test
 * directory or a longer test filename spends it back, silently. These two
 * guards keep both halves honest against the real tree:
 *
 *   1. every browser project that captures traces routes its provider through
 *      the bounding wrapper (packages/db and packages/storage build their own
 *      `playwright()` provider and were unprotected until PR #2306), and
 *   2. the worst-case bounded basename over every real browser test file
 *      still fits in 255 bytes.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FILENAME_LIMIT_BYTES = 255;

/** vitest's sanitizeFilePath (packages/vitest/src/utils/index.ts). */
function sanitizeFilePath(value) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: mirrors vitest verbatim
  return value.replace(/[\x00-\x2C\x2E\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g, '-');
}

function readMaxTraceChunkNameBytes() {
  const source = readFileSync(
    path.join(repoRoot, 'packages', 'config', 'src', 'vitest-browser.ts'),
    'utf8'
  );
  const match = source.match(/export const MAX_TRACE_CHUNK_NAME_BYTES = (\d+);/);
  assert.ok(match, 'MAX_TRACE_CHUNK_NAME_BYTES not found in @brainstrike/config vitest-browser.ts');
  return Number(match[1]);
}

function findBrowserTestFiles(packageDir) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Generated artifact directories mirror test filenames; skip them.
        if (['node_modules', 'dist', '__screenshots__', '__traces__'].includes(entry.name)) {
          continue;
        }
        walk(full);
        continue;
      }
      if (/\.browser\.test\.(ts|tsx)$/.test(entry.name)) {
        found.push(path.relative(packageDir, full));
      }
    }
  };
  walk(packageDir);
  return found;
}

function packagesWithBrowserProjects() {
  const base = path.join(repoRoot, 'packages');
  const found = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const configPath = path.join(base, entry.name, 'vitest.config.mts');
    let config;
    try {
      config = readFileSync(configPath, 'utf8');
    } catch {
      continue;
    }
    // Either the shared helper, or a hand-rolled `browser: { ... }` project.
    if (!(config.includes('createBrowserProject') || config.includes('browser: {'))) {
      continue;
    }
    found.push({ config, configPath, dir: path.join(base, entry.name), name: entry.name });
  }
  return found;
}

/**
 * Worst-case attachment basename for a test file: the longest chunk name the
 * bounding allows, in the deepest project/browser naming vitest produces.
 */
function worstCaseAttachmentBytes(relativeTestPath, maxChunkBytes) {
  const dir = path.dirname(relativeTestPath);
  const base = path.basename(relativeTestPath);
  // project.name is `<name> (<browser>)`, sanitized by the provider.
  const project = 'browser (chromium)'.replace(/[^a-z0-9]/gi, '-');
  const chunk = 'a'.repeat(maxChunkBytes);
  const tracePath = path.join(dir, '__traces__', base, `${project}-${chunk}.trace.zip`);
  return Buffer.byteLength(`${sanitizeFilePath(tracePath)}-${'0'.repeat(40)}.zip`, 'utf8');
}

test('every browser project capturing traces routes through the bounding wrapper', () => {
  const projects = packagesWithBrowserProjects();
  assert.ok(
    projects.length >= 5,
    `expected the known browser-mode packages, found ${projects.length}`
  );

  for (const project of projects) {
    if (!project.config.includes('trace')) {
      continue;
    }
    const where = path.relative(repoRoot, project.configPath);
    // Check the `provider:` expression itself, not just that the wrapper is
    // named somewhere in the file — an unused import must not satisfy this.
    const providers = [...project.config.matchAll(/provider:\s*(\w+)\(/g)].map((match) => match[1]);

    if (providers.length === 0) {
      assert.ok(
        project.config.includes('createBrowserProject'),
        `${where} captures Playwright traces but neither builds a provider nor uses createBrowserProject — trace chunk names would be unbounded.`
      );
      continue;
    }

    for (const provider of providers) {
      assert.equal(
        provider,
        'withBoundedTraceChunkNames',
        `${where} builds its Playwright provider with \`${provider}(\` instead of wrapping it in withBoundedTraceChunkNames — long test names will overflow the ${FILENAME_LIMIT_BYTES}-byte attachment filename, and the ENAMETOOLONG masks the real test failure.`
      );
    }
  }
});

test('worst-case bounded trace attachment basename fits the filesystem limit', () => {
  const maxChunkBytes = readMaxTraceChunkNameBytes();
  const offenders = [];
  let checked = 0;

  for (const project of packagesWithBrowserProjects()) {
    for (const testFile of findBrowserTestFiles(project.dir)) {
      checked += 1;
      const bytes = worstCaseAttachmentBytes(testFile, maxChunkBytes);
      if (bytes > FILENAME_LIMIT_BYTES) {
        offenders.push(`${project.name}/${testFile} → ${bytes} bytes`);
      }
    }
  }

  assert.ok(checked >= 10, `expected the repo's browser tests to be discovered, found ${checked}`);
  assert.deepEqual(
    offenders,
    [],
    `These browser test files sit too deep for MAX_TRACE_CHUNK_NAME_BYTES=${maxChunkBytes}: their trace attachment basename can exceed ${FILENAME_LIMIT_BYTES} bytes and fail the copy with ENAMETOOLONG. Shorten the path/filename or lower the constant.\n${offenders.join('\n')}`
  );
});
