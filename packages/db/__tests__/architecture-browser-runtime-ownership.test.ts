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
  /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s*)?['"](?<staticSpecifier>@tursodatabase\/(?:database(?:-wasm)?(?:\/(?:vite|bundle|turbopack))?|sync|serverless)|@libsql\/client(?:\/web)?)['"]|\bimport\s*\(\s*['"](?<dynamicSpecifier>@tursodatabase\/(?:database(?:-wasm)?(?:\/(?:vite|bundle|turbopack))?|sync|serverless)|@libsql\/client(?:\/web)?)['"]\s*\)/g;
const LOCAL_STATIC_SPECIFIER_PATTERN =
  /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s*)?['"](?<specifier>\.{1,2}\/[^'"]+)['"]/g;

const BROWSER_BUNDLE_ENTRYPOINTS = [
  'apps/web/src/main.tsx',
  'apps/web/src/workers',
  'packages/db/src/browser-pglite-storage.ts',
  'packages/db/src/db-provider.tsx',
  'packages/db/src/index.ts',
  'packages/db/src/pglite-worker-entry.ts',
  'packages/db/src/turso/browser-wasm-client.ts',
  'packages/db/src/wasm-loader.ts',
] as const;

const REQUIRED_LEDGER_PHRASES = [
  '## Browser Runtime Ownership Decision',
  'Current browser/client DB storage is entering a staged Turso WASM migration',
  '`@tursodatabase/database-wasm` is the only approved browser-local Turso database package',
  '`@tursodatabase/database-wasm/vite` is the Vite/browser import surface',
  '@tursodatabase/serverless is a remote fetch client, not a local-first browser database',
  'Browser PGlite remains only until the WASM runtime has bootstrap readiness, reset/backup ownership, and runtime parity tests',
] as const;

const REJECTED_LEDGER_PHRASES = [
  'The current official Turso TypeScript docs do not provide an equivalent browser-local embedded database surface',
  'The final PGlite dependency-removal pass is blocked until browser-local storage has a supported Turso replacement or browser support is explicitly dropped',
] as const;

const APPROVED_TURSO_BROWSER_DB_CLIENT_IMPORTS = new Map<string, readonly string[]>([
  ['packages/db/src/turso/browser-wasm-client.ts', ['@tursodatabase/database-wasm/vite']],
]);
const REQUIRED_CROSS_ORIGIN_HEADERS = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
} as const;

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

function uniqueBrowserDbClientImports(
  imports: readonly BrowserDbClientImport[]
): BrowserDbClientImport[] {
  const seen = new Set<string>();
  return imports.filter((entry) => {
    const key = `${entry.relativePath}\0${entry.specifier}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function findTursoBrowserDbClientImports(): BrowserDbClientImport[] {
  // This is a deliberate browser entrypoint allowlist: add new browser DB
  // entrypoints here when the runtime surface changes. Server-only web code
  // belongs outside this list because it may legitimately use Turso directly.
  return uniqueBrowserDbClientImports(
    findTursoBrowserDbClientImportsFromFiles(BROWSER_BUNDLE_ENTRYPOINTS.flatMap(listSourceFiles))
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
    for (const phrase of REJECTED_LEDGER_PHRASES) {
      expect(ledger).not.toContain(phrase);
    }
  });

  it('pins the Turso browser WASM package in the DB package dependency graph', () => {
    const dbPackage = JSON.parse(
      readFileSync(path.join(DB_PACKAGE_ROOT, 'package.json'), 'utf8')
    ) as {
      readonly dependencies?: Record<string, string>;
    };

    expect(dbPackage.dependencies?.['@tursodatabase/database']).toBe('^0.6.1');
    expect(dbPackage.dependencies?.['@tursodatabase/database-wasm']).toBe('^0.6.1');
  });

  it('keeps root AGENTS embedding-host storage wording aligned with runtime ownership', () => {
    const agents = readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8');

    expect(agents).not.toMatch(
      /Hidden host renderer[\s\S]*It pulls jobs from the PGlite-backed `job_queue`\./
    );
    expect(agents).toContain('The hidden host selects runtime-specific embedding worker storage.');
    expect(agents).toContain('Desktop Turso queue mutations go through DB-host owner IPC/actions.');
  });

  it('allows only the owned Turso WASM client seam in browser DB bundle entrypoints', () => {
    expect(findTursoBrowserDbClientImports()).toEqual(
      [...APPROVED_TURSO_BROWSER_DB_CLIENT_IMPORTS.entries()].map(([relativePath, specifiers]) => ({
        relativePath,
        specifier: specifiers[0],
      }))
    );
  });

  it('detects non-WASM Turso and libSQL clients re-exported from browser-facing barrels', () => {
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

  it('classifies approved browser WASM imports separately from rejected Turso clients', () => {
    expect(
      extractTursoBrowserDbClientImports(
        "import { connect } from '@tursodatabase/database-wasm/vite';",
        'packages/db/src/turso/browser-wasm-client.ts'
      )
    ).toEqual([
      {
        relativePath: 'packages/db/src/turso/browser-wasm-client.ts',
        specifier: '@tursodatabase/database-wasm/vite',
      },
    ]);
  });

  it('keeps web dev preview and Vercel responses cross-origin isolated for browser WASM', () => {
    const viteConfig = readFileSync(path.join(REPO_ROOT, 'apps/web/vite.config.mts'), 'utf8');
    const vercelConfig = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'apps/web/vercel.json'), 'utf8')
    ) as {
      readonly headers?: Array<{
        readonly headers?: Array<{ readonly key?: string; readonly value?: string }>;
        readonly source?: string;
      }>;
    };

    for (const [header, value] of Object.entries(REQUIRED_CROSS_ORIGIN_HEADERS)) {
      expect(viteConfig).toMatch(
        new RegExp(
          `server:\\s*{[\\s\\S]*headers:\\s*{[\\s\\S]*['"]${header}['"]:\\s*['"]${value}['"]`
        )
      );
      expect(viteConfig).toMatch(
        new RegExp(
          `preview:\\s*{[\\s\\S]*headers:\\s*{[\\s\\S]*['"]${header}['"]:\\s*['"]${value}['"]`
        )
      );
    }

    const allRouteHeaders = vercelConfig.headers?.find((entry) => entry.source === '/(.*)');
    expect(allRouteHeaders, 'apps/web/vercel.json must define all-route headers').toBeTruthy();
    const productionHeaders = new Map(
      allRouteHeaders?.headers?.map((entry) => [entry.key, entry.value]) ?? []
    );
    expect(Object.fromEntries(productionHeaders)).toMatchObject(REQUIRED_CROSS_ORIGIN_HEADERS);
  });

  it('keeps Turso browser WASM packages out of Vite dependency prebundling', () => {
    const viteConfig = readFileSync(path.join(REPO_ROOT, 'apps/web/vite.config.mts'), 'utf8');

    expect(viteConfig).toMatch(
      /optimizeDeps:\s*{[\s\S]*exclude:\s*\[[\s\S]*['"]@tursodatabase\/database-wasm['"]/
    );
    expect(viteConfig).toMatch(
      /optimizeDeps:\s*{[\s\S]*exclude:\s*\[[\s\S]*['"]@tursodatabase\/database-wasm-common['"]/
    );
  });
});
