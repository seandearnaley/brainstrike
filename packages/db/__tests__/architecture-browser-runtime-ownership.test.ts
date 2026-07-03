import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DB_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(DB_PACKAGE_ROOT, '../..');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts']);
const SKIPPED_DIRECTORIES = new Set([
  '__tests__',
  '.turbo',
  'coverage',
  'dist',
  'fixtures',
  'mocks',
  'node_modules',
  'test-results',
]);
const TURSO_BROWSER_DB_CLIENT_IMPORT_PATTERN =
  /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s*)?['"](?<staticSpecifier>@tursodatabase\/(?:database|sync|serverless)|@libsql\/client(?:\/web)?)['"]|\bimport\s*\(\s*['"](?<dynamicSpecifier>@tursodatabase\/(?:database|sync|serverless)|@libsql\/client(?:\/web)?)['"]\s*\)/g;

const BROWSER_BUNDLE_ENTRYPOINTS = [
  'apps/web/src',
  'packages/db/src/browser-pglite-storage.ts',
  'packages/db/src/db-provider.tsx',
  'packages/db/src/index.ts',
  'packages/db/src/pglite-worker-entry.ts',
  'packages/db/src/wasm-loader.ts',
] as const;

const REQUIRED_LEDGER_PHRASES = [
  '## Browser Runtime Ownership Decision',
  'Current browser/client DB storage remains PGlite-backed by design',
  '@tursodatabase/database and @tursodatabase/sync are not browser-local storage replacements',
  '@tursodatabase/serverless is a remote fetch client, not a local-first browser database',
  'The final PGlite dependency-removal pass is blocked until browser-local storage has a supported Turso replacement or browser support is explicitly dropped',
] as const;

interface BrowserDbClientImport {
  readonly relativePath: string;
  readonly specifier: string;
}

function listSourceFiles(entrypoint: string): string[] {
  const absolutePath = path.join(REPO_ROOT, entrypoint);
  const stat = statSync(absolutePath);
  if (stat.isFile()) {
    return [absolutePath];
  }

  const files: string[] = [];
  for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
    const entryPath = path.join(absolutePath, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('coverage-')) {
        continue;
      }
      files.push(...listSourceFiles(path.relative(REPO_ROOT, entryPath)));
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
}

function normalizeRelativePath(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

function extractTursoBrowserDbClientImports(
  source: string,
  relativePath: string
): BrowserDbClientImport[] {
  const imports: BrowserDbClientImport[] = [];
  for (const match of source.matchAll(TURSO_BROWSER_DB_CLIENT_IMPORT_PATTERN)) {
    const specifier = match.groups?.['staticSpecifier'] ?? match.groups?.['dynamicSpecifier'];
    if (specifier) {
      imports.push({
        relativePath,
        specifier,
      });
    }
  }
  return imports;
}

function findTursoBrowserDbClientImports(): BrowserDbClientImport[] {
  const imports: BrowserDbClientImport[] = [];
  for (const entrypoint of BROWSER_BUNDLE_ENTRYPOINTS) {
    for (const filePath of listSourceFiles(entrypoint)) {
      const source = readFileSync(filePath, 'utf8');
      imports.push(...extractTursoBrowserDbClientImports(source, normalizeRelativePath(filePath)));
    }
  }
  return imports;
}

describe('browser runtime ownership guardrails', () => {
  it('documents the browser-local storage decision before final PGlite removal', () => {
    const ledger = readFileSync(
      path.join(REPO_ROOT, 'docs/turso-migration/migration-ledger.md'),
      'utf8'
    );

    for (const phrase of REQUIRED_LEDGER_PHRASES) {
      expect(ledger).toContain(phrase);
    }
  });

  it('keeps Turso and libSQL database clients out of browser DB bundle entrypoints', () => {
    expect(findTursoBrowserDbClientImports()).toEqual([]);
  });

  it('detects Turso and libSQL clients re-exported from browser-facing barrels', () => {
    expect(
      extractTursoBrowserDbClientImports(
        "export { createClient } from '@libsql/client/web';",
        'packages/db/src/index.ts'
      )
    ).toEqual([
      {
        relativePath: 'packages/db/src/index.ts',
        specifier: '@libsql/client/web',
      },
    ]);
  });
});
