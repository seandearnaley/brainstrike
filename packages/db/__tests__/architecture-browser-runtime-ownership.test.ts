import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
const LOCAL_STATIC_SPECIFIER_PATTERN =
  /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s*)?['"](?<specifier>\.{1,2}\/[^'"]+)['"]/g;

const BROWSER_BUNDLE_ENTRYPOINTS = [
  'apps/web/src/main.tsx',
  'apps/web/src/workers',
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

type SourceReader = (absolutePath: string) => string;

function listSourceFiles(entrypoint: string): string[] {
  const absolutePath = path.join(REPO_ROOT, entrypoint);
  expect(
    existsSync(absolutePath),
    `${entrypoint} must exist; update BROWSER_BUNDLE_ENTRYPOINTS if the browser DB entry surface changes`
  ).toBe(true);

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

function extractLocalStaticSpecifiers(source: string): string[] {
  return Array.from(source.matchAll(LOCAL_STATIC_SPECIFIER_PATTERN), (match) => {
    const specifier = match.groups?.['specifier'];
    expect(specifier, 'local static import/export regex must capture a specifier').toBeTruthy();
    return specifier as string;
  });
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

function resolveLocalSourceSpecifier(fromFilePath: string, specifier: string): string | null {
  const basePath = path.resolve(path.dirname(fromFilePath), specifier);
  const candidates = path.extname(basePath)
    ? [
        basePath,
        basePath.replace(/\.(?:js|mjs)$/, '.ts'),
        basePath.replace(/\.(?:js|mjs)$/, '.tsx'),
        basePath.replace(/\.(?:js|mjs)$/, '.mts'),
      ]
    : [
        ...Array.from(SOURCE_EXTENSIONS, (extension) => `${basePath}${extension}`),
        ...Array.from(SOURCE_EXTENSIONS, (extension) => path.join(basePath, `index${extension}`)),
      ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function findTursoBrowserDbClientImportsFromFiles(
  entryFiles: readonly string[],
  readSource: SourceReader = (absolutePath) => readFileSync(absolutePath, 'utf8')
): BrowserDbClientImport[] {
  const imports: BrowserDbClientImport[] = [];
  const pending = [...entryFiles];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const filePath = pending.shift();
    expect(filePath, 'pending browser scan file path must be defined').toBeTruthy();
    const absolutePath = filePath as string;
    if (visited.has(absolutePath)) {
      continue;
    }
    visited.add(absolutePath);

    const source = readSource(absolutePath);
    imports.push(
      ...extractTursoBrowserDbClientImports(source, normalizeRelativePath(absolutePath))
    );

    for (const specifier of extractLocalStaticSpecifiers(source)) {
      const resolvedPath = resolveLocalSourceSpecifier(absolutePath, specifier);
      if (resolvedPath) {
        pending.push(resolvedPath);
      }
    }
  }

  return imports;
}

function findTursoBrowserDbClientImports(): BrowserDbClientImport[] {
  // This is a deliberate browser entrypoint allowlist: add new browser DB
  // entrypoints here when the runtime surface changes. Server-only web code
  // belongs outside this list because it may legitimately use Turso directly.
  return findTursoBrowserDbClientImportsFromFiles(
    BROWSER_BUNDLE_ENTRYPOINTS.flatMap(listSourceFiles)
  );
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

  it('follows local re-exports from browser-facing barrels', () => {
    const barrelPath = path.join(REPO_ROOT, 'packages/db/src/index.ts');
    const localModulePath = path.join(REPO_ROOT, 'packages/db/src/turso/owner-client.ts');
    const sources = new Map([
      [barrelPath, "export * from './turso/owner-client.js';"],
      [localModulePath, "import { connect } from '@tursodatabase/database';"],
    ]);

    expect(
      findTursoBrowserDbClientImportsFromFiles([barrelPath], (absolutePath) => {
        const source = sources.get(absolutePath);
        expect(
          source,
          `test source missing for ${normalizeRelativePath(absolutePath)}`
        ).toBeTruthy();
        return source as string;
      })
    ).toEqual([
      {
        relativePath: 'packages/db/src/turso/owner-client.ts',
        specifier: '@tursodatabase/database',
      },
    ]);
  });
});
